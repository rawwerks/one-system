#!/usr/bin/env node
/** One command: native execution, graph-bound evidence, System One judgments. */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { completion, current, hash, loadObligations, observations, read, selfObservations, snapshot } from './evidence.ts';
import { batches, collect, coreGroups, requireObligations, scenarioStatus, scenarioQuestions, semanticRows, type Scenario } from './scenarios.ts';
import { compose, evaluate } from './semantic.ts';
import type { Json } from './semantic.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const model = 'jev-1.13.0';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: make verify [VERIFY_ARGS="--native-only"]

Runs native checks, true-up dependencies, both HTTP implementations, and pinned
System One semantic checks. Requires prepared developer tools and TYPESAFE_API_KEY.
Starts a temporary authenticated review gateway; never sends real credentials as state.
--native-only runs offline checks and records semantic not_run (exit 2: incomplete).
--include-laya also requires observations from the installed local adapter/checkpoint.
--output NAME uses a new .build/verification/NAME directory (never overwrites).

Runner exit codes (make maps any nonzero result to 2):
Exit 0: native checks pass and declared semantic checks return clear.
Exit 1: native/check failure. Exit 2: missing/stale/unresolved evidence.
Exit 3: semantic finding needs review. A clear result is limited to these checks.
Artifacts include source hashes, graph, observations, exact model bodies and report.
See verification/README.md. No install, deployment, or source repair is performed.`);
  process.exit(0);
}
let nativeOnly = false;
let includeLaya = false;
let name = `${Date.now()}-${randomBytes(4).toString('hex')}`;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--native-only') nativeOnly = true; // ubs:ignore — public CLI option, not a secret comparison.
  else if (args[i] === '--include-laya') includeLaya = true; // ubs:ignore — public CLI option.
  else if (args[i] === '--output' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(args[i + 1] ?? '')) name = args[++i]; // ubs:ignore — public CLI option, not a secret comparison.
  else { console.error('Invalid verification option. Run make verify-help.'); process.exit(2); }
}
const output = join(root, '.build/verification', name);
mkdirSync(join(root, '.build/verification'), { recursive: true, mode: 0o700 });
try { mkdirSync(output, { mode: 0o700 }); }
catch { console.error('Verification output must be a new directory.'); process.exit(2); }
const save = (path: string, value: unknown) => writeFileSync(join(output, path), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const report: any = { version: 1, status: 'incomplete', scope: 'Full native development checks; declared semantic obligations only.',
  started_at: new Date().toISOString(), evaluator: model, native: { status: 'not_run' }, obligations: [], fresh: false };

async function command(command: string, argv: string[], env: NodeJS.ProcessEnv, log: string) {
  const fd = openSync(join(output, log), 'wx', 0o600);
  try {
    return await new Promise<number>((done, reject) => {
      const child = spawn(command, argv, { cwd: root, env, stdio: ['ignore', fd, fd], timeout: 600_000 });
      child.once('error', reject);
      child.once('exit', code => done(code ?? 1));
    });
  } finally { closeSync(fd); }
}

async function reviewGateway() {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('gateway_port_unavailable');
  const port = address.port;
  await new Promise<void>(done => server.close(() => done()));
  const key = randomBytes(32).toString('hex');
  const fd = openSync(join(output, 'gateway.log'), 'wx', 0o600);
  const child = spawn(join(root, '.build/one-system'), [], { cwd: root, stdio: ['ignore', fd, fd], env: {
    ONE_SYSTEM_CONFIG: join(root, 'examples/jev-lint.backends.json'), ONE_SYSTEM_ADDR: `127.0.0.1:${port}`,
    ONE_SYSTEM_API_KEY: key, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  } });
  closeSync(fd);
  let failed = false;
  child.once('error', () => { failed = true; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null || failed) return;
    await new Promise<void>(done => { child.once('exit', () => done()); child.kill('SIGTERM'); });
  };
  try {
    for (let i = 0; i < 100; i++) {
      if (failed || child.exitCode !== null) throw new Error('review_gateway_failed');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
          headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(500), redirect: 'error',
        });
        const data = await response.json() as any;
        if (response.ok && data.models?.some((m: any) => m.name === 'hosted')) return { endpoint: `http://127.0.0.1:${port}/v1/systemone`, key, stop }; // ubs:ignore — model ID comparison; the generated bearer is never compared here.
      } catch { /* Readiness is bounded; evaluation itself is never retried. */ }
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error('review_gateway_unavailable');
  } catch (error) { await stop(); throw error; }
}

try {
  const before = snapshot(root);
  save('source-before.json', before);
  const trueUp = process.env.TRUE_UP || 'true-up';
  const graphResult = JSON.parse(execFileSync(trueUp, ['build', '--no-write', '--json'], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }));
  if (!graphResult.ok || !graphResult.graph) throw new Error('invalid_dependency_graph');
  save('graph.json', graphResult);
  const obligations = loadObligations(root, graphResult.graph).filter(o => includeLaya || o.spec.evidence !== 'laya');
  requireObligations(obligations.map(o => o.spec.evidence), includeLaya);
  report.profile = includeLaya ? 'core-and-laya' : 'core';
  report.obligations = obligations.map(o => ({ id: o.spec.id, status: 'not_run' }));
  const traces = join(output, 'observations');
  mkdirSync(traces, { mode: 0o700 });
  console.log('Native checks: executing both gateways and verification tests…');
  const scenarioDirectory = join(output, 'scenarios');
  mkdirSync(scenarioDirectory, { mode: 0o700 });
  const nativeEnv: NodeJS.ProcessEnv = { ...process.env, ONE_SYSTEM_VERIFY_EVIDENCE_DIR: traces, ONE_SYSTEM_SCENARIO_EVIDENCE_DIR: scenarioDirectory };
  delete nativeEnv.TYPESAFE_API_KEY;
  delete nativeEnv.ONE_SYSTEM_API_KEY;
  const exit = await command('make', ['check-dev', 'true-up-check', 'check-secrets'], nativeEnv, 'native.log');
  report.native = { status: exit === 0 ? 'passed' : 'failed', command: ['make', 'check-dev', 'true-up-check', 'check-secrets'], exit, log: 'native.log' };
  if (exit !== 0) {
    report.status = 'failed';
  } else {
    const records = readdirSync(traces).sort().map(path => JSON.parse(read(traces, path)));
    const fixture = JSON.parse(read(root, 'contract/cases/capability-verification.json'));
    const observed = observations(records, fixture);
    const self = selfObservations();
    save('self-observations.json', self);
    const scenarioEvidence: Record<string, Scenario[]> = {};
    for (const group of coreGroups) {
      const envelope = JSON.parse(read(scenarioDirectory, `${group}.json`));
      if (envelope.version !== 1 || envelope.group !== group || scenarioStatus(envelope.rows) !== 'passed') throw new Error('invalid_scenario_evidence');
      scenarioEvidence[group] = envelope.rows;
    }
    if (includeLaya) {
      const rows = await collect('laya', root);
      const status = scenarioStatus(rows);
      save('scenarios/laya.json', { version: 1, group: 'laya', status, rows });
      scenarioEvidence.laya = rows;
      if (status === 'failed') { report.native.status = 'failed'; throw new Error('laya_scenario_failed'); }
    }
    const jobs = obligations.flatMap(obligation => {
      const kind = obligation.spec.evidence; // ubs:ignore — public evidence category, not a secret.
      const inputs = kind === 'capabilities' ? [observed] : kind === 'self' ? [self] : batches(semanticRows(scenarioEvidence[kind])); // ubs:ignore — public evidence category comparisons.
      return inputs.map((rows, i) => ({ ...obligation, rows, id: inputs.length === 1 ? obligation.spec.id : `${obligation.spec.id}.${i + 1}`,
        questions: kind === 'capabilities' || kind === 'self' ? obligation.spec.questions : scenarioQuestions(obligation.spec.questions, rows),
        available: !scenarioEvidence[kind] || scenarioStatus(scenarioEvidence[kind]) === 'passed' }));
    });
    report.obligations = jobs.map(job => ({ id: job.id, status: 'not_run', cases: job.rows.length }));
    if (!current(before, snapshot(root))) throw new Error('source_changed_during_native_checks');
    if (!nativeOnly && process.env.TYPESAFE_API_KEY) {
      const gateway = await reviewGateway();
      try {
        await Promise.all(jobs.map(async (obligation, index) => {
          if (!obligation.available) { report.obligations[index].reason = 'scenario_evidence_incomplete'; return; }
          const state = { ...obligation.state, observations: obligation.rows } as Json;
          const directory = obligation.id;
          mkdirSync(join(output, directory), { mode: 0o700 });
          save(`${directory}/input.json`, { state, questions: obligation.questions });
          const receipt: Record<string, string | number> = {};
          try {
            const result = await evaluate({ endpoint: gateway.endpoint, apiKey: gateway.key, model: 'hosted', expectedModel: model, state, questions: obligation.questions,
              onWire(wire) {
                const response = wire.responseBody !== undefined;
                const body = response ? wire.responseBody! : wire.requestBody;
                writeFileSync(join(output, directory, response ? 'response.json' : 'request.json'), body, { mode: 0o600, flag: 'wx' });
                receipt[response ? 'response_sha256' : 'request_sha256'] = hash(body);
                if (wire.responseStatus !== undefined) receipt.response_status = wire.responseStatus;
              },
            });
            report.obligations[index] = { id: obligation.id, cases: obligation.rows.length, ...receipt, ...compose(result.response.answers), usage: result.response.usage };
          } catch {
            report.obligations[index] = { id: obligation.id, cases: obligation.rows.length, ...receipt, status: 'unresolved', error: 'semantic_evaluation_failed',
              next: 'Inspect the scoped input and gateway log; verify service availability and the expected native model.' };
          }
        }));
      } finally { await gateway.stop(); }
    } else report.reason = nativeOnly ? 'native_only_requested' : 'missing_TYPESAFE_API_KEY';
    const after = snapshot(root);
    save('source-after.json', after);
    report.fresh = current(before, after);
    report.status = completion({ native: true, fresh: report.fresh, semantic: report.obligations.map((o: any) => o.status) });
  }
} catch (error) {
  // Command/tool failures may contain paths, environment details or upstream text.
  report.status = report.native.status === 'failed' ? 'failed' : 'incomplete';
  report.error = 'verification_evidence_invalid';
  report.next = 'Stage new sources, check declared dependencies, inspect native.log if present, then run verify again.';
  if (error instanceof Error && /^[a-z_]+$/.test(error.message)) report.error = error.message;
}
report.finished_at = new Date().toISOString();
save('report.json', report);
console.log(`Verification: ${report.status}. Native: ${report.native.status}.`);
for (const item of report.obligations) console.log(`  ${item.id}: ${item.status}`);
console.log(`Evidence: ${resolve(output)}/report.json`);
process.exitCode = report.status === 'passed' ? 0 : report.status === 'failed' ? 1 : report.status === 'needs_review' ? 3 : 2;
