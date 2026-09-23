import assert from 'node:assert/strict';
import { test } from 'node:test';
import { component, run, type Scope } from '../composition/runtime.mts';

function deferred<T>() {
  return Promise.withResolvers<T>();
}

function stopped(signal: AbortSignal): Promise<never> {
  const { promise, reject } = Promise.withResolvers<never>();
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  return promise;
}

test('a composite substitutes for a leaf without changing its caller', async () => {
  const twice = component<number, number>('twice', value => value * 2);
  const four = component<number, number>('four', async (value, scope) =>
    scope.call(twice, await scope.call(twice, value)));
  const caller = (child: typeof twice) => component<number, number>('caller', (value, scope) => scope.call(child, value));
  assert.equal(await run(caller(twice), 3, { allow: [twice] }), 6);
  assert.equal(await run(caller(four), 3, { allow: [four, twice] }), 12);
});

test('dependent calls consume produced evidence rather than original input', async () => {
  const locate = component<string, string[]>('locate', text => text.split('|'));
  const select = component<string[], string>('select', parts => parts[1]!);
  const pipeline = component<string, string>('pipeline', async (text, scope) =>
    scope.call(select, await scope.call(locate, text)));
  assert.equal(await run(pipeline, 'discard|Exact Ω evidence', { allow: [locate, select] }), 'Exact Ω evidence');
});

test('fanout-in: overlaps effects and joins in caller order', async () => {
  const both = deferred<void>();
  const releaseFirst = deferred<void>();
  const finished: number[] = [];
  let entered = 0;
  const leaf = component<number, number>('leaf', (value, scope) => scope.effect(async () => {
    if (++entered === 2) both.resolve();
    await both.promise;
    if (value === 1) await releaseFirst.promise;
    else releaseFirst.resolve();
    finished.push(value);
    return value * 10;
  }));
  const parent = component<void, number[]>('parent', (_input, scope) => scope.all([
    { component: leaf, input: 1 }, { component: leaf, input: 2 },
  ]));
  assert.deepEqual(await run(parent, undefined, { allow: [leaf], concurrency: 2 }), [10, 20]);
  assert.deepEqual(finished, [2, 1]);
});

test('recursive: shares one work budget across the entire call tree', async () => {
  const tree = component<number, number>('tree', async (depth, scope): Promise<number> => {
    if (depth === 0) return 1;
    const values = await scope.all([
      { component: tree, input: depth - 1 }, { component: tree, input: depth - 1 },
    ]);
    return values[0]! + values[1]!;
  });
  assert.equal(await run(tree, 2, { allow: [], maxCalls: 7 }), 4);
  await assert.rejects(run(tree, 2, { allow: [], maxCalls: 6 }), { code: 'call_limit' });
});

test('depth exhaustion cannot masquerade as a completed recursive result', async () => {
  const descend = component<number, number>('descend', (n, scope): number | Promise<number> =>
    n === 0 ? 99 : scope.call(descend, n - 1));
  assert.equal(await run(descend, 2, { allow: [], maxDepth: 2 }), 99);
  await assert.rejects(run(descend, 3, { allow: [], maxDepth: 2 }), { code: 'depth_limit' });
});

test('a fan-out batch that exceeds remaining calls starts no member', async () => {
  const effects: number[] = [];
  const leaf = component<number, number>('leaf', value => { effects.push(value); return value; });
  const parent = component<void, number[]>('parent', (_input, scope) => scope.all([
    { component: leaf, input: 1 }, { component: leaf, input: 2 },
  ]));
  await assert.rejects(run(parent, undefined, { allow: [leaf], maxCalls: 2 }), { code: 'call_limit' });
  assert.deepEqual(effects, []);
});

test('component authority uses registered identity, not a matching display name', async () => {
  let touched = false;
  const allowed = component<void, number>('worker', () => 1);
  const impostor = component<void, number>('worker', () => { touched = true; return 2; });
  const root = component<void, number>('root', (_input, scope) => scope.call(impostor, undefined));
  await assert.rejects(run(root, undefined, { allow: [allowed] }), { code: 'forbidden_component' });
  assert.equal(touched, false);
});

test('child authority can narrow but cannot be widened by a descendant', async () => {
  let touched = false;
  const secret = component<void, number>('secret', () => { touched = true; return 1; });
  const middle = component<void, number>('middle', (_input, scope) => scope.call(secret, undefined, { allow: [secret] }));
  const root = component<void, number>('root', (_input, scope) => scope.call(middle, undefined, { allow: [] }));
  await assert.rejects(run(root, undefined, { allow: [middle, secret] }), { code: 'forbidden_component' });
  assert.equal(touched, false);
});

test('effects share an admission budget even when dispatched concurrently', async () => {
  let executions = 0;
  const leaf = component<void, number>('leaf', (_input, scope) => scope.effect(async () => ++executions));
  const root = component<void, number[]>('root', (_input, scope) => scope.all([
    { component: leaf, input: undefined }, { component: leaf, input: undefined },
  ]));
  await assert.rejects(run(root, undefined, { allow: [leaf], maxEffects: 1 }), { code: 'effect_limit' });
  assert.ok(executions <= 1);
});

test('one effect pool bounds nested fan-out without deadlocking parents', async () => {
  let active = 0;
  let peak = 0;
  const leaf = component<number, number>('leaf', (n, scope) => scope.effect(async () => {
    peak = Math.max(peak, ++active);
    await Promise.resolve();
    active--;
    return n;
  }));
  const inner = component<number, number[]>('inner', (n, scope) => scope.all([
    { component: leaf, input: n }, { component: leaf, input: n + 1 },
  ]));
  const root = component<void, number[][]>('root', (_input, scope) => scope.all([
    { component: inner, input: 1 }, { component: inner, input: 3 },
  ]));
  assert.deepEqual(await run(root, undefined, { allow: [inner, leaf], concurrency: 1 }), [[1, 2], [3, 4]]);
  assert.equal(peak, 1);
});

test('failure cancels a running sibling and prevents a final successful result', async () => {
  const active = deferred<void>();
  let cancelled = false;
  const waiting = component<void, never>('waiting', (_input, scope) => scope.effect(async signal => {
    active.resolve();
    try { return await stopped(signal); } finally { cancelled = signal.aborted; }
  }));
  const failing = component<void, never>('failing', async () => { await active.promise; throw new Error('leaf failed'); });
  const root = component<void, never[]>('root', (_input, scope) => scope.all([
    { component: waiting, input: undefined }, { component: failing, input: undefined },
  ]));
  await assert.rejects(run(root, undefined, { allow: [waiting, failing] }), /leaf failed/);
  assert.equal(cancelled, true);
});

test('caller cancellation reaches an active effect and blocks queued effects', async () => {
  const active = deferred<void>();
  const controller = new AbortController();
  let starts = 0;
  let cancellations = 0;
  const leaf = component<void, never>('leaf', (_input, scope) => scope.effect(async signal => {
    starts++;
    active.resolve();
    try { return await stopped(signal); } finally { if (signal.aborted) cancellations++; }
  }));
  const root = component<void, never[]>('root', (_input, scope) => scope.all([
    { component: leaf, input: undefined }, { component: leaf, input: undefined },
  ]));
  const pending = run(root, undefined, { allow: [leaf], concurrency: 1, signal: controller.signal });
  await active.promise;
  controller.abort(new Error('user stopped'));
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(starts, 1);
  assert.equal(cancellations, 1);
});

test('one deadline cancels a stalled descendant rather than resetting per child', async () => {
  let cancelled = false;
  const leaf = component<void, never>('leaf', (_input, scope) => scope.effect(async signal => {
    try { return await stopped(signal); } finally { cancelled = signal.aborted; }
  }));
  const root = component<void, never>('root', (_input, scope) => scope.call(leaf, undefined));
  await assert.rejects(run(root, undefined, { allow: [leaf], timeoutMs: 10 }), { code: 'deadline' });
  assert.equal(cancelled, true);
});

test('a completed scope cannot start later work and independent runs reset limits', async () => {
  let retained!: Scope;
  let effects = 0;
  const root = component<void, number>('root', async (_input, scope) => {
    retained = scope;
    return scope.effect(async () => ++effects);
  });
  assert.equal(await run(root, undefined, { allow: [], maxCalls: 1, maxEffects: 1 }), 1);
  await assert.rejects(retained.effect(async () => ++effects), { code: 'scope_closed' });
  assert.equal(await run(root, undefined, { allow: [], maxCalls: 1, maxEffects: 1 }), 2);
});

test('the root does not report completion while an owned child is still running', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let completed = false;
  const child = component<void, void>('child', async () => { entered.resolve(); await release.promise; completed = true; });
  const root = component<void, string>('root', (_input, scope) => { void scope.call(child, undefined); return 'done'; });
  const pending = run(root, undefined, { allow: [child] });
  await entered.promise;
  assert.equal(completed, false);
  release.resolve();
  assert.equal(await pending, 'done');
  assert.equal(completed, true);
});
