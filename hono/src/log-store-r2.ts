import type { LogRecord, LogStore } from './logging.js';

/** Minimal R2 binding surface; no D1 row ceiling for captured full exchanges. */
export interface R2BucketLike {
  put(key: string, value: string): Promise<unknown>;
}
export class R2LogStore implements LogStore {
  constructor(private readonly bucket: R2BucketLike) {
    if (typeof bucket?.put !== 'function') throw new Error('log bucket binding is unavailable');
  }

  async append(record: LogRecord): Promise<void> {
    const stored = await this.bucket.put(`logs/${record.request_id}/${record.id}.json`, JSON.stringify(record));
    // R2 uses null for an unsuccessful conditional write. We supply no
    // conditions, but never treat an explicitly uncommitted write as durable.
    if (stored === null) throw new Error('log object was not committed');
  }

  async close(): Promise<void> {}
}
