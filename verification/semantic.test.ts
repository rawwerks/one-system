import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { compose, evaluate, MAX_BODY_BYTES, type ChoiceAnswer, type EvaluationOptions, type EvaluationResponse, type WireEvidence } from './semantic.ts';

const questions: EvaluationOptions['questions'] = {
  promise: { type: 'choice', instructions: 'Does the trace support the documented promise?', criteria: {
    supports: 'Supported', contradicts: 'Contradicted', insufficient_context: 'Evidence missing',
  } },
};
const testToken = randomUUID();
function judgment(choice = 'supports'): ChoiceAnswer {
  return { type: 'choice', choice, confidence: 0.8, probabilities: Object.fromEntries(
    ['supports', 'contradicts', 'insufficient_context'].map(option => [option, option === choice ? 0.8 : 0.1]),
  ) };
}
function response(): EvaluationResponse {
  return { model: 'jev-pinned', answers: { promise: judgment() }, usage: { input_tokens: 10, output_tokens: 20 } };
}
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const instance = createServer(handler);
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  assert(address && typeof address === 'object');
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/systemone`,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
      instance.closeAllConnections();
      await closed;
    },
  };
}
function options(endpoint: string): EvaluationOptions {
  return { endpoint, apiKey: testToken, model: 'hosted', expectedModel: 'jev-pinned', state: { trace: 'HTTP 400; upstream calls 0' }, questions };
}

test('actual HTTP request and exact response are recorded without credential headers', async () => {
  let received = '';
  const wire = `  ${JSON.stringify(response())}\n`;
  const gateway = await server(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/systemone');
    assert.equal(req.headers.authorization, `Bearer ${testToken}`);
    assert.equal(req.headers['content-type'], 'application/json');
    for await (const chunk of req) received += chunk;
    res.end(wire);
  });
  try {
    const input = options(gateway.endpoint);
    const result = await evaluate(input);
    assert.equal(result.requestBody, received);
    assert.equal(result.responseBody, wire);
    assert.deepEqual(result.response, response());
    assert.deepEqual(result.request, JSON.parse(received));
    assert.equal(JSON.stringify(result).includes(input.apiKey), false);
    (input.state as Record<string, string>).trace = 'changed later';
    assert.notDeepEqual(result.request.state, input.state);
  } finally { await gateway.close(); }
});

test('rejects malformed native answers from real HTTP responses', async t => {
  const cases: [string, (value: EvaluationResponse) => void, string][] = [
    ['wrong model', value => { value.model = 'other'; }, 'unexpected_response_model'],
    ['missing answer', value => { delete value.answers.promise; }, 'invalid_answer_ids'],
    ['extra answer', value => { value.answers.extra = judgment(); }, 'invalid_answer_ids'],
    ['wrong type', value => { (value.answers.promise as any).type = 'noul'; }, 'invalid_answer'],
    ['missing criterion', value => { delete value.answers.promise.probabilities.contradicts; }, 'invalid_answer'],
    ['extra criterion', value => { value.answers.promise.probabilities.extra = 0; }, 'invalid_answer'],
    ['negative probability', value => { value.answers.promise.probabilities.contradicts = -0.1; }, 'invalid_probabilities'],
    ['out of range probability', value => { value.answers.promise.probabilities.supports = 2; }, 'invalid_probabilities'],
    ['null probability', value => { (value.answers.promise.probabilities as any).supports = null; }, 'invalid_probabilities'],
    ['bad normalization', value => { value.answers.promise.probabilities.supports = 0.4; }, 'invalid_probabilities'],
    ['not argmax', value => { value.answers.promise.choice = 'contradicts'; }, 'invalid_choice'],
    ['unknown choice', value => { value.answers.promise.choice = 'unknown'; }, 'invalid_choice'],
    ['bad confidence', value => { value.answers.promise.confidence = 1.1; }, 'invalid_answer'],
    ['fractional usage', value => { value.usage.input_tokens = 1.5; }, 'invalid_usage'],
    ['negative usage', value => { value.usage.input_tokens = -1; }, 'invalid_usage'],
    ['unsafe usage', value => { value.usage.input_tokens = Number.MAX_SAFE_INTEGER + 1; }, 'invalid_usage'],
  ];
  await Promise.all(cases.map(([name, mutate, diagnostic]) => t.test(name, async () => {
    const body = response();
    mutate(body);
    const responseBody = `  ${JSON.stringify(body)}\n`;
    const gateway = await server((_req, res) => { res.end(responseBody); });
    const evidence: WireEvidence[] = [];
    try {
      await assert.rejects(evaluate({ ...options(gateway.endpoint), onWire: wire => { evidence.push(wire); } }), { message: diagnostic });
      assert.equal(evidence.length, 2);
      assert.deepEqual(evidence[1], { ...evidence[0], responseStatus: 200, responseBody });
      assert.deepEqual(JSON.parse(evidence[0].requestBody).questions, questions);
      assert.equal(JSON.stringify(evidence).includes(testToken), false);
    }
    finally { await gateway.close(); }
  })));
});

test('ties and rounding are retained, with no confidence cutoff', () => {
  const lowConfidence: ChoiceAnswer = { type: 'choice', choice: 'supports', confidence: 0, probabilities: {
    supports: 0.33, contradicts: 0.33, insufficient_context: 0.33,
  } };
  assert.deepEqual(compose({ promise: lowConfidence }), { status: 'clear', answers: { promise: lowConfidence } });
  assert.equal(compose({ a: judgment('insufficient_context') }).status, 'unresolved');
  assert.equal(compose({ a: judgment('contradicts'), b: judgment('insufficient_context') }).status, 'finding');
  assert.equal(compose({ b: judgment('insufficient_context'), a: judgment('contradicts') }).status, 'finding');
  assert.throws(() => compose({}), /invalid_answer_ids/);
  assert.throws(() => compose({ a: { ...judgment(), probabilities: { other: 1 } } }), /invalid_answer/);
});

test('transport and parse errors never return response bodies or credentials; no retries', async t => {
  const cases: [string, (res: ServerResponse) => void, string][] = [
    ['http failure', res => { res.statusCode = 401; res.end(testToken); }, 'evaluation_http_error'],
    ['invalid JSON', res => res.end(testToken), 'invalid_response_json'],
    ['invalid UTF8', res => res.end(Buffer.from([0xff, 0xfe])), 'invalid_response_encoding'],
    ['oversized stream', res => res.end('x'.repeat(MAX_BODY_BYTES + 1)), 'response_too_large'],
    ['connection closed', res => res.destroy(), 'evaluation_transport_error'],
    ['redirect', res => { res.writeHead(302, { Location: '/credential-sink' }); res.end(); }, 'evaluation_transport_error'],
  ];
  await Promise.all(cases.map(([name, respond, diagnostic]) => t.test(name, async () => {
    let calls = 0;
    const gateway = await server((_req, res) => { calls++; respond(res); });
    try {
      await assert.rejects(evaluate(options(gateway.endpoint)), { message: diagnostic });
      assert.equal(calls, 1);
    } finally { await gateway.close(); }
  })));
});

test('timeout covers response body consumption', async () => {
  const gateway = await server((_req, res) => { res.writeHead(200); res.write('{'); });
  const evidence: WireEvidence[] = [];
  try {
    await assert.rejects(evaluate({ ...options(gateway.endpoint), timeoutMs: 50, onWire: wire => { evidence.push(wire); } }), { message: 'evaluation_timeout' });
    assert.equal(evidence.length, 1);
    assert.deepEqual(Object.keys(evidence[0]), ['requestBody']);
  }
  finally { await gateway.close(); }
});

test('unsafe or oversized response streams cannot create response artifacts', async t => {
  for (const [name, body, diagnostic] of [
    ['invalid UTF8', Buffer.from([0xff, 0xfe]), 'invalid_response_encoding'],
    ['oversized', Buffer.alloc(MAX_BODY_BYTES + 1, 120), 'response_too_large'],
  ] as const) await t.test(name, async () => {
    const evidence: WireEvidence[] = [];
    const gateway = await server((_req, res) => { res.end(body); });
    try {
      await assert.rejects(evaluate({ ...options(gateway.endpoint), onWire: wire => { evidence.push(wire); } }), { message: diagnostic });
      assert.equal(evidence.length, 1);
      assert.deepEqual(Object.keys(evidence[0]), ['requestBody']);
    } finally { await gateway.close(); }
  });
});

test('bounded HTTP errors are recorded and persistence failures remain sanitized', async () => {
  let calls = 0;
  const body = 'provider unavailable\n';
  const gateway = await server((_req, res) => { calls++; res.writeHead(503); res.end(body); });
  try {
    const evidence: WireEvidence[] = [];
    await assert.rejects(evaluate({ ...options(gateway.endpoint), onWire: wire => { evidence.push(wire); } }), { message: 'evaluation_http_error' });
    assert.equal(evidence[1].responseBody, body);
    assert.equal(evidence[1].responseStatus, 503);
    await assert.rejects(evaluate({ ...options(gateway.endpoint), onWire: () => { throw new Error(testToken); } }), { message: 'evidence_write_failed' });
    assert.equal(calls, 1, 'failed request persistence must prevent network access');
    await assert.rejects(evaluate({ ...options(gateway.endpoint), onWire: wire => {
      if (wire.responseBody !== undefined) throw new Error(testToken);
    } }), { message: 'evidence_write_failed' });
    assert.equal(calls, 2);
  } finally { await gateway.close(); }
});

test('wire evidence preserves a leading UTF8 BOM instead of silently deleting bytes', async () => {
  const body = `\uFEFF${JSON.stringify(response())}`;
  const gateway = await server((_req, res) => { res.end(body); });
  const evidence: WireEvidence[] = [];
  try {
    await assert.rejects(evaluate({ ...options(gateway.endpoint), onWire: wire => { evidence.push(wire); } }), { message: 'invalid_response_json' });
    assert.equal(evidence[1].responseBody, body);
  } finally { await gateway.close(); }
});

test('invalid inputs are rejected before network access', async () => {
  let calls = 0;
  const gateway = await server((_req, res) => { calls++; res.end(JSON.stringify(response())); });
  try {
    for (const endpoint of ['ftp://localhost/v1/systemone', 'http://example.org/v1/systemone', 'https://user:secret@example.org/v1/systemone', `${gateway.endpoint}?key=secret`, `${gateway.endpoint}#fragment`, `${gateway.endpoint}/extra`]) {
      await assert.rejects(evaluate({ ...options(endpoint) }), { message: 'invalid_endpoint' });
    }
    for (const timeoutMs of [0, -1, 1.5, Infinity, 120001]) {
      await assert.rejects(evaluate({ ...options(gateway.endpoint), timeoutMs }), { message: 'invalid_timeout' });
    }
    await assert.rejects(evaluate({ ...options(gateway.endpoint), state: 'é'.repeat(MAX_BODY_BYTES / 2) }), { message: 'request_too_large' });
    await assert.rejects(evaluate({ ...options(gateway.endpoint), state: { invalid: Infinity } }), { message: 'invalid_request' });
    await assert.rejects(evaluate({ ...options(gateway.endpoint), questions: {} }), { message: 'invalid_request' });
    await assert.rejects(evaluate({ ...options(gateway.endpoint), apiKey: `${testToken}\n` }), { message: 'invalid_request' });
    assert.equal(calls, 0);
  } finally { await gateway.close(); }
});
