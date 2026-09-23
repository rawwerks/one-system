import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentCli, GenerationRejected, generateChecked, GeneratorFailed, parseJson, Rejected } from '../composition/generate.mts';
import { questionAuthor, questionProblems, questionsSchema } from '../composition/questions.mts';
import { run } from '../composition/runtime.mts';
import { openAIResponses } from '../examples/generators/openai-responses.mts';

const agent = join(import.meta.dirname, 'fixtures/fake-agent.mjs');
function fakeAgent(replies: object[], maxOutputBytes?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-agent-'));
  writeFileSync(join(dir, 'replies.json'), JSON.stringify(replies));
  const generate = agentCli(process.execPath, [agent], { env: { ...process.env, FAKE_AGENT_DIR: dir }, maxOutputBytes });
  const stdin = () => readdirSync(dir).filter(name => name.startsWith('stdin-')).sort().map(name => readFileSync(join(dir, name), 'utf8'));
  const pids = () => readFileSync(join(dir, 'pids.txt'), 'utf8').trim().split('\n').map(Number);
  return { generate, stdin, pids };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const valid = JSON.stringify({ refund: { type: 'noul', instructions: 'Does the customer ask for a refund?' } });

test('an agent CLI receives the rendered prompt on stdin and answers on stdout; stderr stays private', async () => {
  const cli = fakeAgent([{ stdout: 'hello\n', stderr: 'progress noise' }]);
  const text = await run(generateChecked('draft', cli.generate, { decode: t => t.trim() }, { system: 'Be brief.' }), 'Say hello', { allow: [] });
  assert.equal(text, 'hello');
  const [prompt] = cli.stdin();
  assert.match(prompt!, /Be brief\./);
  assert.match(prompt!, /Task:\nSay hello/);
  assert.doesNotMatch(prompt!, /progress noise/);
});

test('a failing CLI stops generation with private diagnostics, not a retry', async () => {
  const cli = fakeAgent([{ stdout: 'partial', stderr: 'auth expired', exit: 3 }, { stdout: 'never used' }]);
  await assert.rejects(run(generateChecked('draft', cli.generate, { decode: t => t }), 'x', { allow: [] }),
    (error: unknown) => error instanceof GeneratorFailed && error.message.includes('exited with 3') && error.stderr.includes('auth expired') && !error.message.includes('auth expired'));
  assert.equal(cli.stdin().length, 1);
});

test('a provider error printed to stdout with exit 0 is rejected, fed back, and repaired', async () => {
  const cli = fakeAgent([{ stdout: '429: {"message":"Insufficient balance"}' }, { stdout: '```json\n' + valid + '\n```' }]);
  const questions = await run(questionAuthor('questions', cli.generate), 'Detect refund requests', { allow: [] });
  assert.deepEqual(questions, JSON.parse(valid));
  const [, second] = cli.stdin();
  assert.match(second!, /Rejected answer 1:\n429/);
  assert.match(second!, /Problem: the answer was not valid JSON/);
});

test('generated questions are told the official schema and the route limits, and held to both', async () => {
  const score = JSON.stringify({ urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'high'] } });
  const cli = fakeAgent([{ stdout: '{"urgency":{"type":"choice","instructions":"How urgent?"}}' }, { stdout: score }, { stdout: valid }]);
  const route = [{ question_types: ['noul', 'choice'], min_criteria: 2 }];
  const questions = await run(questionAuthor('questions', cli.generate, { route }), 'Judge refunds', { allow: [] });
  assert.deepEqual(questions, JSON.parse(valid));
  const [first, second, third] = cli.stdin();
  assert.match(first!, /matches this JSON Schema/);
  assert.match(first!, /"ChoiceQuestion"/);
  assert.match(first!, /The destination accepts only: question types: noul, choice; choice\/score criteria: at least 2\./);
  assert.match(second!, /questions\.urgency: must have required property 'criteria'/);
  assert.match(third!, /questions\.urgency: type score is not accepted; use noul, choice/);
});

test('exhausted attempts keep every rejected draft and reason', async () => {
  const cli = fakeAgent([{ stdout: 'no' }, { stdout: 'still no' }]);
  await assert.rejects(run(generateChecked('n', cli.generate, { decode: t => { throw new Rejected(`not a number: ${t}`); } }), 'x', { allow: [] }),
    (error: unknown) => error instanceof GenerationRejected && error.attempts.length === 2 && error.attempts[1]!.reason === 'not a number: still no');
});

test('cancellation stops the agent process', async () => {
  const cli = fakeAgent([{ sleep: 30_000, stdout: 'late' }]);
  const started = Date.now();
  await assert.rejects(run(generateChecked('slow', cli.generate, { decode: t => t }), 'x', { allow: [], timeoutMs: 300 }));
  assert.ok(Date.now() - started < 5000);
  await new Promise(done => setTimeout(done, 200));
  assert.equal(alive(cli.pids()[0]!), false);
});

test('oversized agent output is refused', async () => {
  const cli = fakeAgent([{ bytes: 4096 }], 1024);
  await assert.rejects(run(generateChecked('big', cli.generate, { decode: t => t }), 'x', { allow: [] }),
    (error: unknown) => error instanceof GeneratorFailed && /exceeded 1024 bytes/.test(error.message));
});

test('the extracted schema and validator accept the repository question files', () => {
  const schema = questionsSchema() as { $defs: Record<string, unknown> };
  assert.deepEqual(Object.keys(schema.$defs).sort(), ['ChoiceQuestion', 'NoulCriteria', 'NoulQuestion', 'Question', 'ScoreQuestion']);
  for (const file of ['examples/routing.questions.json', 'examples/agent-review.questions.json', 'examples/file-audience.questions.json']) {
    const questions = JSON.parse(readFileSync(join(import.meta.dirname, '..', file), 'utf8'));
    assert.deepEqual(questionProblems(questions), [], file);
  }
  assert.deepEqual(questionProblems({ q: { type: 'essay' } }), ['questions.q.type: must be one of choice, noul, score']);
  assert.throws(() => parseJson('not json'), Rejected);
});

test('an automatic route accepts questions that any backend supports', () => {
  const score = { s: { type: 'score', instructions: 'x', criteria: ['a', 'b'] } };
  assert.deepEqual(questionProblems(score, [{ question_types: ['noul'] }, { question_types: ['score'] }]), []);
  assert.deepEqual(questionProblems(score, [{ question_types: ['noul'] }, null]), []);
  assert.equal(questionProblems(score, [{ question_types: ['noul'] }, { question_types: ['choice'] }]).length, 2);
});

test('the OpenAI Responses example speaks the documented wire format', async () => {
  const seen: Record<string, any>[] = [];
  const replies = [
    { status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: valid }] }] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] },
    { status: 'incomplete', output: [] },
  ];
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(replies[seen.length - 1]));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  try {
    const generate = openAIResponses({ apiKey: 'test-key', model: 'any-model', baseUrl: `http://127.0.0.1:${port}` });
    const questions = await run(questionAuthor('questions', generate), 'Detect refund requests', { allow: [] });
    assert.deepEqual(questions, JSON.parse(valid));
    const [request] = seen;
    assert.equal(request!.path, '/v1/responses');
    assert.equal(request!.auth, 'Bearer test-key');
    assert.equal(request!.body.model, 'any-model');
    assert.match(request!.body.instructions, /You write questions for TypeSafe System One models/);
    assert.equal(request!.body.text.format.type, 'json_schema');
    assert.equal(request!.body.text.format.strict, false);
    assert.ok(request!.body.text.format.schema.$defs.ChoiceQuestion);
    const plain = generateChecked('x', generate, { decode: t => t });
    await assert.rejects(run(plain, 'x', { allow: [] }), /refused/);
    await assert.rejects(run(plain, 'x', { allow: [] }), /incomplete/);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
