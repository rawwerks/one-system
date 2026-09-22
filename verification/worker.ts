import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Json } from './semantic.ts';
import type { Scenario } from './scenarios.ts';
import { collectPersistenceWorker } from './persistence-worker.ts';

export function artifactDirectory(root: string, prefix: string): string {
  const base = join(root, '.build/scenarios');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(base, `${prefix}-`));
}
export async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback_port_unavailable'); // ubs:ignore -- Narrows Node's public address union; no credential comparison.
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
export function launch(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string): ChildProcess {
  const fd = openSync(log, 'wx', 0o600);
  try {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', fd, fd], detached: true });
    // Preserve spawn failures as observable process state without an unhandled event.
    child.on('error', () => {});
    return child;
  } finally { closeSync(fd); }
}
export async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const signal = (value: NodeJS.Signals) => { try { process.kill(-child.pid!, value); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
  signal('SIGTERM');
  for (let attempt = 0; attempt < 100 && child.exitCode === null && child.signalCode === null; attempt++) await delay(50);
  if (child.exitCode === null && child.signalCode === null) {
    signal('SIGKILL');
    for (let attempt = 0; attempt < 100 && child.exitCode === null && child.signalCode === null; attempt++) await delay(50);
    if (child.exitCode === null && child.signalCode === null) throw new Error('scenario_process_shutdown_failed');
  }
}
export async function request(port: number, path: string, key?: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port, path,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }) },
    }, incoming => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 << 20) incoming.destroy(new Error('scenario_response_too_large'));
        else chunks.push(chunk);
      });
      incoming.on('error', reject);
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(60_000, () => outgoing.destroy(new Error('scenario_request_timeout')));
    outgoing.end(body);
  });
}
export async function ready(child: ChildProcess, port: number, milliseconds = 45_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('scenario_service_exited');
    try { await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(500) }); return; } catch { await delay(100); }
  }
  throw new Error('scenario_service_not_ready');
}
const PUBLIC_KEY = 'synthetic-public-key';
const BACKEND_KEY = 'synthetic-private-backend-key';
const MODEL = 'synthetic-worker-upstream';
const QUESTIONS = '{"__proto__":{"type":"noul","instructions":"Evaluate synthetic evidence."}}';
const STATE = '{"big":9007199254740993,"decimal":0.123456789012345678901,"exponent":1.2300e-5,"unicode":"é🧪"}';
const ANSWER = '{"model":"synthetic-worker-upstream","answers":{"__proto__":{"type":"noul","noul":0.123456789012345678901}},"usage":{"input_tokens":7,"output_tokens":3}}';
const CAUSE = 'synthetic-upstream-proxy-cause-do-not-disclose';

export async function collectWorker(root: string): Promise<Scenario[]> {
  const output = artifactDirectory(root, 'worker');
  const captures: { path: string; authorization: string | null; content_length: string | null; transfer_encoding: string | null; body: string; body_utf8_bytes: number }[] = [];
  const upstreamResponses: { status: number; body: string }[] = [];
  const backend = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 8 << 20) throw new Error('synthetic_body_too_large'); chunks.push(Buffer.from(chunk)); }
      captures.push({ path: req.url ?? '', authorization: req.headers.authorization ?? null, content_length: req.headers['content-length'] ?? null, transfer_encoding: req.headers['transfer-encoding'] ?? null, body: Buffer.concat(chunks).toString('utf8'), body_utf8_bytes: size });
      const status = captures.length === 1 ? 200 : captures.length === 2 ? 407 : 421;
      const body = status === 200 ? ANSWER : CAUSE;
      upstreamResponses.push({ status, body });
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    } catch { res.destroy(); }
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  let child: ChildProcess | undefined;
  const result: Scenario[] = [];
  const record = (id: string, contract: string, observed: Json, passed: boolean) => result.push({ id: `worker.${id}`, contract, observed, passed });
  try {
    const address = backend.address();
    if (!address || typeof address === 'string') throw new Error('backend_address_missing'); // ubs:ignore -- Narrows Node's public address union; no credential comparison.
    const port = await unusedPort();
    const registry = { name: 'routing-demo', selector: 'synthetic', backends: [{ id: 'synthetic', base_url: `http://127.0.0.1:${address.port}`, model: MODEL, api_key_env: 'SYNTHETIC_BACKEND_KEY', description: 'Synthetic loopback backend', capabilities: { question_types: ['noul'] } }] };
    const config = join(output, 'wrangler.json');
    writeFileSync(config, JSON.stringify({ name: 'one-system-local-scenarios', main: join(root, 'hono/dist/worker.js'), compatibility_date: '2026-09-19', no_bundle: true, workers_dev: false, observability: { enabled: false }, vars: { ONE_SYSTEM_CONFIG_JSON: JSON.stringify(registry), ONE_SYSTEM_API_KEY: PUBLIC_KEY, SYNTHETIC_BACKEND_KEY: BACKEND_KEY } }), { mode: 0o600 });
    child = launch(process.execPath, [join(root, 'hono/node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', config, '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--persist-to', join(output, 'state'), '--show-interactive-dev-session=false'], output, { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME, CI: 'true', TMPDIR: output, WRANGLER_SEND_METRICS: 'false' }, join(output, 'wrangler.log'));
    await ready(child, port);
    for (const [label, key, expected] of [['unauthenticated', undefined, 401], ['wrong-key', 'wrong-synthetic-key', 401], ['authorized', PUBLIC_KEY, 200]] as const) {
      const response = await request(port, '/v1/models', key);
      record(`models-${label}`, 'GET /v1/models requires the configured bearer credential: a missing or incorrect credential must return 401 unauthorized without exposing the catalogue. Only an authenticated request returns 200 with the configured registry name first, followed by sorted backend IDs.', { configuration: { registry_name: registry.name, backend_ids: registry.backends.map(backend => backend.id), public_api_key: PUBLIC_KEY }, request: { method: 'GET', path: '/v1/models', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) } }, response }, response.status === expected && (expected !== 200 || JSON.stringify(JSON.parse(response.body).models.map((model: {name:string}) => model.name)) === JSON.stringify([registry.name, 'synthetic'])));
    }
    const discovery = await request(port, '/v1/capabilities', PUBLIC_KEY);
    record('capability-discovery', 'Capability discovery must report the synthetic backend supports only noul.', { registry: registry.backends.map(({ id, capabilities }) => ({ id, capabilities })), response: discovery }, discovery.status === 200 && JSON.stringify(JSON.parse(discovery.body)) === JSON.stringify({ version: 1, models: [{ name: 'synthetic', capabilities: { question_types: ['noul'] } }] }));
    for (const model of [registry.name, 'synthetic']) {
      const response = await request(port, '/v1/systemone', PUBLIC_KEY, JSON.stringify({ model, state: 'x', questions: { q: { type: 'choice', criteria: { a: 'A', b: 'B' } } } }));
      record(`hard-capability-${model}`, 'Unsupported Choice must return 422 unsupported_capability without contacting upstream, for automatic and direct routing.', { requested_model: model, requested_type: 'choice', supported_types: ['noul'], response, upstream_calls: captures.length }, response.status === 422 && JSON.parse(response.body).detail[0].type === 'unsupported_capability' && captures.length === 0);
    }
    const raw = `{"model":"${registry.name}","state":${STATE},"questions":${QUESTIONS}}`;
    const response = await request(port, '/v1/systemone', PUBLIC_KEY, raw);
    const captured = captures[0];
    record('routed-post', 'Singleton routing preserves raw state, questions, numeric answer lexemes and opaque keys, rewrites only the model, uses backend credentials, and sends fixed UTF-8 Content-Length.', { request: raw, response, upstream: captures.slice() }, response.status === 200 && response.body === ANSWER && captures.length === 1 && captured.path === '/v1/systemone' && captured.authorization === `Bearer ${BACKEND_KEY}` && captured.content_length === String(Buffer.byteLength(captured.body)) && captured.transfer_encoding === null && !captured.body.includes(PUBLIC_KEY) && captured.body.includes(STATE) && captured.body.includes(QUESTIONS) && JSON.parse(captured.body).model === MODEL);
    for (const [upstreamStatus, expectedStatus, errorType, message, model] of [[407, 502, 'upstream_unavailable', 'Upstream request failed', 'synthetic'], [421, 421, 'upstream_rejected', 'Upstream could not complete the request', registry.name]] as const) {
      const before = captures.length;
      const sent = raw.replace(`"${registry.name}"`, `"${model}"`);
      const response = await request(port, '/v1/systemone', PUBLIC_KEY, sent);
      const last = captures.at(-1);
      record(`upstream-${upstreamStatus}`, `An upstream ${upstreamStatus} must produce a client-facing ${expectedStatus} response with canonical sanitized ${errorType}, with no retry. The public response body must omit the private upstream body and both credentials; the captured backend request must use the configured backend credential and fixed-length framing. Credentials in the synthetic input fixture or captured backend request are not client-facing disclosure.`, { client_request: { path: '/v1/systemone', authorization: `Bearer ${PUBLIC_KEY}`, body: sent }, upstream_requests: captures.slice(before), upstream_responses: upstreamResponses.slice(before), public_response: response }, response.status === expectedStatus && JSON.stringify(JSON.parse(response.body)) === JSON.stringify({ detail: [{ loc: ['body'], msg: message, type: errorType }] }) && [CAUSE, PUBLIC_KEY, BACKEND_KEY].every(secret => !response.body.includes(secret)) && captures.length === before + 1 && last?.authorization === `Bearer ${BACKEND_KEY}` && last.content_length === String(Buffer.byteLength(last.body)) && last.transfer_encoding === null);
    }
    result.push(...await collectPersistenceWorker(root));
    writeFileSync(join(output, 'observations.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    return result;
  } finally {
    try { if (child) await stop(child); } finally { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); }
  }
}
