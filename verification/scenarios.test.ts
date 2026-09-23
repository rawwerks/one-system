import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scenarioStatus, type Scenario } from './scenarios.ts';

const good: Scenario = { id: 'one', contract: 'Reject an invalid request.', observed: { status: 422 }, passed: true };
test('scenario evidence cannot pass when absent, duplicated, failed or unavailable', () => {
  assert.throws(() => scenarioStatus([]));
  assert.throws(() => scenarioStatus([good, good]));
  assert.equal(scenarioStatus([good]), 'passed');
  assert.equal(scenarioStatus([{ ...good, passed: false }]), 'failed');
  const unavailable = { ...good, id: 'missing', observed: { status: 'incomplete' }, passed: false };
  assert.equal(scenarioStatus([good, unavailable]), 'incomplete');
  assert.equal(scenarioStatus([{ ...good, passed: false }, unavailable]), 'failed');
});
