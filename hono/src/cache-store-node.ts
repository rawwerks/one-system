// Filesystem decision store for the Node host, using the builtin node:sqlite.
//
// The schema, the byte accounting triggers and the eviction order are those of
// cache_store.go, so one database file can be written by the Go router and
// replayed by this host and the other way round. This module is imported only
// from node.ts; app.ts and worker.ts must stay free of `node:` imports.
import { checkPrivateSQLiteFiles, preparePrivateSQLitePath } from './sqlite-files.js';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  DECISION_STORE_VERSION, DELETE_EXPIRED, DELETE_KEY, SELECT_DECISION, SELECT_OLDEST,
  SELECT_TOTAL_BYTES, UPSERT_DECISION, decisionSchema,
} from './cache.js';
import type { DecisionStore } from './cache.js';

export class NodeDecisionStore implements DecisionStore {
  private constructor(private readonly database: DatabaseSync, private readonly maxBytes: bigint) {}

  static async open(path: string, maxBytes: bigint): Promise<NodeDecisionStore> {
    if (maxBytes <= 0n) throw new Error('cache max bytes must be positive');
    const absolute = preparePrivateSQLitePath(path);
    // Optional platform-specific builtin: do not load SQLite (or emit its
    // experimental warning) on hosts that have not enabled filesystem storage.
    const { DatabaseSync: Database } = await import('node:sqlite');
    const database = new Database(absolute, { timeout: 5_000 });
    const store = new NodeDecisionStore(database, maxBytes);
    try {
      store.initialize();
      // node:sqlite creates the sidecars itself, so recheck after WAL is on.
      checkPrivateSQLiteFiles(absolute);
    } catch (error) {
      database.close();
      throw error;
    }
    return store;
  }

  private integers(sql: string): StatementSync {
    const statement = this.database.prepare(sql);
    // SQLite integers can exceed the safe JS range; read them exactly.
    statement.setReadBigInts(true);
    return statement;
  }

  private initialize(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const version = Number((this.integers('PRAGMA user_version').get() as { user_version: bigint }).user_version);
      if (version === 0) {
        const tables = (this.integers("SELECT COUNT(*) AS tables FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get() as { tables: bigint }).tables;
        if (tables !== 0n) throw new Error('cache database has an unrecognized unversioned schema');
        for (const statement of decisionSchema()) this.database.exec(statement);
        this.database.exec(`PRAGMA user_version = ${DECISION_STORE_VERSION}`);
      } else if (version === DECISION_STORE_VERSION) {
        this.database.prepare('SELECT key, response, created_at, expires_at, response_size FROM decisions LIMIT 0').all();
      } else {
        throw new Error(`unsupported cache schema version ${version} (supported: ${DECISION_STORE_VERSION})`);
      }
      // Also enforce a reduced size budget when an existing store is reopened.
      this.prune();
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* the transaction already ended */ }
      throw error;
    }
    const journal = (this.database.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string }).journal_mode;
    if (journal !== 'wal') throw new Error(`cache WAL unavailable: journal mode ${journal}`);
  }

  async get(key: string, nowMilliseconds: number): Promise<Uint8Array | undefined> {
    const row = this.database.prepare(SELECT_DECISION).get(key, nowMilliseconds) as { response: Uint8Array } | undefined;
    return row?.response;
  }

  async put(key: string, body: Uint8Array, nowMilliseconds: number, expiresMilliseconds: number): Promise<void> {
    if (body.byteLength === 0) throw new Error('cache response must not be empty');
    // Refusing a single oversized response must not evict useful entries.
    if (BigInt(body.byteLength) > this.maxBytes) return;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(DELETE_EXPIRED).run(nowMilliseconds);
      if (expiresMilliseconds > nowMilliseconds) {
        this.database.prepare(UPSERT_DECISION).run(key, body, nowMilliseconds, expiresMilliseconds, body.byteLength);
      }
      this.prune();
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* the transaction already ended */ }
      throw error;
    }
  }

  /** SQL triggers maintain the payload counter, so this is not a full scan. */
  private prune(): void {
    let size = (this.integers(SELECT_TOTAL_BYTES).get() as { size: bigint }).size;
    while (size > this.maxBytes) {
      const oldest = this.integers(SELECT_OLDEST).get() as { key: string; response_size: bigint } | undefined;
      if (oldest === undefined) throw new Error('cache byte accounting disagrees with the ledger');
      this.database.prepare(DELETE_KEY).run(oldest.key);
      size -= oldest.response_size;
    }
  }

  async close(): Promise<void> {
    this.database.close();
  }
}
