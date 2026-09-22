// Optional persistent decision ledger, shared by every host.
//
// This module is runtime-neutral: Web Crypto and TextEncoder only, no `node:`
// imports, so it bundles for Workers as well as Node. Storage is injected as a
// DecisionStore, so the key protocol, the configuration revision, the request
// and response header policy, replay validation, coalescing and the hook order
// are IDENTICAL on every host and only the place decisions live differs.
//
// Byte-for-byte interoperability with the Go router is a requirement, not a
// convenience: a ledger written by one implementation must be replayed by the
// other from the same keys. Every framing and JSON detail below mirrors
// cache.go and the struct tags in main.go deliberately.
import { compareIDs, object, parseJSON, raw, replaceFields, validationView } from './codec.js';
import type { JsonObject } from './codec.js';
import type { Backend, BackendLimits, GatewayConfig } from './config.js';
import { APIError, BODY_LIMIT, answersMatch } from './transport.js';
import { validateResponse } from './generated/validators.js';

// Bump when routing, adapter semantics, or the cache entry contract changes.
// Must equal decisionRevision in cache.go.
export const DECISION_REVISION = 'one-system-routing-v2';
export const ZERO_USAGE = '{"input_tokens":0,"output_tokens":0}';
export const CACHE_HEADER = 'X-One-System-Cache';
const encoder = new TextEncoder();
const MILLISECOND = 1_000_000n;
const MAX_TTL = 365n * 24n * 3600n * 1_000_000_000n;
const MAX_BYTES_LIMIT = 1n << 40n;
const INT64_MAX = (1n << 63n) - 1n;

export type CacheMode = 'off' | 'readwrite' | 'replay';

export interface CacheSettings {
  readonly mode: CacheMode;
  readonly path: string;
  readonly namespace: string;
  readonly epoch: string;
  readonly ttlMilliseconds: number;
  readonly maxBytes: bigint;
}

/** Digests of the pinned public contract artifacts, precomputed at build time. */
export interface AssetDigests {
  readonly openAPI: string;
  readonly selectorQuestion: string;
}

/**
 * Storage only: durability, expiry and a byte budget. Every implementation
 * must behave identically for these operations, because the shared policy
 * above it assumes nothing else.
 */
export interface DecisionStore {
  /**
   * The stored decision, or undefined when absent or expired at
   * nowMilliseconds. A store that cannot answer must throw rather than
   * report a miss, so the policy above can report a cache error.
   */
  get(key: string, nowMilliseconds: number): Promise<Uint8Array | undefined>;
  /**
   * Store a decision until expiresMilliseconds, dropping already expired
   * entries and then the oldest-written entries until the byte budget holds.
   * A single response larger than the budget is silently not stored, because
   * refusing one oversized response must not evict useful entries.
   */
  put(key: string, body: Uint8Array, nowMilliseconds: number, expiresMilliseconds: number): Promise<void>;
  close(): Promise<void>;
}

// --- Go-compatible JSON fragments -------------------------------------------
// Parts of the configuration revision are JSON. They must match Go's
// encoding/json output byte for byte: declaration field order, no omitempty on
// limits, omitempty on optional capability members, HTML escaping, and ES6
// number formatting. JSON.stringify differs in enough places to be unsafe here.

/** encoding/json string encoding, including its HTML and U+2028/9 escapes. */
export function goString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === '"') out += '\\"';
    else if (character === '\\') out += '\\\\';
    else if (character === '\n') out += '\\n';
    else if (character === '\r') out += '\\r';
    else if (character === '\t') out += '\\t';
    else if (code < 0x20 || character === '<' || character === '>' || character === '&') {
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else if (code === 0x2028 || code === 0x2029) out += '\\u' + code.toString(16);
    // Go writes the escape text for bytes that are not valid UTF-8; a JS string
    // can only carry that case as an unpaired surrogate.
    else if (code >= 0xd800 && code <= 0xdfff) out += '\\ufffd';
    else out += character;
  }
  return out + '"';
}

/** encoding/json float64 encoding. String() already matches it except for -0. */
export function goFloat(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Revision floats must be finite');
  return Object.is(value, -0) ? '-0' : String(value);
}

function optionalInteger(value: bigint | undefined): string {
  return value === undefined ? 'null' : String(value);
}

/** Go marshals *limits with every member present; an unset member is null. */
export function limitsJSON(limits: BackendLimits | undefined): string {
  if (limits === undefined) return 'null';
  return '{"max_characters":' + optionalInteger(limits.maxCharacters) +
    ',"max_non_ascii_letter_fraction":' + (limits.maxNonASCIILetterFraction === undefined ? 'null' : goFloat(limits.maxNonASCIILetterFraction)) +
    ',"max_questions":' + optionalInteger(limits.maxQuestions) +
    ',"max_criteria":' + optionalInteger(limits.maxCriteria) + '}';
}

/** Go marshals *capabilities omitting unset optional members; see config.ts. */
export function capabilitiesJSON(backend: Backend): string {
  return backend.capabilities?.json ?? 'null';
}

// --- Hashing -----------------------------------------------------------------

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as unknown as ArrayBufferView<ArrayBuffer>));
  let out = '';
  for (const byte of digest) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function digestText(value: string): Promise<string> {
  return sha256Hex(encoder.encode(value));
}

/**
 * SHA-256 of an ASCII domain followed by length-framed byte strings. Lengths
 * are BYTE counts as unsigned 64-bit big-endian, never string lengths.
 */
export async function framedDigest(domain: string, parts: readonly Uint8Array[]): Promise<string> {
  const prefix = encoder.encode(domain);
  let total = prefix.byteLength;
  for (const part of parts) total += 8 + part.byteLength;
  const buffer = new Uint8Array(total);
  const view = new DataView(buffer.buffer);
  buffer.set(prefix, 0);
  let at = prefix.byteLength;
  for (const part of parts) {
    view.setBigUint64(at, BigInt(part.byteLength));
    at += 8;
    buffer.set(part, at);
    at += part.byteLength;
  }
  return sha256Hex(buffer);
}

/**
 * Cross-runtime key format: namespace and revision are UTF-8; request is the
 * EXACT received body bytes, never reserialized JSON, so that differing number
 * lexemes or key order safely miss rather than collide.
 */
export function decisionKey(namespace: string, revision: string, request: Uint8Array): Promise<string> {
  return framedDigest('one-system-decision-v1\0', [encoder.encode(namespace), encoder.encode(revision), request]);
}

/**
 * Fixed fields, then the task-selection policy, then nine fields per backend
 * sorted by registry ID. Every setting that changes which backend answers, or
 * whether a request is accepted, belongs here: a decision replayed under
 * different routing is wrong even though it was once valid. Mirrors
 * configurationRevision in cache.go. Shared revision vectors in cache.test.ts
 * guard against partitioning interoperable stores with different host keys.
 */
export async function configurationRevision(config: GatewayConfig, epoch: string, digests: AssetDigests): Promise<string> {
  const utf8 = (value: string) => encoder.encode(value);
  const parts: Uint8Array[] = [
    utf8(DECISION_REVISION), utf8(digests.openAPI), utf8(digests.selectorQuestion), utf8(epoch),
    utf8(config.name), utf8(config.selector), utf8(config.fallback), utf8(goFloat(config.escalationConfidence)),
    utf8(await digestText(config.publicKey)),
  ];
  const selection = config.selection;
  if (selection === undefined) parts.push(utf8('selection:none'));
  else {
    const ids = Array.from(selection.questions.fields.keys()).sort(compareIDs);
    const rules = '[' + selection.rules.map(rule =>
      '{"question":' + goString(rule.question) + ',"choice":' + goString(rule.choice) +
      ',"above":' + goFloat(rule.above) + '}').join(',') + ']';
    parts.push(utf8('selection:rules'), utf8(selection.escalateTo), utf8(rules), utf8(String(ids.length)));
    for (const id of ids) parts.push(utf8(id), utf8(raw(selection.questions.fields.get(id)!)));
  }
  for (const id of Array.from(config.backends.keys()).sort(compareIDs)) {
    const backend = config.backends.get(id)!;
    parts.push(utf8(id), utf8(backend.id), utf8(backend.baseURL), utf8(backend.model),
      utf8(backend.apiKeyEnv), utf8(backend.description), utf8(limitsJSON(backend.limits)),
      utf8(capabilitiesJSON(backend)), utf8(await digestText(backend.key)));
  }
  return framedDigest('one-system-config-v2\0', parts);
}


// --- Settings ----------------------------------------------------------------

const UNIT_NANOSECONDS = new Map<string, bigint>([
  ['ns', 1n], ['us', 1_000n], ['µs', 1_000n], ['μs', 1_000n],
  ['ms', 1_000_000n], ['s', 1_000_000_000n], ['m', 60_000_000_000n], ['h', 3_600_000_000_000n],
]);

/**
 * time.ParseDuration, ported rather than approximated so an operator's TTL
 * means the same thing on both implementations. Returns nanoseconds.
 */
export function parseGoDuration(input: string): bigint {
  const TWO63 = 1n << 63n;
  const invalid = (): never => { throw new Error('Invalid duration'); };
  let s = input;
  let negative = false;
  if (s.startsWith('-') || s.startsWith('+')) {
    negative = s.startsWith('-');
    s = s.slice(1);
  }
  // A leading zero on its own is a special case: "0" is a valid duration.
  if (s === '0') return 0n;
  if (s === '') invalid();
  let total = 0n;
  while (s !== '') {
    if (!(s[0] === '.' || (s[0]! >= '0' && s[0]! <= '9'))) invalid();
    const integerDigits = /^[0-9]*/.exec(s)![0];
    let value = integerDigits === '' ? 0n : BigInt(integerDigits);
    if (value > INT64_MAX) invalid();
    s = s.slice(integerDigits.length);
    // leadingFraction discards digits once the coefficient overflows, and
    // stops scaling with them, so the remainder cannot change the result.
    let fraction = 0n;
    let scale = 1;
    let post = false;
    if (s.startsWith('.')) {
      s = s.slice(1);
      const fractionDigits = /^[0-9]*/.exec(s)![0];
      post = fractionDigits.length > 0;
      for (const digit of fractionDigits) {
        if (fraction > INT64_MAX / 10n) break;
        const next = fraction * 10n + BigInt(digit);
        if (next > INT64_MAX) break;
        fraction = next;
        scale *= 10;
      }
      s = s.slice(fractionDigits.length);
    }
    if (integerDigits === '' && !post) invalid();
    const unitLength = /^[^.0-9]*/.exec(s)![0].length;
    if (unitLength === 0) invalid();
    const unit = UNIT_NANOSECONDS.get(s.slice(0, unitLength));
    if (unit === undefined) return invalid();
    s = s.slice(unitLength);
    if (value > TWO63 / unit) invalid();
    value *= unit;
    if (fraction > 0n) {
      // Go's exact expression, including its float64 rounding and truncation.
      value += BigInt(Math.trunc(Number(fraction) * (Number(unit) / scale)));
      if (value > TWO63) invalid();
    }
    total += value;
    if (total > TWO63) invalid();
  }
  if (!negative && total > INT64_MAX) invalid();
  return negative ? -total : total;
}

/** Decimal int64, matching strconv.ParseInt(value, 10, 64). */
export function parseGoInt64(input: string): bigint {
  if (!/^[+-]?[0-9]+$/.test(input)) throw new Error('Not an integer');
  const value = BigInt(input);
  if (value > INT64_MAX || value < -INT64_MAX - 1n) throw new Error('Integer exceeds int64');
  return value;
}

export interface CacheSettingsSource {
  /** ONE_SYSTEM_CACHE_* values: process environment, or Worker bindings. */
  readonly value: (name: string) => string | undefined;
  /** A path on a filesystem host, or a bound database elsewhere. */
  readonly storageConfigured: boolean;
}

/**
 * Mirrors loadCacheSettings in cache.go. Reading the environment stays in the
 * host module, exactly as loadConfig never touches process or files.
 */
export function loadCacheSettings(source: CacheSettingsSource): CacheSettings {
  const read = (name: string) => source.value(name) ?? '';
  const path = read('ONE_SYSTEM_CACHE_PATH');
  let mode = read('ONE_SYSTEM_CACHE_MODE');
  if (mode === '') mode = source.storageConfigured ? 'readwrite' : 'off';
  let ttl = 3_600_000_000_000n;
  const ttlText = read('ONE_SYSTEM_CACHE_TTL');
  if (ttlText !== '') {
    try { ttl = parseGoDuration(ttlText); } catch { throw new Error('ONE_SYSTEM_CACHE_TTL must be a duration'); }
  }
  let maxBytes = 64n << 20n;
  const maxBytesText = read('ONE_SYSTEM_CACHE_MAX_BYTES');
  if (maxBytesText !== '') {
    try { maxBytes = parseGoInt64(maxBytesText); } catch { throw new Error('ONE_SYSTEM_CACHE_MAX_BYTES must be an integer'); }
  }
  const settings: CacheSettings = {
    mode: mode as CacheMode, path, namespace: source.value('ONE_SYSTEM_CACHE_NAMESPACE') || 'default',
    epoch: read('ONE_SYSTEM_CACHE_EPOCH'), ttlMilliseconds: Number(ttl / MILLISECOND), maxBytes,
  };
  validateCacheSettings(settings, source.storageConfigured, ttl);
  return settings;
}

export function validateCacheSettings(settings: CacheSettings, storageConfigured: boolean, ttlNanoseconds: bigint): void {
  if (settings.mode === 'off') return;
  if (settings.mode !== 'readwrite' && settings.mode !== 'replay') {
    throw new Error('ONE_SYSTEM_CACHE_MODE must be off, readwrite, or replay');
  }
  if (!storageConfigured || settings.namespace.trim() === '' || settings.epoch.trim() === '') {
    throw new Error('an enabled cache requires storage, a namespace, and an explicit ONE_SYSTEM_CACHE_EPOCH');
  }
  if (ttlNanoseconds < MILLISECOND || ttlNanoseconds > MAX_TTL || settings.maxBytes < 1n || settings.maxBytes > MAX_BYTES_LIMIT) {
    throw new Error('cache TTL must be 1ms through 365d and max bytes must be 1 through 1099511627776');
  }
}

// --- Request policy ----------------------------------------------------------

export interface CacheOutcome {
  /** A complete response body to return: a replayed decision. */
  readonly replay?: string;
  /** Write key for a later remember(); blank means do not persist. */
  readonly key: string;
  readonly release: () => void;
}

export class DecisionCache {
  private readonly pending = new Map<string, Promise<void>>();
  readonly revision: Promise<string>;

  constructor(
    readonly settings: CacheSettings,
    private readonly store: DecisionStore,
    revision: Promise<string>,
    private readonly now: () => number = Date.now,
  ) {
    this.revision = revision;
  }

  close(): Promise<void> { return this.store.close(); }

  /**
   * Consult the ledger. Callers invoke this only after every rejection that
   * needs no inference, so acceptance is decided by the running code and never
   * by a stored entry. Throws APIError for a rejection; the caller has already
   * recorded any header this returned.
   */
  async begin(
    request: Request, body: Uint8Array, questions: JsonObject, signal: AbortSignal,
    responseHeaders: Record<string, string>,
  ): Promise<CacheOutcome> {
    // A rejected or canceled cache request carries no cache status, matching a
    // Go router that answers before it has one.
    const requested = request.headers.get(CACHE_HEADER) ?? '';
    if (requested !== '' && requested !== 'bypass' && requested !== 'replay') {
      throw new APIError(422, 'invalid_cache_mode', 'X-One-System-Cache must be bypass or replay');
    }
    const replay = requested === 'replay' || this.settings.mode === 'replay';
    if (requested === 'bypass') {
      if (replay) throw new APIError(422, 'invalid_cache_mode', 'Bypass is unavailable in replay-only mode');
      responseHeaders[CACHE_HEADER] = 'bypass';
      return { key: '', release: () => {} };
    }
    const key = await decisionKey(this.settings.namespace, await this.revision, body);
    let release = () => {};
    if (!replay) {
      try { release = await this.acquire(key, signal); } catch {
        throw new APIError(503, 'request_canceled', 'Request ended while awaiting a decision');
      }
    }
    let failed = false;
    try {
      const stored = await this.store.get(key, this.now());
      if (stored !== undefined) {
        const replayed = this.validateStored(stored, questions);
        if (replayed !== undefined) {
          responseHeaders[CACHE_HEADER] = 'hit';
          return { key: '', release, replay: replayed };
        }
        failed = true;
      }
    } catch {
      // Never surface a storage error or cached content: either may hold data.
      failed = true;
    }
    responseHeaders[CACHE_HEADER] = failed ? 'error' : 'miss';
    if (failed && replay) {
      release();
      throw new APIError(503, 'cache_unavailable', 'Cached decision could not be read or validated');
    }
    if (replay) {
      release();
      throw new APIError(404, 'cache_miss', 'No unexpired decision exists for this exact request');
    }
    return { key, release };
  }

  /** A stored decision is only usable when it still answers THIS request. */
  private validateStored(stored: Uint8Array, questions: JsonObject): string | undefined {
    if (stored.byteLength > BODY_LIMIT) return undefined;
    try {
      const body = object(parseJSON(new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(stored)));
      if (!validateResponse(validationView(body))) return undefined;
      if (!answersMatch(questions, object(body.fields.get('answers')))) return undefined;
      return replaceFields(body, new Map([['usage', ZERO_USAGE]]));
    } catch { return undefined; }
  }

  /**
   * Hold per-key ownership only, never a storage transaction, during
   * inference. Followers re-read after the leader releases. A canceled
   * follower does not cancel the leader; a failed write permits a later retry.
   * Coalescing is per process, or per isolate on a serverless host.
   */
  private async acquire(key: string, signal: AbortSignal): Promise<() => void> {
    for (;;) {
      signal.throwIfAborted();
      const existing = this.pending.get(key);
      if (existing === undefined) break;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        void existing.then(() => { signal.removeEventListener('abort', abort); resolve(); },
          () => { signal.removeEventListener('abort', abort); resolve(); });
      });
    }
    let release!: () => void;
    const done = new Promise<void>(resolve => {
      release = () => {
        if (this.pending.get(key) === done) this.pending.delete(key);
        resolve();
      };
    });
    this.pending.set(key, done);
    return release;
  }

  /**
   * The caller keeps its own validated response; only the persisted copy loses
   * the original inference usage, so a replay never reports tokens twice.
   */
  async remember(key: string, response: JsonObject): Promise<void> {
    if (key === '') return;
    const stored = encoder.encode(replaceFields(response, new Map([['usage', ZERO_USAGE]])));
    const now = this.now();
    // A storage failure must never fail a successful inference response.
    try { await this.store.put(key, stored, now, now + this.settings.ttlMilliseconds); } catch { /* retried later */ }
  }
}

/** Shared plumbing for filesystem and bound-database stores. */
export function decisionSchema(): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS decisions (
			key TEXT PRIMARY KEY NOT NULL,
			response BLOB NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			response_size INTEGER NOT NULL CHECK (response_size = length(response) AND response_size > 0)
		) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS decisions_expiry ON decisions(expires_at)',
    'CREATE INDEX IF NOT EXISTS decisions_age ON decisions(created_at, key)',
    'CREATE TABLE IF NOT EXISTS decision_bytes (id INTEGER PRIMARY KEY CHECK (id = 1), size INTEGER NOT NULL CHECK (size >= 0))',
    'INSERT OR IGNORE INTO decision_bytes VALUES (1, 0)',
    `CREATE TRIGGER IF NOT EXISTS decisions_insert AFTER INSERT ON decisions BEGIN
			UPDATE decision_bytes SET size = size + new.response_size WHERE id = 1;
		END`,
    `CREATE TRIGGER IF NOT EXISTS decisions_delete AFTER DELETE ON decisions BEGIN
			UPDATE decision_bytes SET size = size - old.response_size WHERE id = 1;
		END`,
    `CREATE TRIGGER IF NOT EXISTS decisions_update AFTER UPDATE OF response_size ON decisions BEGIN
			UPDATE decision_bytes SET size = size + new.response_size - old.response_size WHERE id = 1;
		END`,
  ];
}

export const DECISION_STORE_VERSION = 1;
export const SELECT_DECISION = 'SELECT response FROM decisions WHERE key = ? AND expires_at > ?';
export const DELETE_EXPIRED = 'DELETE FROM decisions WHERE expires_at <= ?';
export const UPSERT_DECISION = `INSERT INTO decisions (key, response, created_at, expires_at, response_size)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET response = excluded.response, created_at = excluded.created_at,
			expires_at = excluded.expires_at, response_size = excluded.response_size`;
export const SELECT_TOTAL_BYTES = 'SELECT size FROM decision_bytes WHERE id = 1';
export const SELECT_OLDEST = 'SELECT key, response_size FROM decisions ORDER BY created_at, key LIMIT 1';
export const DELETE_KEY = 'DELETE FROM decisions WHERE key = ?';

/** An in-memory store for tests and for proving the shared contract itself. */
export class MemoryDecisionStore implements DecisionStore {
  private readonly entries = new Map<string, { body: Uint8Array; created: number; expires: number }>();
  private closed = false;
  constructor(private readonly maxBytes: bigint) {
    if (maxBytes <= 0n) throw new Error('cache max bytes must be positive');
  }
  private check(): void { if (this.closed) throw new Error('decision store is closed'); }
  async get(key: string, nowMilliseconds: number): Promise<Uint8Array | undefined> {
    this.check();
    const entry = this.entries.get(key);
    return entry !== undefined && entry.expires > nowMilliseconds ? entry.body : undefined;
  }
  async put(key: string, body: Uint8Array, nowMilliseconds: number, expiresMilliseconds: number): Promise<void> {
    this.check();
    if (body.byteLength === 0) throw new Error('cache response must not be empty');
    if (BigInt(body.byteLength) > this.maxBytes) return;
    for (const [id, entry] of [...this.entries]) if (entry.expires <= nowMilliseconds) this.entries.delete(id);
    if (expiresMilliseconds > nowMilliseconds) {
      this.entries.set(key, { body, created: nowMilliseconds, expires: expiresMilliseconds });
    }
    for (;;) {
      let size = 0n;
      for (const entry of this.entries.values()) size += BigInt(entry.body.byteLength);
      if (size <= this.maxBytes) break;
      const oldest = [...this.entries].sort((a, b) => a[1].created - b[1].created || compareIDs(a[0], b[0]))[0]!;
      this.entries.delete(oldest[0]);
    }
  }
  async close(): Promise<void> { this.closed = true; }
}
