import assert from 'node:assert/strict';
import { test } from 'node:test';
import { component, run } from '../composition/runtime.mts';
import { route, ensemble, hierarchy } from '../composition/patterns.mts';

test('router: selects an ensemble through the same component contract', async () => {
  const first = component<number, number>('first', n => n + 1);
  const second = component<number, number>('second', n => n + 2);
  const sum = component<{ input: number; results: readonly number[] }, number>('sum', ({ results }) => results.reduce((a, b) => a + b, 0));
  const group = ensemble('group', [first, second], sum);
  let untouched = true;
  const other = component<number, number>('other', () => { untouched = false; return -1; });
  const select = component<{ input: number; candidates: readonly { key: string; description: string }[] }, string | null>('select', ({ candidates }) => candidates.find(c => c.key === 'group')!.key);
  const router = route('router', select, () => [
    { key: 'group', description: 'Combine both assessments', component: group },
    { key: 'other', description: 'Alternative', component: other },
  ]);
  assert.equal(await run(router, 5, { allow: [first, second, sum, group, other, select] }), 13);
  assert.equal(untouched, true);
});

test('router: rebuilds candidate availability for the current input', async () => {
  const local = component<{ private: boolean }, string>('local', () => 'local');
  const hosted = component<{ private: boolean }, string>('hosted', () => 'hosted');
  const select = component<{ input: { private: boolean }; candidates: readonly { key: string; description: string }[] }, string | null>('select', ({ candidates }) => candidates.at(-1)!.key);
  const router = route('router', select, input => [
    { key: 'local', description: 'Local evaluation', component: local },
    ...(!input.private ? [{ key: 'hosted', description: 'Hosted evaluation', component: hosted }] : []),
  ]);
  assert.equal(await run(router, { private: false }, { allow: [local, hosted, select] }), 'hosted');
  assert.equal(await run(router, { private: true }, { allow: [local, hosted, select] }), 'local');
});

test('router: no-match and out-of-catalog selection never execute a substitute', async () => {
  let effects = 0;
  const target = component<string, string>('target', () => { effects++; return 'wrong'; });
  for (const choice of [null, 'absent']) {
    const select = component<{ input: string; candidates: readonly { key: string; description: string }[] }, string | null>('select', () => choice);
    const router = route('router', select, () => [{ key: 'present', description: 'Available', component: target }]);
    await assert.rejects(run(router, 'missing capability', { allow: [target, select] }), { code: choice === null ? 'no_match' : 'invalid_selection' });
  }
  assert.equal(effects, 0);
});

test('router: an empty catalog needs no judgment or action', async () => {
  const select = component<{ input: string; candidates: readonly { key: string; description: string }[] }, string | null>('select', () => { throw new Error('must not infer'); });
  const router = route<string, string>('router', select, () => []);
  await assert.rejects(run(router, 'request', { allow: [select] }), { code: 'no_match' });
});

test('fanout-in: combines original distributions rather than manufacturing probabilities', async () => {
  const left = { score: 1, probabilities: { '0': 0.5, '1': 0, '2': 0.5 } };
  const right = { score: 1, probabilities: { '0': 0, '1': 1, '2': 0 } };
  const first = component<void, typeof left>('first', () => left);
  const second = component<void, typeof left>('second', () => right);
  const choose = component<{ input: void; results: readonly (typeof left)[] }, typeof left>('choose', ({ results }) => results.find(value => value.probabilities['1'] === 1)!);
  assert.deepEqual(await run(ensemble('ensemble', [first, second], choose), undefined, { allow: [first, second, choose] }), right);
  assert.deepEqual(left.probabilities, { '0': 0.5, '1': 0, '2': 0.5 });
});

test('fanout-in: failed members prevent adjudication', async () => {
  let adjudicated = false;
  const leaf = component<string, string>('leaf', () => { throw new Error('invalid native answer'); });
  const join = component<{ input: string; results: readonly string[] }, string>('join', () => { adjudicated = true; return 'fake success'; });
  await assert.rejects(run(ensemble('ensemble', [leaf], join), 'input', { allow: [leaf, join] }), /invalid native answer/);
  assert.equal(adjudicated, false);
});

test('recursive: retains source paths and skips unary judgments', async () => {
  const decisions: string[][] = [];
  const judge = component<{ document: string; path: readonly string[]; candidates: readonly { key: string; description: string }[] }, string | null>('judge', ({ path, candidates }) => {
    decisions.push([...path]);
    return candidates.find(candidate => candidate.key === 'B')?.key ?? 'same';
  });
  const tree = { key: 'root', description: 'Root', children: [
    { key: 'A', description: 'Area A', children: [{ key: 'same', description: 'A evidence' }] },
    { key: 'B', description: 'Area B', children: [{ key: 'same', description: 'Exact Ω evidence' }] },
  ] };
  const classify = hierarchy('classify', tree, judge);
  assert.deepEqual(await run(classify, { document: 'Area B' }, { allow: [judge] }), { path: ['B', 'same'], label: 'Exact Ω evidence' });
  assert.deepEqual(decisions, [[]]);
});

test('recursive: cannot label a depth-limited nonleaf as complete', async () => {
  const judge = component<{ document: string; path: readonly string[]; candidates: readonly { key: string; description: string }[] }, string | null>('judge', () => 'leaf');
  const classify = hierarchy('classify', { key: 'root', description: 'Root', children: [
    { key: 'branch', description: 'Not a terminal answer', children: [{ key: 'leaf', description: 'Terminal' }] },
  ] }, judge);
  await assert.rejects(run(classify, { document: 'input' }, { allow: [judge], maxDepth: 1 }), { code: 'depth_limit' });
});
