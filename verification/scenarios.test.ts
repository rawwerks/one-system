import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireObligations, scenarioQuestions, scenarioStatus, semanticRows, type Scenario } from './scenarios.ts';

const good: Scenario = { id: 'one', contract: 'Reject an invalid request.', observed: { status: 422 }, passed: true };
test('removing a required semantic group cannot leave a green verification', () => {
  const core = ['capabilities', 'self', 'repository', 'examples', 'worker'];
  requireObligations(core);
  requireObligations([...core, 'another-obligation']);
  for (const kind of core) assert.throws(() => requireObligations(core.filter(item => item !== kind)), /missing_required_obligation/);
  assert.throws(() => requireObligations(core, true), /missing_required_obligation/);
  requireObligations([...core, 'laya'], true);
});
test('scenario evidence cannot pass when absent, duplicated, failed or unavailable', () => {
  assert.throws(() => scenarioStatus([]));
  assert.throws(() => scenarioStatus([good, good]));
  assert.equal(scenarioStatus([good]), 'passed');
  assert.equal(scenarioStatus([{ ...good, passed: false }]), 'failed');
  const unavailable = { ...good, id: 'missing', observed: { status: 'incomplete' }, passed: false };
  assert.equal(scenarioStatus([good, unavailable]), 'incomplete');
  assert.equal(scenarioStatus([{ ...good, passed: false }, unavailable]), 'failed');
});
test('semantic state has observations and contracts without a native pass label', () => {
  assert.deepEqual(semanticRows([good]), [{ id: good.id, contract: good.contract, observed: good.observed }]);
});
test('every scenario gets an explicitly bound native question', () => {
  const question = { type: 'choice' as const, instructions: 'Judge {{case_id}} only.', criteria: { supports: 'Supported', contradicts: 'Contradicted', insufficient_context: 'Unknown' } };
  const rows = semanticRows([good, { ...good, id: 'two' }]);
  const questions = scenarioQuestions({ contract: question }, rows);
  assert.deepEqual(Object.keys(questions), ['contract:one', 'contract:two']);
  assert.equal(questions['contract:two'].instructions, 'Judge "two" only.');
  assert.throws(() => scenarioQuestions({ contract: { ...question, instructions: 'Judge everything.' } }, rows));
  assert.throws(() => scenarioQuestions({ contract: question }, [rows[0], rows[0]]));
  assert.throws(() => scenarioQuestions({}, rows));
});
