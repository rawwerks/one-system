#!/usr/bin/env node
/** Advisory dogfooding: send changed sources through One System to pinned Jev once. */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const MAX_SOURCE_BYTES = 256 * 1024;
const base = process.env.BASE || 'HEAD';
const questionsPath = resolve(root, process.env.QUESTIONS || 'examples/agent-review.questions.json');

// Only tracked or staged paths are ever sent, including under FILES: never
// untracked or ignored files such as .env. -z keeps non-ASCII names unquoted.
function changedFiles(): string[] {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  if (process.env.FILES) {
    const requested = process.env.FILES.split(/\s+/).filter(Boolean);
    const tracked = new Set(git('ls-files', '-z', '--cached', '--', ...requested));
    for (const path of requested.filter(path => !tracked.has(path))) console.error(`review: skipping ${path} (not a tracked file)`);
    return requested.filter(path => tracked.has(path));
  }
  return [...new Set([...git('diff', '-z', '--name-only', '--diff-filter=d', base), ...git('diff', '-z', '--name-only', '--cached', '--diff-filter=A')])].sort();
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  await new Promise<void>(done => server.close(() => done()));
  if (!address || typeof address === 'string') throw new Error('gateway_port_unavailable');
  return address.port;
}

if (!process.env.TYPESAFE_API_KEY) {
  console.error('review: TYPESAFE_API_KEY is required (hosted Jev evaluates the sources; calls may incur charges).');
  process.exit(2);
}
const sources: Record<string, string> = {};
for (const path of changedFiles()) {
  const file = resolve(root, path);
  if (relative(root, file).startsWith('..')) { console.error(`review: ${path} is outside the repository`); process.exit(2); }
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile()) continue;
  if (info.size > MAX_SOURCE_BYTES) { console.error(`review: skipping ${path} (${info.size} bytes > ${MAX_SOURCE_BYTES})`); continue; }
  const content = readFileSync(file);
  if (content.includes(0)) continue; // binary
  sources[path] = content.toString('utf8');
}
if (!Object.keys(sources).length) { console.log(`review: no changed text files against ${base}.`); process.exit(0); }

const output = join(root, '.build/review', `${Date.now()}-${randomBytes(3).toString('hex')}`);
mkdirSync(output, { recursive: true, mode: 0o700 });
const port = await unusedPort();
const key = randomBytes(32).toString('hex');
const log = openSync(join(output, 'gateway.log'), 'wx', 0o600);
const gateway = spawn(join(root, '.build/one-system'), [], { cwd: root, stdio: ['ignore', log, log], env: {
  ONE_SYSTEM_CONFIG: join(root, 'examples/jev-lint.backends.json'), ONE_SYSTEM_ADDR: `127.0.0.1:${port}`,
  ONE_SYSTEM_API_KEY: key, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
} });
closeSync(log);
const endpoint = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let i = 0; i < 100 && !ready && gateway.exitCode === null; i++) {
    ready = await fetch(`${endpoint}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(500) })
      .then(response => response.ok, () => false);
    if (!ready) await new Promise(done => setTimeout(done, 25));
  }
  if (!ready) throw new Error(`gateway did not start; see ${output}/gateway.log`);
  const questions = JSON.parse(readFileSync(questionsPath, 'utf8'));
  const request = JSON.stringify({ model: 'hosted', state: { sources }, questions });
  writeFileSync(join(output, 'request.json'), request, { mode: 0o600 });
  console.log(`review: sending ${Object.keys(sources).length} file(s) against ${base} to pinned Jev: ${Object.keys(sources).join(', ')}`);
  const response = await fetch(`${endpoint}/v1/systemone`, {
    method: 'POST', body: request, redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  });
  const body = await response.text();
  writeFileSync(join(output, 'response.json'), body, { mode: 0o600 });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
  const { model, answers, usage } = JSON.parse(body);
  console.log(`review: ${model}, ${usage?.input_tokens ?? '?'} input tokens. Advisory signals, not a gate:`); // ubs:ignore — token count, not a credential.
  for (const [id, answer] of Object.entries<any>(answers)) {
    const flag = answer.choice === 'violation' ? '!!' : answer.choice === 'clear' ? 'ok' : '??';
    console.log(`  ${flag} ${id}: ${answer.choice} (confidence ${Number(answer.confidence).toFixed(2)})`);
  }
  console.log(`review: request/response saved in ${relative(root, output)}/ (private; may contain source).`);
} catch (error) {
  console.error(`review: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  if (gateway.exitCode === null) {
    await new Promise<void>(done => { gateway.once('exit', () => done()); gateway.kill('SIGTERM'); });
  }
}
