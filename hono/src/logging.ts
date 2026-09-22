// Opt-in full bodies are application-sensitive. Metadata deliberately excludes
// headers, query strings, full URLs, credentials, and raw exception messages.
export type LogScope = 'gateway' | 'selector' | 'backend';
export interface LogRecord {
  readonly version: 1;
  readonly id: string;
  readonly request_id: string;
  readonly exchange_id: string;
  readonly kind: 'request' | 'response';
  readonly scope: LogScope;
  readonly time: number;
  readonly method: string;
  readonly path: string;
  readonly body_base64: string;
  readonly body_complete: boolean;
  readonly status?: number;
  readonly cache?: string;
  readonly error?: string;
}
export interface LogStore {
  // Resolve only after durable commit. Never evict or replace existing events.
  append(record: LogRecord): Promise<void>;
  close(): Promise<void>;
}
export interface CapturedBody {
  readonly bytes: Uint8Array;
  readonly complete: boolean;
  readonly error?: 'body_exceeds_limit' | 'body_unreadable' | 'request_canceled';
}
export interface LogSettings { readonly mode: 'off' | 'record'; readonly path: string }
export function loadLogSettings(source: { value: (name: string) => string | undefined; storageConfigured: boolean }): LogSettings {
  const path = source.value('ONE_SYSTEM_LOG_PATH') ?? '';
  const mode = source.value('ONE_SYSTEM_LOG_MODE') || (source.storageConfigured ? 'record' : 'off');
  if (mode !== 'off' && mode !== 'record') throw new Error('ONE_SYSTEM_LOG_MODE must be off or record');
  if (mode === 'record' && !source.storageConfigured) throw new Error('recording requires log storage');
  return { mode, path };
}

// Not an APIError: selector fallback must never treat a failed audit write as
// a recoverable inference failure. The gateway alone maps it to a public 503.
export class LoggingUnavailable extends Error {
  constructor() { super('Exchange logging is unavailable'); }
}

export class ExchangeLogger {
  constructor(private readonly store: LogStore) {}

  async begin(requestID: string, scope: LogScope, method: string, path: string, body: CapturedBody): Promise<LogExchange> {
    const exchange = new LogExchange(this, requestID, crypto.randomUUID(), scope, method, path);
    await exchange.record('request', body, undefined, undefined, scope === 'gateway' && !body.complete ? 'invalid_body' : undefined);
    return exchange;
  }

  async append(record: LogRecord): Promise<void> {
    try { await this.store.append(record); } catch { throw new LoggingUnavailable(); }
  }
}

export class LogExchange {
  constructor(
    private readonly logger: ExchangeLogger,
    private readonly requestID: string,
    private readonly exchangeID: string,
    private readonly scope: LogScope,
    private readonly method: string,
    private readonly path: string,
  ) {}

  async record(kind: 'request' | 'response', body: CapturedBody, status?: number, cache?: string, error?: string): Promise<void> {
    // Chunk conversion avoids spreading an 8 MiB body onto the JS call stack.
    const chunks: string[] = [];
    for (let at = 0; at < body.bytes.length; at += 0x8000) {
      chunks.push(String.fromCharCode(...body.bytes.subarray(at, at + 0x8000)));
    }
    const failure = error ?? body.error;
    await this.logger.append({
      version: 1, id: crypto.randomUUID(), request_id: this.requestID,
      exchange_id: this.exchangeID, kind, scope: this.scope, time: Date.now(),
      method: this.method, path: this.path, body_base64: btoa(chunks.join('')), body_complete: body.complete,
      ...(status === undefined ? {} : { status }),
      ...(cache === undefined ? {} : { cache }),
      ...(failure === undefined ? {} : { error: failure }),
    });
  }
}

export const LOG_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS log_events (id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL, exchange_id TEXT NOT NULL, record TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS log_events_request ON log_events(request_id)',
] as const;
export const INSERT_LOG_EVENT = 'INSERT INTO log_events (id, request_id, exchange_id, record) VALUES (?, ?, ?, ?)';
