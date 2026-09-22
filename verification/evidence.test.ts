import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bytes, completion, current, hash, loadObligations, observations, read, resolveFact, selfObservations, snapshot, type CompletionInput, type Graph } from './evidence.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(readFileSync(join(root, 'contract/cases/capability-verification.json'), 'utf8'));
function traces(): any[] {
  return ['go', 'hono'].flatMap(runtime => fixture.cases.flatMap((c: any) => ['routing-demo', 'local'].map(model => {
    const request = { model, state: { message: 'synthetic', nested: { a: 1, b: 2 } }, questions: { q: JSON.parse(c.question_raw) } };
    return {
      version: 1, obligation: 'routing.hard-capabilities', runtime, case: c.name, model,
      capabilities: structuredClone(fixture.capabilities), request_raw: bytes(request), response_status: c.expected_status,
      response_body: bytes(c.expected_status === 200 ? fixture.upstream_response : { detail: [{ type: 'unsupported_capability' }] }),
      upstream_calls: c.expected_upstream_calls ? [{ body_raw: bytes({ ...request, model: 'local-model' }) }] : [],
    };
  })));
}

test('observations require complete unique runtime, case and model coverage', () => {
  assert.equal(observations(traces(), fixture).length, 12);
  assert.throws(() => observations(traces().slice(1), fixture), /incomplete_observation_coverage/);
  const duplicate = traces(); duplicate[0] = duplicate[1];
  assert.throws(() => observations(duplicate, fixture), /invalid_observation_identity/);
  for (const field of ['runtime', 'case', 'model', 'obligation', 'version']) {
    const wrong = traces(); wrong[0][field] = 'unknown';
    assert.throws(() => observations(wrong, fixture), /invalid_observation_identity/);
  }
});

test('positive control requires actual success and unmodified forwarding', () => {
  const incomplete = traces().filter(record => record.case !== 'supported-choice');
  assert.throws(() => observations(incomplete, fixture), /incomplete_observation_coverage/);
  const wrongStatus = traces(); wrongStatus.find(r => r.case === 'supported-choice').response_status = 422;
  assert.throws(() => observations(wrongStatus, fixture), /observation_failed_native_contract/);
  const noCall = traces(); noCall.find(r => r.case === 'supported-choice').upstream_calls = [];
  assert.throws(() => observations(noCall, fixture), /observation_failed_native_contract/);
  for (const change of [
    (request: any) => { request.model = 'other'; },
    (request: any) => { request.questions.q.criteria.c = 'extra'; },
    (request: any) => { request.state.message = 'different'; },
  ]) {
    const wrong = traces();
    const call = wrong.find(r => r.case === 'supported-choice').upstream_calls[0];
    const request = JSON.parse(call.body_raw); change(request); call.body_raw = bytes(request);
    assert.throws(() => observations(wrong, fixture), /unexpected_upstream_request/);
  }
});

test('negative controls require capability-specific rejection before upstream calls', () => {
  const wrongReason = traces(); wrongReason[0].response_body = bytes({ detail: [{ type: 'invalid_request' }] });
  assert.throws(() => observations(wrongReason, fixture), /wrong_rejection_reason/);
  const called = traces(); called[0].upstream_calls = [{ body_raw: called[0].request_raw }];
  assert.throws(() => observations(called, fixture), /observation_failed_native_contract/);
  const wrongQuestion = traces();
  const request = JSON.parse(wrongQuestion[0].request_raw); request.questions.q.type = 'choice';
  wrongQuestion[0].request_raw = bytes(request);
  assert.throws(() => observations(wrongQuestion, fixture), /observation_failed_native_contract/);
});

test('capability metadata order is irrelevant across Go and Hono serializations', () => {
  const reordered = traces();
  for (const record of reordered) {
    record.capabilities = { max_criteria: 2, question_types: ['choice'] };
  }
  assert.equal(observations(reordered, fixture).length, 12);
});

test('frozen case-alias question order cannot be changed to erase the original bypass', () => {
  const reordered = traces();
  const request = JSON.parse(reordered[0].request_raw);
  request.questions.q = Object.fromEntries(Object.entries(request.questions.q).reverse());
  reordered[0].request_raw = bytes(request);
  assert.throws(() => observations(reordered, fixture), /observation_failed_native_contract/);
});

test('private transport metadata is omitted from exported observation envelopes', () => {
  const marker = randomUUID();
  const records = traces();
  for (const record of records) {
    record.headers = { Authorization: marker };
    record.environment = { TOKEN: marker };
    record.path = `/${marker}`;
    for (const call of record.upstream_calls) call.headers = { Authorization: marker };
  }
  const result = observations(records, fixture);
  assert.equal(bytes(result).includes(marker), false);
  assert.equal((result[0] as any).request_raw, records[0].request_raw);
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'one-system-evidence-test-'));
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  return { dir, put, close: () => rmSync(dir, { recursive: true, force: true }) };
}
function declared(work: ReturnType<typeof workspace>) {
  const path = 'verification/obligations/example.json';
  work.put('README.md', '<!-- true-up:anchor id=promise -->\nThe contract promise.\n<!-- true-up:end id=promise -->\n');
  const spec = { id: 'example.promise', evidence: 'self', inputs: { promise: 'README.md#promise' }, questions: {} };
  work.put(path, bytes(spec));
  const graph: Graph = { nodes: {
    [`file:${path}`]: { hash: hash(bytes(spec)).slice(0, 16) },
    'fact:README.md#promise': { hash: hash('The contract promise.').slice(0, 16) },
  }, edges: [{ from: `file:${path}`, to: 'fact:README.md#promise', kind: 'derives-facts-from' }] };
  return { path, spec, graph };
}

test('graph resolves declared source text and checks both declaration and fact hashes', () => {
  const work = workspace();
  try {
    const { graph, path, spec } = declared(work);
    assert.deepEqual(loadObligations(work.dir, graph), [{ path, spec, state: { promise: 'The contract promise.' } }]);
    assert.throws(() => loadObligations(work.dir, { ...graph, edges: [] }), /missing_declared_dependency/);
    const staleDeclaration = structuredClone(graph); staleDeclaration.nodes[`file:${path}`].hash = 'old';
    assert.throws(() => loadObligations(work.dir, staleDeclaration), /stale_obligation_graph/);
    const staleFact = structuredClone(graph); staleFact.nodes['fact:README.md#promise'].hash = 'old';
    assert.throws(() => loadObligations(work.dir, staleFact), /stale_source_fact/);
    work.put('README.md', '<!-- true-up:anchor id=promise -->\nChanged promise.\n<!-- true-up:end id=promise -->\n');
    assert.throws(() => loadObligations(work.dir, graph), /stale_source_fact/);
  } finally { work.close(); }
});

test('obligation declarations cannot be omitted or duplicated', () => {
  const work = workspace();
  try {
    mkdirSync(join(work.dir, 'verification/obligations'), { recursive: true });
    assert.throws(() => loadObligations(work.dir, { nodes: {}, edges: [] }), /no_verification_obligations/);
    const { spec, graph } = declared(work);
    const duplicate = 'verification/obligations/repeated.json';
    work.put(duplicate, bytes(spec));
    graph.nodes[`file:${duplicate}`] = { hash: hash(bytes(spec)).slice(0, 16) };
    graph.edges.push({ from: `file:${duplicate}`, to: 'fact:README.md#promise', kind: 'derives-facts-from' });
    assert.throws(() => loadObligations(work.dir, graph), /invalid_obligation/);
  } finally { work.close(); }
});

test('private graph targets, traversal, symlinks and missing spans cannot be exported', () => {
  const work = workspace();
  try {
    const { graph, path, spec } = declared(work);
    work.put('private.txt', 'private-marker');
    spec.inputs.promise = 'private.txt'; work.put(path, bytes(spec));
    graph.nodes[`file:${path}`].hash = hash(bytes(spec)).slice(0, 16);
    graph.nodes['file:private.txt'] = { hash: hash('private-marker').slice(0, 16) };
    graph.edges = [{ from: `file:${path}`, to: 'file:private.txt', kind: 'derives-facts-from' }];
    assert.throws(() => loadObligations(work.dir, graph), /source_not_exportable/);
    for (const path of ['../private.txt', '/private.txt', './private.txt', 'nested//private.txt']) {
      assert.throws(() => read(work.dir, path), /unsafe_source_path/);
    }
    symlinkSync(join(work.dir, 'private.txt'), join(work.dir, 'router.go'));
    assert.throws(() => resolveFact(work.dir, 'router.go'), /unsafe_source_file/);
    symlinkSync(work.dir, join(work.dir, 'hono'));
    assert.throws(() => read(work.dir, 'hono/private.txt'), /unsafe_source_file/);
    assert.throws(() => resolveFact(work.dir, 'README.md#missing'), /missing_source_span/);
  } finally { work.close(); }
});

test('large aggregate evidence keeps explicit byte bounds and source-file safety', () => {
  const work = workspace();
  try {
    const payload = 'x'.repeat(2 * 1024 * 1024 + 1);
    work.put('examples.json', payload);
    assert.throws(() => read(work.dir, 'examples.json'), /unsafe_source_file/);
    assert.equal(read(work.dir, 'examples.json', payload.length), payload);
    assert.throws(() => read(work.dir, 'examples.json', payload.length - 1), /unsafe_source_file/);
    assert.throws(() => read(work.dir, 'examples.json', Infinity), /invalid_source_limit/);
    symlinkSync(join(work.dir, 'examples.json'), join(work.dir, 'alias.json'));
    assert.throws(() => read(work.dir, 'alias.json', payload.length), /unsafe_source_file/);
  } finally { work.close(); }
});

test('contract facts are identified exactly once and hashed independent of object key order', () => {
  const work = workspace();
  try {
    work.put('contract/invariants.json', bytes({ invariants: [{ id: 'a', guarantee: 'Keep promise' }] }));
    const first = resolveFact(work.dir, 'contract/invariants.json#invariants.a');
    work.put('contract/invariants.json', bytes({ invariants: [{ guarantee: 'Keep promise', id: 'a' }] }));
    assert.equal(resolveFact(work.dir, 'contract/invariants.json#invariants.a').hash, first.hash);
    assert.throws(() => resolveFact(work.dir, 'contract/invariants.json#invariants.b'), /missing_or_duplicate_contract_fact/);
    work.put('contract/invariants.json', bytes({ invariants: [{ id: 'a' }, { id: 'a' }] }));
    assert.throws(() => resolveFact(work.dir, 'contract/invariants.json#invariants.a'), /missing_or_duplicate_contract_fact/);
  } finally { work.close(); }
});

test('new source must be staged and changed source invalidates a saved snapshot', () => {
  const work = workspace();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: work.dir, stdio: 'pipe' });
  try {
    git('init', '--quiet'); work.put('source.txt', 'original'); git('add', 'source.txt');
    const before = snapshot(work.dir);
    assert.equal(current(before, snapshot(work.dir)), true);
    work.put('source.txt', 'changed');
    assert.equal(current(before, snapshot(work.dir)), false);
    work.put('new.txt', 'unstaged addition');
    assert.throws(() => snapshot(work.dir), /stage_new_source_files_before_verifying/);
    git('add', 'new.txt');
    assert.equal(current(before, snapshot(work.dir)), false);
  } finally { work.close(); }
});

test('submodule evidence requires a clean pinned checkout and changes with its pin', () => {
  const work = workspace();
  const moduleRoot = join(work.dir, 'vendor/skill');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args,
  ], { cwd, stdio: 'pipe' });
  try {
    git(work.dir, 'init', '--quiet');
    work.put('vendor/skill/SKILL.md', 'Original guidance');
    git(moduleRoot, 'init', '--quiet');
    git(moduleRoot, 'add', 'SKILL.md');
    git(moduleRoot, 'commit', '--quiet', '-m', 'Original guidance');
    git(work.dir, 'add', 'vendor/skill');
    const before = snapshot(work.dir);
    assert.equal(current(before, snapshot(work.dir)), true);
    work.put('vendor/skill/untracked.txt', 'Unreviewed guidance');
    assert.throws(() => snapshot(work.dir), /modified_submodule_source/);
    rmSync(join(moduleRoot, 'untracked.txt'));
    work.put('vendor/skill/SKILL.md', 'Updated guidance');
    assert.throws(() => snapshot(work.dir), /modified_submodule_source/);
    git(moduleRoot, 'add', 'SKILL.md');
    git(moduleRoot, 'commit', '--quiet', '-m', 'Updated guidance');
    assert.throws(() => snapshot(work.dir), /submodule_revision_mismatch/);
    git(work.dir, 'add', 'vendor/skill');
    assert.equal(current(before, snapshot(work.dir)), false);
    rmSync(moduleRoot, { recursive: true });
    assert.throws(() => snapshot(work.dir), /ENOENT/);
    symlinkSync(work.dir, moduleRoot);
    assert.throws(() => snapshot(work.dir), /unsafe_source_file/);
  } finally { work.close(); }
});

test('completion cannot report passed for failed, missing or unresolved verification', () => {
  const base: CompletionInput = { native: true, fresh: true, semantic: ['clear'] };
  assert.equal(completion(base), 'passed');
  assert.equal(completion({ ...base, native: false }), 'failed');
  assert.equal(completion({ ...base, fresh: false }), 'incomplete');
  for (const semantic of [[], ['not_run'], ['unresolved'], ['unknown']] as CompletionInput['semantic'][]) {
    assert.equal(completion({ ...base, semantic }), 'incomplete');
  }
  assert.equal(completion({ ...base, semantic: ['finding'] }), 'needs_review');
  assert.notEqual(completion({ ...base, semantic: ['finding', 'unresolved'] }), 'passed');
});

test('self-observations expose seven real completion outputs', () => {
  const records = selfObservations();
  assert.equal(records.length, 7);
  assert.deepEqual(records.map(r => r.output), ['failed', 'incomplete', 'incomplete', 'incomplete', 'incomplete', 'needs_review', 'passed']);
  for (const record of records) assert.equal(record.output, completion(record.input as CompletionInput));
});

// Exercise the repository document, not only synthetic parser fixtures.
test('repository contract fact IDs are unique', () => {
  const invariants = JSON.parse(read(root, 'contract/invariants.json')).invariants;
  const ids = invariants.map((item: { id: string }) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  resolveFact(root, 'contract/invariants.json#invariants.routing.hard-capabilities');
});
