import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { createDecisionCache, createGateway } from './app.js';
import { DecisionCache, MemoryDecisionStore, configurationRevision, decisionKey, loadCacheSettings, parseGoDuration } from './cache.js';
import type { DecisionStore } from './cache.js';
import { D1DecisionStore } from './cache-store-d1.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from './cache-store-d1.js';
import { NodeDecisionStore } from './cache-store-node.js';
import { object, parseJSON } from './codec.js';
import { loadConfig } from './config.js';

const encoder = new TextEncoder();
const questions = object(parseJSON('{"q":{"type":"noul","instructions":"Is this synthetic?"}}'));
const body = '{"model":"routing-demo","state":"x","questions":{"q":{"type":"noul","instructions":"Is this synthetic?"}}}';
const decision = '{"model":"leaf","answers":{"q":{"type":"noul","noul":0.75}},"usage":{"input_tokens":9,"output_tokens":4}}';
const settings = loadCacheSettings({ storageConfigured: true, value: name => name === 'ONE_SYSTEM_CACHE_EPOCH' ? 'test-v1' : undefined });
const request = (mode?: string) => new Request('http://gateway.invalid/v1/systemone', {
  method: 'POST', body, headers: { Authorization: 'Bearer public-key', ...(mode ? { 'X-One-System-Cache': mode } : {}) },
});

// These are public, language-neutral vectors; no private archive evidence.
test('cache keys, revisions and durations match the shared Go protocol vectors', async () => {
  const keys = JSON.parse(readFileSync(new URL('../../examples/cache-key-vectors.json', import.meta.url), 'utf8')) as {
    namespace: string; revision: string; request: string; sha256: string;
  }[];
  for (const vector of keys) assert.equal(await decisionKey(vector.namespace, vector.revision, encoder.encode(vector.request)), vector.sha256);
  const vectors = JSON.parse(readFileSync(new URL('../../examples/cache-revision-vectors.json', import.meta.url), 'utf8')) as {
    durations: { text: string; invalid?: boolean; nanoseconds?: string }[];
    revisions: { registry: string; api_key: string; secrets: Record<string, string>; questions: Record<string, string>; epoch: string; openapi_digest: string; selector_question_digest: string; revision: string }[];
  };
  for (const vector of vectors.durations) {
    if (vector.invalid) assert.throws(() => parseGoDuration(vector.text));
    else assert.equal(parseGoDuration(vector.text), BigInt(vector.nanoseconds!));
  }
  for (const vector of vectors.revisions) {
    const config = await loadConfig(vector.registry, {
      publicKey: vector.api_key, secret: name => vector.secrets[name], questions: name => vector.questions[name]!,
    });
    assert.equal(await configurationRevision(config, vector.epoch, {
      openAPI: vector.openapi_digest, selectorQuestion: vector.selector_question_digest,
    }), vector.revision);
  }
});

test('explicit cache off wins over storage, while enabled modes require storage and epoch', () => {
  assert.equal(loadCacheSettings({ storageConfigured: true, value: name => name === 'ONE_SYSTEM_CACHE_MODE' ? 'off' : undefined }).mode, 'off');
  assert.throws(() => loadCacheSettings({ storageConfigured: true, value: () => undefined }));
  assert.throws(() => loadCacheSettings({ storageConfigured: false, value: name => name === 'ONE_SYSTEM_CACHE_MODE' ? 'replay' : 'epoch' }));
  for (const [name, value] of [['ONE_SYSTEM_CACHE_TTL', '999us'], ['ONE_SYSTEM_CACHE_MAX_BYTES', '0']]) {
    assert.throws(() => loadCacheSettings({ storageConfigured: true, value: key => key === name ? value : key === 'ONE_SYSTEM_CACHE_EPOCH' ? 'e' : undefined }));
  }
});

test('SQLite decisions survive restart; exact-byte hits replay zero usage, bypass runs inference', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'one-system-cache-'));
  const path = join(directory, 'decisions.sqlite');
  const config = await loadConfig(JSON.stringify({ name: 'routing-demo', selector: 'local', backends: [
    { id: 'local', base_url: 'http://127.0.0.1:1', model: 'leaf', api_key_env: 'LOCAL_KEY', description: 'Local' },
  ] }), { publicKey: 'public-key', secret: () => 'leaf-key', questions: () => '' });
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response(decision); };
  let store = await NodeDecisionStore.open(path, settings.maxBytes);
  try {
    let app = createGateway(config, { cache: createDecisionCache(config, settings, store), fetch: fetcher });
    const miss = await app.fetch(request());
    assert.equal(miss.headers.get('X-One-System-Cache'), 'miss');
    assert.deepEqual(JSON.parse(await miss.text()).usage, { input_tokens: 9, output_tokens: 4 });
    await store.close();
    store = await NodeDecisionStore.open(path, settings.maxBytes);
    app = createGateway(config, { cache: createDecisionCache(config, settings, store), fetch: fetcher });
    const hit = await app.fetch(request());
    assert.equal(hit.headers.get('X-One-System-Cache'), 'hit');
    assert.deepEqual(JSON.parse(await hit.text()).usage, { input_tokens: 0, output_tokens: 0 });
    assert.equal(calls, 1);
    const changed = await app.fetch(new Request(request(), { body: body + ' ' }));
    assert.equal(changed.headers.get('X-One-System-Cache'), 'miss');
    assert.equal(calls, 2);
    assert.equal((await app.fetch(request('bypass'))).headers.get('X-One-System-Cache'), 'bypass');
    assert.equal(calls, 3);
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('coalesced followers replay the leader, and canceled followers do not cancel it', async () => {
  const cache = new DecisionCache(settings, new MemoryDecisionStore(settings.maxBytes), Promise.resolve('revision'));
  const leader = await cache.begin(request(), encoder.encode(body), questions, new AbortController().signal, {});
  const controller = new AbortController();
  const canceled = cache.begin(request(), encoder.encode(body), questions, controller.signal, {});
  controller.abort();
  await assert.rejects(canceled, (error: { code: string }) => error.code === 'request_canceled');
  const headers: Record<string, string> = {};
  const follower = cache.begin(request(), encoder.encode(body), questions, new AbortController().signal, headers);
  await cache.remember(leader.key, object(parseJSON(decision)));
  leader.release();
  const hit = await follower;
  assert.equal(headers['X-One-System-Cache'], 'hit');
  assert.deepEqual(JSON.parse(hit.replay!).usage, { input_tokens: 0, output_tokens: 0 });
  hit.release();
});

test('unreadable or poisoned cache entries cannot escape replay-only mode', async () => {
  const broken: DecisionStore = {
    async get() { throw new Error('private storage detail'); }, async put() {}, async close() {},
  };
  for (const store of [broken, new MemoryDecisionStore(settings.maxBytes)]) {
    const cache = new DecisionCache(settings, store, Promise.resolve('revision'));
    if (store instanceof MemoryDecisionStore) {
      const key = await decisionKey(settings.namespace, 'revision', encoder.encode(body));
      await store.put(key, encoder.encode(decision.replace('"q":', '"other":')), Date.now(), Date.now() + 10_000);
    }
    const headers: Record<string, string> = {};
    await assert.rejects(cache.begin(request('replay'), encoder.encode(body), questions, new AbortController().signal, headers),
      (error: { code: string }) => error.code === 'cache_unavailable');
    assert.equal(headers['X-One-System-Cache'], 'error');
    const online = await cache.begin(request(), encoder.encode(body), questions, new AbortController().signal, {});
    assert.equal(online.replay, undefined);
    online.release();
  }
});

test('unsupported selector inputs reject before cache hits, replay misses, or store failures', async () => {
  for (const featureSelection of [false, true]) {
    const config = await loadConfig(JSON.stringify({
      name: 'routing-demo', selector: 'local', fallback: 'local',
      ...(featureSelection ? { selection: {
        questions_file: 'features.json', escalate_to: 'hosted', rules: [{ question: 'route', above: 0.5 }],
      } } : {}),
      backends: [
        { id: 'local', base_url: 'http://127.0.0.1:1', model: 'leaf', api_key_env: 'LOCAL_KEY', description: 'Local',
          capabilities: { question_types: ['noul'], structured_state: false } },
        { id: 'hosted', base_url: 'http://127.0.0.1:2', model: 'leaf', api_key_env: 'HOSTED_KEY', description: 'Hosted' },
      ],
    }), {
      publicKey: 'public-key', secret: () => 'leaf-key',
      questions: () => '{"route":{"type":"noul","instructions":"Does this need hosted processing?"}}',
    });
    // Both destinations accept the original Noul/string request. Only the
    // actual selector request is unsupported: Choice or structured task state.
    for (const outcome of ['hit', 'miss', 'failure']) {
      let reads = 0;
      let calls = 0;
      const store: DecisionStore = {
        async get() {
          reads++;
          if (outcome === 'failure') throw new Error('synthetic store failure');
          return outcome === 'hit' ? encoder.encode(decision) : undefined;
        },
        async put() { assert.fail('unsupported requests cannot be cached'); },
        async close() {},
      };
      const app = createGateway(config, {
        cache: createDecisionCache(config, settings, store),
        fetch: async () => { calls++; return new Response(decision); },
      });
      const response = await app.fetch(request(outcome === 'hit' ? undefined : 'replay'));
      assert.equal(response.status, 422, `${featureSelection}:${outcome}`);
      assert.equal(JSON.parse(await response.text()).detail[0].type, 'unsupported_capability');
      assert.equal(response.headers.get('X-One-System-Cache'), null);
      assert.equal(reads, 0);
      assert.equal(calls, 0);
    }
  }
});

test('SQLite expiry boundary and oldest-write eviction preserve useful decisions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'one-system-budget-'));
  const path = join(directory, 'decisions.sqlite');
  const store = await NodeDecisionStore.open(path, 6n);
  try {
    await store.put('expired', encoder.encode('old'), 1, 2);
    assert.equal(await store.get('expired', 2), undefined);
    await store.put('first', encoder.encode('one'), 2, 20);
    await store.put('second', encoder.encode('two'), 3, 20);
    await store.put('huge', encoder.encode('1234567'), 4, 20);
    assert.deepEqual(await store.get('first', 4), encoder.encode('one'));
    await store.put('third', encoder.encode('new'), 5, 20);
    assert.equal(await store.get('first', 5), undefined);
    assert.deepEqual(await store.get('second', 5), encoder.encode('two'));
    assert.deepEqual(await store.get('third', 5), encoder.encode('new'));
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
});

// Execute the store's actual SQL with D1's atomic batch contract, not canned rows.
function sqliteD1(database: DatabaseSync): D1DatabaseLike {
  function prepare(query: string, values: SQLInputValue[] = []): D1PreparedStatementLike {
    return {
      bind(...parameters) {
        assert.ok(parameters.length <= 100, 'D1 permits at most 100 bound parameters');
        return prepare(query, parameters.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value as SQLInputValue));
      },
      async first<T>() { return (database.prepare(query).get(...values) ?? null) as T | null; },
      async all<T>() { return { results: database.prepare(query).all(...values) as T[] }; },
      async run() { return database.prepare(query).run(...values); },
    };
  }
  return {
    prepare,
    async batch(statements) {
      database.exec('BEGIN');
      try {
        const results: unknown[] = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}

test('D1 evicts all necessary oldest entries for a large insertion, including tied creation times', async () => {
  const database = new DatabaseSync(':memory:');
  const store = new D1DecisionStore(sqliteD1(database), 100_000n);
  const small = new Uint8Array(100).fill(1);
  const large = new Uint8Array(90_000).fill(2);
  try {
    for (let index = 0; index < 1000; index++) {
      await store.put(String(index).padStart(4, '0'), small, 1, 10);
    }
    await store.put('large', large, 2, 10);
    assert.equal(database.prepare('SELECT SUM(length(response)) AS size FROM decisions').get()!.size, 100_000);
    assert.deepEqual(database.prepare('SELECT key FROM decisions ORDER BY key').all().map(row => row.key),
      [...Array.from({ length: 100 }, (_, index) => String(index + 900).padStart(4, '0')), 'large']);
    assert.deepEqual(await store.get('large', 2), large);

    // Updating an old key makes it newest; its previous bytes must not be counted.
    const updated = new Uint8Array(90_100).fill(3);
    await store.put('0900', updated, 3, 10);
    assert.equal(database.prepare('SELECT SUM(length(response)) AS size FROM decisions').get()!.size, 90_100);
    assert.deepEqual(database.prepare('SELECT key FROM decisions').all().map(row => row.key), ['0900']);
    assert.deepEqual(await store.get('0900', 3), updated);
  } finally { database.close(); }
});

test('D1 enforces a reduced budget even when the incoming decision is already expired', async () => {
  const database = new DatabaseSync(':memory:');
  const binding = sqliteD1(database);
  const store = new D1DecisionStore(binding, 100_000n);
  const small = new Uint8Array(100).fill(1);
  try {
    for (let index = 0; index < 1000; index++) {
      await store.put(String(index).padStart(4, '0'), small, 1, 10);
    }
    const reduced = new D1DecisionStore(binding, 10_000n);
    await reduced.put('expired', encoder.encode('x'), 2, 2);
    assert.equal(database.prepare('SELECT SUM(length(response)) AS size FROM decisions').get()!.size, 10_000);
    assert.deepEqual(database.prepare('SELECT key FROM decisions ORDER BY key').all().map(row => row.key),
      Array.from({ length: 100 }, (_, index) => String(index + 900).padStart(4, '0')));
  } finally { database.close(); }
});

test('D1 rolls expiry and updates back if eviction fails', async () => {
  const database = new DatabaseSync(':memory:');
  const store = new D1DecisionStore(sqliteD1(database), 9n);
  try {
    await store.put('expiring', encoder.encode('old'), 1, 3);
    await store.put('replace', encoder.encode('one'), 2, 20);
    await store.put('protected', encoder.encode('two'), 2, 20);
    const before = database.prepare('SELECT * FROM decisions ORDER BY key').all();
    database.exec(`CREATE TRIGGER reject_eviction BEFORE DELETE ON decisions
      WHEN old.key = 'protected' BEGIN SELECT RAISE(ABORT, 'synthetic eviction failure'); END`);
    await assert.rejects(store.put('replace', encoder.encode('updated!'), 3, 20), /synthetic eviction failure/);
    assert.deepEqual(database.prepare('SELECT * FROM decisions ORDER BY key').all(), before);
    assert.equal(database.prepare('SELECT SUM(length(response)) AS size FROM decisions').get()!.size, 9);

    database.exec('DROP TRIGGER reject_eviction');
    await store.put('replace', encoder.encode('updated!'), 3, 20);
    assert.deepEqual(database.prepare('SELECT key FROM decisions').all().map(row => row.key), ['replace']);
    assert.deepEqual(await store.get('replace', 3), encoder.encode('updated!'));
    assert.equal(database.prepare('SELECT SUM(length(response)) AS size FROM decisions').get()!.size, 8);
  } finally { database.close(); }
});
