#!/usr/bin/env node
/**
 * Advisory dogfooding, jevify-style: a frozen rubric, one System One request per
 * changed file sent in parallel through the composition runtime, a fixed
 * escalation rule, and a report of counts plus the files to read. Never a gate.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { component, run } from '../composition/runtime.mts';
import { ask, type Connection, type Json, type Questions, type SystemOneResponse } from '../composition/system-one.mts';

// Frozen before any data is read; changing any of these invalidates earlier verdicts.
export const CAP = 24_000;
/** Probability at or above which a noul, or the non-clear labels of a choice, needs reading. */
export const RISK_FLAG = 0.3;
/**
 * Choice labels that need no reading. Uncertainty between two clear labels is not
 * risk; a choice is flagged when its answer is not clear or its non-clear labels
 * together carry at least RISK_FLAG.
 */
export const CLEAR: Record<string, readonly string[]> = { scope: ['belongs'], weakens_checks: ['none', 'accounted'] };
const LOCKFILE = /(^|\/)(bun\.lock|package-lock\.json|uv\.lock|go\.sum|requirements\.lock)$/;

export interface Unit { file: string; state: Json; truncated: boolean }
export type Verdict = { file: string; answers?: SystemOneResponse['answers']; error?: string; usage?: SystemOneResponse['usage'] };

/** Deterministic exclusions that are never judged: deleted files and lockfiles. */
export function prefilter(file: string, status: string): string | null {
  if (status.startsWith('D')) return 'deleted';
  if (LOCKFILE.test(file)) return 'lockfile';
  return null;
}

export function unit(file: string, change: readonly string[], diff: string): Unit {
  const truncated = diff.length > CAP;
  return { file, truncated, state: { file, change: [...change], diff: truncated ? `${diff.slice(0, CAP)}\n[truncated: ${diff.length - CAP} more characters]` : diff } };
}

/** Why a verdict needs a person to read the file, or [] when it does not. */
export function reasons(verdict: Verdict): string[] {
  if (verdict.error || !verdict.answers) return [`error: ${verdict.error ?? 'no answers'}`];
  const out: string[] = [];
  for (const [id, answer] of Object.entries(verdict.answers)) {
    const { choice, probabilities, noul } = answer as { choice?: string; probabilities?: Record<string, number>; noul?: number };
    if (typeof choice === 'string') {
      const clear = CLEAR[id] ?? [];
      const risk = Object.entries(probabilities ?? {}).filter(([label]) => !clear.includes(label)).reduce((sum, [, p]) => sum + p, 0);
      if (!clear.includes(choice)) out.push(`${id}=${choice}`);
      else if (risk >= RISK_FLAG) out.push(`${id} at risk (${risk.toFixed(2)} on ${Object.keys(probabilities ?? {}).filter(label => !clear.includes(label)).join('/')})`);
    } else if (typeof noul === 'number' && noul >= RISK_FLAG) out.push(`${id} ${noul.toFixed(2)}`);
  }
  return out;
}

/** One request per unit, all in flight together; failures stay in their row. */
export async function judgeUnits(connection: Connection, model: string, units: readonly Unit[], questions: Questions): Promise<Verdict[]> {
  if (!units.length) return [];
  const judgeFile = component<Unit, Verdict>('judge-file', (item, scope) => scope.effect(signal =>
    ask(connection, { model, state: item.state, questions }, signal).then(
      response => ({ file: item.file, answers: response.answers, usage: response.usage }),
      (error: unknown) => ({ file: item.file, error: error instanceof Error ? error.message : String(error) }))));
  const all = component<readonly Unit[], Verdict[]>('review', (items, scope) =>
    scope.all(items.map(input => ({ component: judgeFile, input }))));
  return run(all, units, { allow: [judgeFile], maxCalls: units.length + 1, maxEffects: units.length, concurrency: 8, timeoutMs: 600_000 });
}

export function report(verdicts: readonly Verdict[], skipped: Record<string, number>, truncated: number): string {
  const count = (values: string[]) => Object.entries(values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {}))
    .map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  const judged = verdicts.filter(v => v.answers);
  const tokens = judged.reduce((sum, v) => sum + (v.usage?.input_tokens ?? 0), 0);
  const choiceIds = [...new Set(judged.flatMap(v => Object.entries(v.answers!).filter(([, a]) => typeof (a as { choice?: unknown }).choice === 'string').map(([id]) => id)))];
  const noulIds = [...new Set(judged.flatMap(v => Object.entries(v.answers!).filter(([, a]) => typeof (a as { noul?: unknown }).noul === 'number').map(([id]) => id)))];
  const flagged = verdicts.map(v => ({ file: v.file, why: reasons(v) })).filter(v => v.why.length);
  return [
    `review: ${verdicts.length} files judged, ${verdicts.length - judged.length} errors; skipped ${count(Object.entries(skipped).flatMap(([k, n]) => Array(n).fill(k)))}; ${truncated} truncated; ${tokens} input tokens`,
    ...choiceIds.map(id => `${id}: ${count(judged.map(v => String((v.answers![id] as { choice?: string } | undefined)?.choice ?? '?')))}`),
    ...noulIds.map(id => `${id} >= ${RISK_FLAG}: ${judged.filter(v => ((v.answers![id] as { noul?: number }).noul ?? 0) >= RISK_FLAG).length}`),
    flagged.length ? `read these ${flagged.length} (advisory; confirm each against the code):` : 'nothing flagged (advisory; not a correctness certificate)',
    ...flagged.map(({ file, why }) => `  ${file}: ${why.join('; ')}`),
  ].join('\n');
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  await new Promise<void>(done => server.close(() => done()));
  if (!address || typeof address === 'string') throw new Error('gateway_port_unavailable');
  return address.port;
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (process.env.REPORT) {
    // Re-apply the escalation rule to saved verdicts; no new inference.
    const saved = JSON.parse(readFileSync(resolve(root, process.env.REPORT), 'utf8')) as { verdicts: Verdict[] };
    console.log(report(saved.verdicts, {}, 0));
    return;
  }
  const base = process.env.BASE || 'origin/main';
  const questions = JSON.parse(readFileSync(resolve(root, process.env.QUESTIONS || 'verification/review.questions.json'), 'utf8')) as Questions;
  if (!process.env.TYPESAFE_API_KEY) {
    console.error('review: TYPESAFE_API_KEY is required (hosted Jev judges each file; calls may incur charges).');
    process.exit(2);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // Tracked changes against BASE, including uncommitted and staged work; never untracked files.
  const entries = git('diff', '-z', '--name-status', '--no-renames', base).split('\0').filter(Boolean);
  // Full commit messages: bodies explain moves and removals a single-file diff cannot show.
  const change = git('log', '--format=%B%x00', `${base}..HEAD`).split('\0').map(message => message.trim()).filter(Boolean);
  const skipped: Record<string, number> = {};
  const units: Unit[] = [];
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const [status, file] = [entries[i]!, entries[i + 1]!];
    const why = prefilter(file, status);
    if (why) { skipped[why] = (skipped[why] ?? 0) + 1; continue; }
    const diff = git('diff', '--no-color', base, '--', file);
    if (diff.includes('Binary files')) { skipped.binary = (skipped.binary ?? 0) + 1; continue; }
    units.push(unit(file, change, diff));
  }
  if (!units.length) { console.log(`review: nothing to judge against ${base}.`); return; }

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
  const connection = { endpoint: `http://127.0.0.1:${port}`, apiKey: key };
  try {
    let ready = false;
    for (let i = 0; i < 200 && !ready && gateway.exitCode === null; i++) {
      ready = await fetch(`${connection.endpoint}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(500) })
        .then(response => response.ok, () => false);
      if (!ready) await new Promise(done => setTimeout(done, 25));
    }
    if (!ready) throw new Error(`gateway did not start; see ${output}/gateway.log`);
    console.log(`review: judging ${units.length} files changed since ${base} with pinned Jev, 8 at a time...`);
    const verdicts = await judgeUnits(connection, 'hosted', units, questions);
    writeFileSync(join(output, 'verdicts.json'), JSON.stringify({ base, change, questions, verdicts }, null, 2), { mode: 0o600 });
    console.log(report(verdicts, skipped, units.filter(u => u.truncated).length));
    console.log(`review: verdicts saved in ${relative(root, output)}/ (private; may contain source).`);
  } catch (error) {
    console.error(`review: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  } finally {
    if (gateway.exitCode === null) await new Promise<void>(done => { gateway.once('exit', () => done()); gateway.kill('SIGTERM'); });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
