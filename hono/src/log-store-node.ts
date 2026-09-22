import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { INSERT_LOG_EVENT, LOG_SCHEMA } from './logging.js';
import type { LogRecord, LogStore } from './logging.js';
import { checkPrivateSQLiteFiles, preparePrivateSQLitePath } from './sqlite-files.js';

export class NodeLogStore implements LogStore {
  private readonly insert: StatementSync;
  private constructor(private readonly database: DatabaseSync) {
    this.insert = database.prepare(INSERT_LOG_EVENT);
  }

  static async open(path: string): Promise<NodeLogStore> {
    const absolute = preparePrivateSQLitePath(path);
    // Optional platform-specific builtin stays unloaded when recording is off.
    const { DatabaseSync: Database } = await import('node:sqlite');
    const database = new Database(absolute, { timeout: 5_000 });
    try {
      const journal = database.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string };
      if (journal.journal_mode !== 'wal') throw new Error('log WAL is unavailable');
      database.exec('PRAGMA synchronous = FULL');
      database.exec('BEGIN IMMEDIATE');
      for (const statement of LOG_SCHEMA) database.exec(statement);
      database.exec('COMMIT');
      checkPrivateSQLiteFiles(absolute);
      return new NodeLogStore(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async append(record: LogRecord): Promise<void> {
    // Each INSERT autocommits before run returns. FULL synchronizes the WAL at
    // commit, so resolving this promise is the inference/response release gate.
    this.insert.run(record.id, record.request_id, record.exchange_id, JSON.stringify(record));
  }

  async close(): Promise<void> { this.database.close(); }
}
