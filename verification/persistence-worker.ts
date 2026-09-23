import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { artifactDirectory, launch, ready, stop, unusedPort } from './worker.ts';
import type { Scenario } from './scenarios.ts';
import type { Json } from './scenarios.ts';

// This local-only wrapper exposes its synthetic R2 objects to the collector.
// Production gateway bundles contain none of these inspection routes.
const inspector = (entry: string, storeModule: string) => `import gateway from ${JSON.stringify(entry)};
import {D1DecisionStore} from ${JSON.stringify(storeModule)};
export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/__records') {
    const records = []; let cursor;
    do {
      const page = await env.ONE_SYSTEM_LOG_BUCKET.list({prefix:'logs/', cursor});
      for (const item of page.objects) records.push(JSON.parse(await (await env.ONE_SYSTEM_LOG_BUCKET.get(item.key)).text()));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return Response.json(records);
  }
  if (path === '/__expire') { await env.ONE_SYSTEM_CACHE_DB.prepare('DELETE FROM decisions').run(); return new Response('cleared'); }
  if (path === '/__cache-budget') {
    const db = env.ONE_SYSTEM_CACHE_DB;
    await db.batch([
      db.prepare('DELETE FROM decisions'),
      db.prepare("WITH RECURSIVE entries(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM entries WHERE n<999) INSERT INTO decisions(key,response,created_at,expires_at,response_size) SELECT printf('%04d',n),zeroblob(100),n,10000,100 FROM entries"),
    ]);
    const before = await db.prepare('SELECT count(*) AS entries, sum(response_size) AS bytes FROM decisions').first();
    const store = new D1DecisionStore(db, 100000n);
    await store.put('large', new Uint8Array(90000), 1001, 10000);
    const after = await db.prepare('SELECT count(*) AS entries, sum(response_size) AS bytes FROM decisions').first();
    const oldest = await db.prepare('SELECT key FROM decisions ORDER BY created_at,key LIMIT 1').first();
    return Response.json({budget:100000, inserted_bytes:90000, seed:{entries:1000, bytes_per_entry:100, keys:'0000 through 0999', write_order:'ascending numeric key'}, before, after, evicted_entries:before.entries+1-after.entries, remaining_budget_bytes:100000-after.bytes, oldest_key:oldest?.key, large_entry_bytes:(await store.get('large',1001))?.byteLength});
  }
  if (request.headers.has('X-Synthetic-Log-Failure')) {
    env = {...env, ONE_SYSTEM_LOG_BUCKET: {put: async () => {throw new Error('synthetic store failure');}}};
  }
  return gateway.fetch(request, env);
}};`;

type Event = { version: number; id: string; request_id: string; exchange_id: string; kind: string; scope: string; path: string; body_base64: string; body_complete: boolean; status?: number; cache?: string };
const decode = (record: Event) => Buffer.from(record.body_base64, 'base64').toString('utf8');

function groupedRecords(events: Event[]): Json {
  const requests = new Map<string, Map<string, Event[]>>();
  for (const event of events) {
    let exchanges = requests.get(event.request_id);
    if (!exchanges) requests.set(event.request_id, exchanges = new Map());
    let records = exchanges.get(event.exchange_id);
    if (!records) exchanges.set(event.exchange_id, records = []);
    records.push(event);
  }
  return [...requests].map(([request_id, exchanges]) => ({
    request_id,
    exchanges: [...exchanges].map(([exchange_id, records]) => ({
      exchange_id,
      records: records.sort((a, b) => a.kind.localeCompare(b.kind)).map(event => ({ ...event, body_utf8: decode(event) })),
    })),
  }));
}

export async function collectPersistenceWorker(root: string): Promise<Scenario[]> {
  const output = artifactDirectory(root, 'worker-persistence');
  const rows: Scenario[] = [];
  const record = (id: string, contract: string, observed: Json, passed: boolean) => rows.push({ id: `worker.persistence-${id}`, contract, observed, passed });
  const publicKey = 'synthetic-recording-public-key';
  const backendKey = 'synthetic-recording-backend-key';
  const answer = '{"model":"leaf","answers":{"q":{"type":"noul","noul":0.9}},"usage":{"input_tokens":7,"output_tokens":3}}';
  const incoming = '{"model":"recording-demo","state":"synthetic body canary","questions":{"q":{"type":"noul","instructions":"Synthetic?"}}}';
  const calls: string[] = [];
  const backendExchanges: {
    request: {method: string; target: string; raw_headers: string[]; body: string};
    response: {status: number; body: string};
  }[] = [];
  let rejectNext = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    calls.push(Buffer.concat(chunks).toString('utf8'));
    const status = rejectNext ? 503 : 200;
    rejectNext = false;
    const body = status === 200 ? answer : 'synthetic rejected body';
    backendExchanges.push({
      request: {method: req.method ?? '', target: req.url ?? '', raw_headers: req.rawHeaders, body: calls.at(-1)!},
      response: {status, body},
    });
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let child: ChildProcess | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('synthetic_address_missing');
    const registry = { name: 'recording-demo', selector: 'leaf', backends: [{ id: 'leaf', base_url: `http://127.0.0.1:${address.port}`, model: 'leaf', api_key_env: 'BACKEND_KEY', description: 'Synthetic local backend' }] };
    const wrapper = join(output, 'inspector.mjs');
    writeFileSync(wrapper, inspector(join(root, 'hono/dist/worker.js'), join(root, 'hono/src/cache-store-d1.ts')), {mode: 0o600});
    const config = join(output, 'wrangler.json');
    const workerConfig = { name: 'one-system-persistence-scenarios', main: wrapper, compatibility_date: '2026-09-19', workers_dev: false, observability: {enabled: false},
      vars: { ONE_SYSTEM_CONFIG_JSON: JSON.stringify(registry), ONE_SYSTEM_API_KEY: publicKey, BACKEND_KEY: backendKey, ONE_SYSTEM_CACHE_EPOCH: 'synthetic-v1' },
      d1_databases: [{ binding: 'ONE_SYSTEM_CACHE_DB', database_name: 'synthetic-decisions', database_id: '00000000-0000-0000-0000-000000000001' }],
      r2_buckets: [{ binding: 'ONE_SYSTEM_LOG_BUCKET', bucket_name: 'synthetic-history' }],
    };
    writeFileSync(config, JSON.stringify(workerConfig), {mode: 0o600});
    const fixture = {
      runtime: 'Actual local workerd with persistent D1 and R2 bindings; the backend is a synthetic loopback HTTP server.',
      configuration: {vars: workerConfig.vars, d1_databases: workerConfig.d1_databases, r2_buckets: workerConfig.r2_buckets},
      evidence: 'Operations are sequential HTTP executions. Client requests contain the supplied synthetic headers and query; backend_http_exchanges contain requests received and responses sent by the synthetic backend. Each operation lists the record IDs newly observed in R2 after its response, and their recorded request IDs. Recording is the final R2 snapshot for this scenario, grouped only by recorded request_id and exchange_id; no path, kind, scope or completeness filter is applied. Startup-readiness and prior-scenario record IDs are excluded. body_utf8 is decoded from body_base64; all original record fields remain. Credentials in fixture configuration and HTTP inputs are synthetic, not recorded-log fields.',
    };
    const port = await unusedPort();
    const base = `http://127.0.0.1:${port}`;
    const start = async () => {
      child = launch(process.execPath, [join(root, 'hono/node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', config, '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--persist-to', join(output, 'state'), '--show-interactive-dev-session=false'], output, {PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME, CI: 'true', TMPDIR: output, WRANGLER_SEND_METRICS: 'false'}, join(output, child ? 'restart.log' : 'wrangler.log'));
      await ready(child, port);
    };
    const clientRequest = (body = incoming, extra: Record<string,string> = {}) => ({
      method: 'POST', target: '/v1/systemone?private=synthetic-query-secret',
      headers: {Authorization: `Bearer ${publicKey}`, Cookie: 'synthetic-cookie-secret', 'Content-Type': 'application/json', ...extra}, body,
    });
    const post = async (body = incoming, extra: Record<string,string> = {}) => {
      const sent = clientRequest(body, extra);
      const response = await fetch(base + sent.target, {method: sent.method, headers: sent.headers, body: sent.body, signal: AbortSignal.timeout(30_000)});
      return {status: response.status, cache: response.headers.get('X-One-System-Cache'), body: await response.text()};
    };
    const allRecords = async (): Promise<Event[]> => {
      const response = await fetch(base + '/__records', {signal: AbortSignal.timeout(30_000)});
      return await response.json() as Event[];
    };
    const history = async (): Promise<Event[]> => (await allRecords()).filter(event => event.path === '/v1/systemone');
    const operations: Json[] = [];
    const recordedIDs = new Set<string>();
    let latestRecords: Event[] = [];
    const observePost = async (body = incoming, extra: Record<string,string> = {}) => {
      const callsBefore = calls.length;
      const response = await post(body, extra);
      latestRecords = await allRecords();
      const added = latestRecords.filter(event => !recordedIDs.has(event.id));
      for (const event of latestRecords) recordedIDs.add(event.id);
      operations.push({
        client_request: clientRequest(body, extra), public_response: response,
        calls_before: callsBefore, calls_after: calls.length,
        backend_http_exchanges: backendExchanges.slice(callsBefore),
        new_record_ids: added.map(event => event.id),
        recorded_request_ids: [...new Set(added.map(event => event.request_id))],
      });
      return response;
    };
    await start();
    const startupRecordIDs = new Set((await allRecords()).map(event => event.id));
    for (const id of startupRecordIDs) recordedIDs.add(id);
    const miss = await observePost();
    const hit = await observePost();
    const bypass = await observePost(incoming, {'X-One-System-Cache': 'bypass'});
    const first = await history();
    const requests = first.filter(event => event.scope === 'gateway' && event.kind === 'request');
    const responses = first.filter(event => event.scope === 'gateway' && event.kind === 'response');
    const upstream = first.filter(event => event.scope === 'backend');
    const pairs = requests.map(request => ({request, response: responses.find(response => response.request_id === request.request_id && response.exchange_id === request.exchange_id)}));
    const exact = pairs.every(({request, response}) => request.body_complete && decode(request) === incoming && response?.body_complete && [miss.body, hit.body, bypass.body].includes(decode(response)));
    record('cache-and-recording', 'With D1 caching and R2 recording enabled, an initial valid request infers once, an identical hit skips inference and reports zero new input/output tokens, and explicit bypass infers once without reading or writing the cache. Each operation must append its own exact gateway request/response pair; each actual backend call must append a separate correlated pair. The original miss and backend response records retain their original bytes and nonzero usage; the later hit gateway response records its own zero-usage replay, not the original billed usage. Recorded metadata must omit all headers and URL queries; request and response bodies are retained unredacted.', {
      fixture, operations: operations.slice(),
      recording: groupedRecords(latestRecords.filter(event => !startupRecordIDs.has(event.id))),
    }, miss.status === 200 && miss.cache === 'miss' && hit.status === 200 && hit.cache === 'hit' && bypass.cache === 'bypass' && calls.length === 2 && requests.length === 3 && responses.length === 3 && upstream.length === 4 && exact && upstream.filter(event => event.kind === 'response').every(event => decode(event) === answer) && JSON.parse(hit.body).usage.input_tokens === 0 && [publicKey, backendKey, 'synthetic-cookie-secret', 'synthetic-query-secret'].every(secret => !JSON.stringify(first).includes(secret)));
    const firstRecordIDs = new Set(latestRecords.map(event => event.id));

    rejectNext = true;
    const callsBeforeErrors = calls.length;
    const errorOperationsStart = operations.length;
    const rejected = await observePost(incoming, {'X-One-System-Cache': 'bypass'});
    const callsAfterRejected = calls.length;
    const malformed = await observePost('{broken');
    const callsAfterMalformed = calls.length;
    const denied = await observePost(incoming, {Authorization: 'Bearer wrong'});
    const errors = (await history()).filter(event => !first.some(old => old.id === event.id));
    record('errors', 'With recording enabled, the rejected bypass request must make one backend call without retry, retain the bounded raw 503 upstream response in its backend exchange, and separately record and return a sanitized 503 upstream_rejected gateway response without the private upstream body. Malformed JSON must return 422 schema_validation and a wrong bearer credential must return 401 unauthorized, each with its own gateway request/response pair and no backend call. Stored records must preserve the received body bytes and completeness while omitting headers and URL queries.', {
      fixture, operations: operations.slice(errorOperationsStart),
      recording: groupedRecords(latestRecords.filter(event => !firstRecordIDs.has(event.id))),
    }, rejected.status === 503 && malformed.status === 422 && denied.status === 401 && callsAfterRejected === callsBeforeErrors + 1 && callsAfterMalformed === callsAfterRejected && calls.length === callsAfterMalformed && errors.filter(event => event.scope === 'gateway').length === 6 && errors.some(event => event.scope === 'backend' && event.kind === 'response' && event.status === 503 && event.body_complete && decode(event) === 'synthetic rejected body'));

    const countBeforeFailure = calls.length;
    const failed = await post(incoming, {'X-Synthetic-Log-Failure': 'yes'});
    record('write-failure', 'An inaccessible configured recording store must return 503 logging_unavailable before inference, including requests that could otherwise be cache hits.', {
      input: {request_body: incoming, injected_storage_failure: 'R2 put throws before writing', prior_identical_cache_hit: hit},
      response: failed, calls_before: countBeforeFailure, calls_after: calls.length,
    }, failed.status === 503 && JSON.parse(failed.body).detail[0].type === 'logging_unavailable' && calls.length === countBeforeFailure);

    const large = JSON.stringify({...JSON.parse(incoming), state: 'x'.repeat(2 << 20)});
    const largeResponse = await post(large);
    const largeRequest = (await history()).find(event => event.scope === 'gateway' && event.kind === 'request' && decode(event) === large);
    record('large-body', 'An accepted request exceeding D1 row size must still be recorded completely in R2, not silently skipped or truncated.', {request_bytes: Buffer.byteLength(large), stored_decoded_bytes: largeRequest ? Buffer.from(largeRequest.body_base64, 'base64').length : 0, stored_complete: largeRequest?.body_complete ?? false, response: largeResponse, request_body_matches: largeRequest !== undefined}, largeResponse.status === 200 && largeRequest?.body_complete === true);

    const beforeRestart = await history();
    const processBeforeRestart = child!.pid;
    const callsBeforeRestart = calls.length;
    await stop(child!);
    await start();
    const restarted = await post();
    const restored = await history();
    record('restart', 'Both D1 decisions and R2 history survive a Worker restart: the identical request hits without upstream inference and appends a new gateway pair without replacing earlier events.', {
      request_before_restart: incoming, request_after_restart: incoming,
      process_before: processBeforeRestart ?? null, process_after: child!.pid ?? null,
      response: restarted, calls_before: callsBeforeRestart, calls_after: calls.length,
      prior_event_ids: beforeRestart.map(event => event.id), restored_event_ids: restored.map(event => event.id),
      prior_event_count: beforeRestart.length, restored_event_count: restored.length,
      prior_ids_preserved: beforeRestart.every(old => restored.some(event => event.id === old.id)),
    }, restarted.cache === 'hit' && calls.length === 4 && calls.length === callsBeforeRestart && restored.length === beforeRestart.length + 2 && beforeRestart.every(old => restored.some(event => event.id === old.id)));
    await fetch(base + '/__expire', {method: 'POST'});
    const afterEviction = await history();
    const newMiss = await post();
    record('independent-retention', 'Removing cached decisions must not delete recording history; the next identical request infers again rather than treating history as a cache.', {history_before: restored.length, history_after_cache_clear: afterEviction.length, prior_ids_preserved: restored.every(old => afterEviction.some(event => event.id === old.id)), response: newMiss, upstream_call_count: calls.length}, afterEviction.length === restored.length && restored.every(old => afterEviction.some(event => event.id === old.id)) && newMiss.cache === 'miss' && calls.length === 5);
    const capacityResponse = await fetch(base + '/__cache-budget', {signal: AbortSignal.timeout(30_000)});
    const capacity = await capacityResponse.json() as {budget: number; inserted_bytes: number; before: {entries: number; bytes: number}; after: {entries: number; bytes: number}; oldest_key: string; large_entry_bytes: number};
    record('capacity-large-insert', 'A successful D1 cache insertion must enforce its payload byte budget even when more than 512 older small entries must be evicted. Evict oldest-written entries first and retain the new in-budget response.', capacity,
      capacityResponse.status === 200 && capacity.before.entries === 1000 && capacity.before.bytes === 100000 && capacity.after.bytes === capacity.budget && capacity.after.entries === 101 && capacity.oldest_key === '0900' && capacity.large_entry_bytes === capacity.inserted_bytes);
    writeFileSync(join(output, 'observations.json'), JSON.stringify(rows, null, 2), {mode: 0o600});
    return rows;
  } finally {
    try { if (child) await stop(child); } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}
