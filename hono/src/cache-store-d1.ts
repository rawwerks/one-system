// Cloudflare D1 decision store for the Worker host.
//
// D1 is SQLite, so the table, the byte-accounting triggers and the eviction
// order match cache_store.go and cache-store-node.ts and the protocol above
// the store is unchanged. What D1 does NOT offer forces three differences,
// each verified against the current documentation rather than assumed:
//
//   * No user_version PRAGMA: the allowlist in
//     https://developers.cloudflare.com/d1/sql-api/sql-statements/ excludes it
//     and a read returns SQLITE_AUTH. The schema is therefore created
//     idempotently with IF NOT EXISTS and memoised per isolate; there is no
//     stored schema version to compare.
//   * No BEGIN/COMMIT: D1 runs every query in an implicit transaction and
//     directs callers to batch(), which is atomic and rolls the whole sequence
//     back on failure
//     (https://developers.cloudflare.com/d1/worker-api/d1-database/).
//   * A 2,000,000 byte ceiling on any BLOB or row
//     (https://developers.cloudflare.com/d1/platform/limits/), below the
//     protocol's 8 MiB response bound, so larger decisions are returned to the
//     caller but not stored, exactly as an over-budget response already is.
//
// Reads use the plain binding, never the Sessions API, so every query is
// served by the primary and a write is visible to the next read.
import { DELETE_EXPIRED, SELECT_DECISION, SELECT_TOTAL_BYTES, UPSERT_DECISION, decisionSchema } from './cache.js';
import type { DecisionStore } from './cache.js';

/** The subset of D1's binding surface this store uses. */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

/** Maximum bytes D1 accepts in one BLOB or row. */
export const D1_ROW_LIMIT = 2_000_000n;

// Keep the newest prefix whose response bytes fit, deleting its oldest suffix.
// The ledger guard avoids scanning entries while already within budget. Window
// SUM and DELETE execute in SQLite, so eviction needs two budget parameters and
// one statement regardless of how many entries must go.
const DELETE_OVER_BUDGET = `DELETE FROM decisions WHERE key IN (
  SELECT key FROM (
    SELECT key, SUM(response_size) OVER (
      ORDER BY created_at DESC, key DESC
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS cumulative_size
    FROM decisions WHERE (${SELECT_TOTAL_BYTES}) > ?
  ) WHERE cumulative_size > ?
)`;

export class D1DecisionStore implements DecisionStore {
  private schema: Promise<void> | undefined;
  private readonly entryLimit: bigint;

  constructor(private readonly database: D1DatabaseLike, private readonly maxBytes: bigint) {
    if (maxBytes <= 0n) throw new Error('cache max bytes must be positive');
    this.entryLimit = maxBytes < D1_ROW_LIMIT ? maxBytes : D1_ROW_LIMIT;
  }

  /** Create the ledger on first use; an unusable binding fails the caller,
   *  which the shared policy reports as a cache error rather than a decision. */
  private ready(): Promise<void> {
    if (this.schema === undefined) {
      this.schema = this.database.batch(decisionSchema().map(statement => this.database.prepare(statement)))
        .then(() => undefined)
        .catch(error => { this.schema = undefined; throw error; });
    }
    return this.schema;
  }

  async get(key: string, nowMilliseconds: number): Promise<Uint8Array | undefined> {
    await this.ready();
    const row = await this.database.prepare(SELECT_DECISION).bind(key, nowMilliseconds).first<{ response: number[] }>();
    // D1 accepts an ArrayBuffer for a BLOB but returns a plain number array.
    return row === null ? undefined : Uint8Array.from(row.response);
  }

  async put(key: string, body: Uint8Array, nowMilliseconds: number, expiresMilliseconds: number): Promise<void> {
    if (body.byteLength === 0) throw new Error('cache response must not be empty');
    if (BigInt(body.byteLength) > this.entryLimit) return;
    await this.ready();
    const writes = [this.database.prepare(DELETE_EXPIRED).bind(nowMilliseconds)];
    if (expiresMilliseconds > nowMilliseconds) {
      writes.push(this.database.prepare(UPSERT_DECISION).bind(
        key, body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        nowMilliseconds, expiresMilliseconds, body.byteLength));
    }
    // D1 cannot bind BigInts; configured budgets are at most 1 TiB, exactly
    // representable as a Number. Eviction failure rolls expiry and upsert back.
    const maxBytes = Number(this.maxBytes);
    writes.push(this.database.prepare(DELETE_OVER_BUDGET).bind(maxBytes, maxBytes));
    await this.database.batch(writes);
  }

  /** A bound database outlives the request; there is nothing to release. */
  async close(): Promise<void> {}
}
