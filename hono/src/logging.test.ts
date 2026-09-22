import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createDecisionCache, createGateway } from './app.js';
import { MemoryDecisionStore, loadCacheSettings } from './cache.js';
import { loadConfig } from './config.js';
import { ExchangeLogger, loadLogSettings } from './logging.js';
import type { LogRecord, LogStore } from './logging.js';
import { NodeLogStore } from './log-store-node.js';
import { R2LogStore } from './log-store-r2.js';
import { assertSeparateSQLitePaths } from './sqlite-files.js';
import { BODY_LIMIT } from './transport.js';

const encoder = new TextEncoder();
const payload = '{ "model":"router", "state":"application-sensitive", "questions":{"q":{"type":"noul","instructions":"Synthetic?"}} }';
const leaf = '{ "model":"leaf", "answers":{"q":{"type":"noul","noul":0.75}}, "usage":{"input_tokens":9,"output_tokens":4} }';
const selection = '{"model":"selector","answers":{"backend":{"type":"choice","choice":"hosted","confidence":1,"probabilities":{"local":0,"hosted":1}}},"usage":{"input_tokens":2,"output_tokens":1}}';

class RecordingStore implements LogStore {
  readonly records: LogRecord[] = [];
  async append(record: LogRecord): Promise<void> { this.records.push(record); }
  async close(): Promise<void> {}
}
async function config(withSelector = false) {
  const backends = [{ id: 'local', base_url: 'http://127.0.0.1:1', model: 'leaf', api_key_env: 'LOCAL_KEY', description: 'Local' }];
  if (withSelector) backends.push({ id: 'hosted', base_url: 'http://127.0.0.1:2', model: 'leaf', api_key_env: 'HOSTED_KEY', description: 'Hosted' });
  return loadConfig(JSON.stringify({ name: 'router', selector: 'local', fallback: 'local', backends }), {
    publicKey: 'public-key', secret: () => 'upstream-private-key', questions: () => '',
  });
}
function request(body: BodyInit = payload, authorized = true, cache?: string): Request {
  return new Request('http://gateway.invalid/v1/systemone?never-log-this-query', {
    method: 'POST', body, duplex: 'half', headers: {
      Authorization: authorized ? 'Bearer public-key' : 'Bearer rejected-private-key',
      Cookie: 'private-cookie', ...(cache ? { 'X-One-System-Cache': cache } : {}),
    },
  } as RequestInit & { duplex: 'half' });
}

test('full exchanges preserve exact bytes and original usage, correlate scopes, and log hits without inference', async () => {
  const cfg = await config(true);
  const records = new RecordingStore();
  const cacheSettings = loadCacheSettings({ storageConfigured: true, value: name => name === 'ONE_SYSTEM_CACHE_EPOCH' ? 'logs-v1' : undefined });
  const forwarded: string[] = [];
  const app = createGateway(cfg, {
    logger: new ExchangeLogger(records),
    cache: createDecisionCache(cfg, cacheSettings, new MemoryDecisionStore(cacheSettings.maxBytes)),
    fetch: async (_url, init) => {
      const sent = await new Response(init?.body).text();
      forwarded.push(sent);
      return new Response(forwarded.length === 1 ? selection : leaf);
    },
  });
  const response = await app.fetch(request());
  const returned = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(returned).usage, { input_tokens: 11, output_tokens: 5 });
  assert.deepEqual(records.records.map(record => `${record.scope}:${record.kind}`), [
    'gateway:request', 'selector:request', 'selector:response', 'backend:request', 'backend:response', 'gateway:response',
  ]);
  assert.deepEqual(records.records.map(record => Buffer.from(record.body_base64, 'base64').toString()), [
    payload, forwarded[0], selection, forwarded[1], leaf, returned,
  ]);
  assert.equal(new Set(records.records.map(record => record.request_id)).size, 1);
  assert.equal(new Set(records.records.map(record => record.id)).size, 6);
  for (const scope of ['gateway', 'selector', 'backend']) {
    const pair = records.records.filter(record => record.scope === scope);
    assert.equal(pair[0]!.exchange_id, pair[1]!.exchange_id);
  }
  for (const record of records.records) {
    assert.equal(record.path, '/v1/systemone');
    assert.equal(record.body_complete, true);
    assert.match(record.id, /^[0-9a-f-]{36}$/);
  }
  const serialized = JSON.stringify(records.records);
  for (const secret of ['public-key', 'private-cookie', 'upstream-private-key', 'never-log-this-query', 'gateway.invalid']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  const replay = await app.fetch(request());
  const replayBody = await replay.text();
  assert.deepEqual(JSON.parse(replayBody).usage, { input_tokens: 0, output_tokens: 0 });
  assert.equal(forwarded.length, 2);
  assert.equal(records.records[7]!.cache, 'hit');
  assert.equal(Buffer.from(records.records[7]!.body_base64, 'base64').toString(), replayBody);
  assert.notEqual(records.records[6]!.request_id, records.records[0]!.request_id);
});

test('upstream request and response paths retain escaped base prefixes without changing gateway paths', async () => {
  const cfg = await loadConfig(JSON.stringify({
    name: 'router', selector: 'local', fallback: 'local', backends: [
      { id: 'local', base_url: 'https://selector.invalid/tenant%2Fone', model: 'selector', api_key_env: 'LOCAL_KEY', description: 'Local' },
      { id: 'hosted', base_url: 'https://backend.invalid/service%20two', model: 'leaf', api_key_env: 'HOSTED_KEY', description: 'Hosted' },
    ],
  }), { publicKey: 'public-key', secret: () => 'upstream-private-key', questions: () => '' });
  const records = new RecordingStore();
  const urls: string[] = [];
  const app = createGateway(cfg, {
    logger: new ExchangeLogger(records),
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(urls.length === 1 ? selection : leaf);
    },
  });
  assert.equal((await app.fetch(request())).status, 200);
  assert.deepEqual(urls, [
    'https://selector.invalid/tenant%2Fone/v1/systemone',
    'https://backend.invalid/service%20two/v1/systemone',
  ]);
  assert.deepEqual(records.records.map(record => [record.scope, record.kind, record.path]), [
    ['gateway', 'request', '/v1/systemone'],
    ['selector', 'request', '/tenant%2Fone/v1/systemone'],
    ['selector', 'response', '/tenant%2Fone/v1/systemone'],
    ['backend', 'request', '/service%20two/v1/systemone'],
    ['backend', 'response', '/service%20two/v1/systemone'],
    ['gateway', 'response', '/v1/systemone'],
  ]);
});

test('request and response durable writes gate inference and result release', async () => {
  const requestReached = Promise.withResolvers<void>();
  const requestCommit = Promise.withResolvers<void>();
  const responseReached = Promise.withResolvers<void>();
  const responseCommit = Promise.withResolvers<void>();
  let calls = 0;
  let released = false;
  const store: LogStore = {
    async append(record) {
      if (record.scope === 'backend' && record.kind === 'request') {
        requestReached.resolve(); await requestCommit.promise;
      }
      if (record.scope === 'gateway' && record.kind === 'response') {
        responseReached.resolve(); await responseCommit.promise;
      }
    },
    async close() {},
  };
  const app = createGateway(await config(), {
    logger: new ExchangeLogger(store), fetch: async () => { calls++; return new Response(leaf); },
  });
  const result = Promise.resolve(app.fetch(request())).then(response => { released = true; return response; });
  await requestReached.promise;
  assert.equal(calls, 0);
  requestCommit.resolve();
  await responseReached.promise;
  assert.equal(calls, 1);
  assert.equal(released, false);
  responseCommit.resolve();
  assert.equal((await result).status, 200);
});

test('every write failure is a sanitized 503 and cannot activate selector fallback or retry', async () => {
  // gateway request, selector request/response, backend request/response, gateway response
  for (let failedWrite = 1; failedWrite <= 6; failedWrite++) {
    let writes = 0;
    let calls = 0;
    const recorded: LogRecord[] = [];
    const store: LogStore = {
      async append(record) {
        if (++writes === failedWrite) throw new Error('secret storage pathname');
        recorded.push(record);
      }, async close() {},
    };
    const app = createGateway(await config(true), {
      logger: new ExchangeLogger(store), fetch: async () => new Response(++calls === 1 ? selection : leaf),
    });
    const response = await app.fetch(request());
    assert.equal(response.status, 503, String(failedWrite));
    const source = await response.text();
    assert.equal(JSON.parse(source).detail[0].type, 'logging_unavailable');
    assert.equal(source.includes('secret storage pathname'), false);
    assert.equal(writes, failedWrite > 1 && failedWrite < 6 ? failedWrite + 1 : failedWrite, 'only a distinct gateway error response may follow a failed event');
    if (failedWrite > 1 && failedWrite < 6) {
      const final = recorded.at(-1)!;
      assert.equal(final.scope, 'gateway');
      assert.equal(final.status, 503);
      assert.equal(final.error, 'logging_unavailable');
      assert.equal(Buffer.from(final.body_base64, 'base64').toString(), source);
    }
    assert.equal(calls, failedWrite <= 2 ? 0 : failedWrite <= 4 ? 1 : 2);
  }
});

test('malformed, unauthorized, rejected, and network failures retain bodies but never exception text', async () => {
  const malformed = new Uint8Array([0xff, 0x7b]);
  const records = new RecordingStore();
  let calls = 0;
  const app = createGateway(await config(), {
    logger: new ExchangeLogger(records), fetch: async () => {
      calls++;
      if (calls === 1) return new Response('upstream application error', { status: 401 });
      throw new Error('https://user:password@private.invalid/?secret=transport');
    },
  });
  assert.equal((await app.fetch(request(malformed))).status, 422);
  assert.equal((await app.fetch(request(malformed, false))).status, 401);
  assert.deepEqual(Buffer.from(records.records[0]!.body_base64, 'base64'), Buffer.from(malformed));
  assert.deepEqual(Buffer.from(records.records[2]!.body_base64, 'base64'), Buffer.from(malformed));
  assert.equal(calls, 0);
  assert.equal((await app.fetch(request())).status, 502);
  assert.equal((await app.fetch(request())).status, 502);
  const responses = records.records.filter(record => record.scope === 'backend' && record.kind === 'response');
  assert.equal(responses[0]!.status, 401);
  assert.equal(Buffer.from(responses[0]!.body_base64, 'base64').toString(), 'upstream application error');
  assert.equal(responses[0]!.error, 'upstream_rejected');
  assert.equal(responses[1]!.status, 0);
  assert.equal(responses[1]!.body_complete, false);
  assert.equal(responses[1]!.body_base64, '');
  assert.equal(responses[1]!.error, 'upstream_unavailable');
  assert.equal(JSON.stringify(records.records).includes('password'), false);
});

test('oversized and disconnected request/response prefixes are bounded and explicitly incomplete', async () => {
  const records = new RecordingStore();
  let calls = 0;
  const app = createGateway(await config(), {
    logger: new ExchangeLogger(records), fetch: async () => {
      calls++;
      return new Response(new Uint8Array(BODY_LIMIT + 1).fill(0x61));
    },
  });
  assert.equal((await app.fetch(request(new Uint8Array(BODY_LIMIT + 1).fill(0x62)))).status, 422);
  assert.equal(calls, 0);
  assert.equal(Buffer.from(records.records[0]!.body_base64, 'base64').length, BODY_LIMIT);
  assert.equal(records.records[0]!.body_complete, false);
  assert.equal(records.records[0]!.error, 'invalid_body');
  let pulls = 0;
  const disconnected = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++pulls === 1) controller.enqueue(encoder.encode('partial'));
      else controller.error(new Error('secret socket details'));
    },
  });
  assert.equal((await app.fetch(request(disconnected))).status, 422);
  assert.equal(Buffer.from(records.records[2]!.body_base64, 'base64').toString(), 'partial');
  assert.equal(records.records[2]!.body_complete, false);
  assert.equal((await app.fetch(request())).status, 502);
  const upstream = records.records.find(record => record.scope === 'backend' && record.kind === 'response')!;
  assert.equal(Buffer.from(upstream.body_base64, 'base64').length, BODY_LIMIT);
  assert.equal(upstream.body_complete, false);
  assert.equal(upstream.error, 'invalid_upstream_response');
});

test('SQLite logs survive reopening, reject replacement and exposed storage, and remain separate from cache paths', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'one-system-logs-'));
  const path = join(directory, 'events.sqlite');
  let store = await NodeLogStore.open(path);
  try {
    const logger = new ExchangeLogger(store);
    const exchange = await logger.begin(crypto.randomUUID(), 'gateway', 'POST', '/v1/systemone', { bytes: encoder.encode(payload), complete: true });
    await exchange.record('response', { bytes: encoder.encode(leaf), complete: true }, 200);
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(path + suffix)) assert.equal(statSync(path + suffix).mode & 0o777, 0o600);
    }
    await store.close();
    store = await NodeLogStore.open(path);
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = reader.prepare('SELECT record FROM log_events ORDER BY rowid').all();
      assert.equal(rows.length, 2);
      const first = JSON.parse(String(rows[0]!.record)) as LogRecord;
      assert.equal(Buffer.from(first.body_base64, 'base64').toString(), payload);
      await assert.rejects(store.append(first));
      assert.equal(reader.prepare('SELECT record FROM log_events WHERE id = ?').get(first.id)?.record, rows[0]!.record);
    } finally { reader.close(); }
    assert.throws(() => assertSeparateSQLitePaths(path, join(directory, '.', 'events.sqlite')));
    linkSync(path, join(directory, 'hardlink.sqlite'));
    assert.throws(() => assertSeparateSQLitePaths(path, join(directory, 'hardlink.sqlite')));
    symlinkSync(directory, join(directory, 'alias'));
    assert.throws(() => assertSeparateSQLitePaths(path, join(directory, 'alias', 'events.sqlite')));
    mkdirSync(join(directory, 'exposed'));
    chmodSync(join(directory, 'exposed'), 0o755);
    await assert.rejects(NodeLogStore.open(join(directory, 'exposed', 'events.sqlite')));
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SQLite file families cannot overlap in either store order before storage exists', () => {
  const directory = mkdtempSync(join(tmpdir(), 'one-system-paths-'));
  try {
    const path = join(directory, 'uncreated', 'cache.sqlite');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      assert.throws(() => assertSeparateSQLitePaths(path, path + suffix));
      assert.throws(() => assertSeparateSQLitePaths(path + suffix, path));
    }
    assert.equal(existsSync(join(directory, 'uncreated')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('SQLite isolation compares every family member inode and resolves symlinked ancestors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'one-system-aliases-'));
  try {
    for (const cacheSuffix of ['', '-wal', '-shm', '-journal']) {
      for (const logSuffix of ['', '-wal', '-shm', '-journal']) {
        const pair = join(directory, `cache${cacheSuffix}-log${logSuffix}`);
        mkdirSync(pair);
        const cachePath = join(pair, 'cache.sqlite');
        const logPath = join(pair, 'log.sqlite');
        writeFileSync(cachePath + cacheSuffix, 'existing history', { mode: 0o600 });
        linkSync(cachePath + cacheSuffix, logPath + logSuffix);
        assert.throws(() => assertSeparateSQLitePaths(cachePath, logPath));
      }
    }
    symlinkSync(directory, join(directory, 'alias'));
    const cachePath = join(directory, 'uncreated', 'cache.sqlite');
    assert.throws(() => assertSeparateSQLitePaths(cachePath, join(directory, 'alias', 'uncreated', 'cache.sqlite-journal')));
    assertSeparateSQLitePaths(cachePath, join(directory, 'alias', 'uncreated', 'history.sqlite'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('SQLite isolation fails closed on dangling and looping sidecar symlinks even when the other store is absent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'one-system-inspection-'));
  try {
    for (const target of ['missing', 'loop']) {
      const cachePath = join(directory, `${target}-cache.sqlite`);
      const logPath = join(directory, `${target}-log.sqlite`);
      const link = logPath + '-journal';
      symlinkSync(target === 'loop' ? link : join(directory, 'missing'), link);
      assert.throws(() => assertSeparateSQLitePaths(cachePath, logPath));
      assert.throws(() => assertSeparateSQLitePaths(logPath, cachePath));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('R2 commit failure is fail-closed and explicit logging off never requires storage', async () => {
  assert.equal(loadLogSettings({ storageConfigured: true, value: name => name === 'ONE_SYSTEM_LOG_MODE' ? 'off' : undefined }).mode, 'off');
  assert.throws(() => loadLogSettings({ storageConfigured: false, value: name => name === 'ONE_SYSTEM_LOG_MODE' ? 'record' : undefined }));
  const app = createGateway(await config(), {
    logger: new ExchangeLogger(new R2LogStore({ async put() { return null; } })),
    fetch: async () => { assert.fail('uncommitted R2 requests cannot run inference'); },
  });
  assert.equal((await app.fetch(request())).status, 503);
});
