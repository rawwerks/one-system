import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { component, run } from '../composition/runtime.mts';
import { route, ensemble, hierarchy } from '../composition/patterns.mts';
import { ask, type Connection, type Json, type Question, type SystemOneRequest, type SystemOneResponse } from '../composition/system-one.mts';
import { artifactDirectory, launch, ready, stop, unusedPort } from './worker.ts';
import type { Scenario } from './scenarios.ts';

type ChoiceQuestion = Question & { criteria: Record<string, Json> };
type NativeInput = { state: Json; questions: Record<string, ChoiceQuestion> };
type EvaluationResponse = SystemOneResponse & { answers: Record<string, { type: string; choice: string; [key: string]: Json }> };
type WireEvidence = { requestBody: string };
type Document = { document: string; request: string };
const document: Document = {
  document: 'The release deployment was cancelled after the safety check failed.',
  request: 'Obtain two independent assessments and adjudicate whether this deployment was cancelled.',
};

/** Real consumer: the same component interface holds SDK leaves and compositions. */
export async function exerciseComposition(root: string, connection: Connection, model: string) {
  const questions = JSON.parse(readFileSync(join(root, 'composition/patterns.questions.json'), 'utf8')) as Record<string, ChoiceQuestion>;
  const wire: WireEvidence[] = [];
  // The composition leaf: one native request per call, recorded as sent.
  const native = component<NativeInput, EvaluationResponse>('native-system-one', (input, scope) =>
    scope.effect(async signal => {
      const request: SystemOneRequest = { model, ...input };
      const response = await ask(connection, request, signal) as EvaluationResponse;
      wire.push({ requestBody: JSON.stringify(request) });
      return response;
    }));
  const members = ['literal-reading', 'independent-review'].map(perspective =>
    component<Document, EvaluationResponse>(perspective, (input, scope) => scope.call(native, {
      state: { ...input, perspective }, questions: { verdict: questions.verdict! },
    })));
  const combine = component<{ input: Document; results: readonly EvaluationResponse[] }, EvaluationResponse>(
    'adjudicate', ({ input, results }, scope) => scope.call(native, {
      state: { ...input, assessments: [...results] as unknown as Json[] }, questions: { verdict: questions.verdict! },
    }));
  const group = ensemble('fanout-in', members, combine);
  const select = component<{ input: Document; candidates: readonly { key: string; description: string }[] }, string | null>(
    'select', async ({ input, candidates }, scope) => (await scope.call(native, {
      state: input, questions: { select: { ...questions.route!, criteria: Object.fromEntries(candidates.map(c => [c.key, c.description])) } },
    })).answers.select!.choice);
  const router = route('router', select, () => [
    { key: 'ensemble', description: 'Two independent assessments followed by adjudication', component: group },
    { key: 'direct', description: 'One assessment with no independent review', component: members[0]! },
  ]);
  const routed = await run(router, document, { allow: [native, ...members, combine, group, select], maxEffects: 4 });
  const routingWire = wire.splice(0);

  const judge = component<{ document: string; path: readonly string[]; candidates: readonly { key: string; description: string }[] }, string | null>(
    'classify-frontier', async ({ document, path, candidates }, scope) => (await scope.call(native, {
      state: { document, path: [...path] }, questions: { select: { ...questions.hierarchy!, criteria: Object.fromEntries(candidates.map(c => [c.key, c.description])) } },
    })).answers.select!.choice);
  const tree = { key: 'root', description: 'Operational events', children: [
    { key: 'deployment', description: 'Software deployment events', children: [
      { key: 'cancelled', description: 'Deployment cancelled' },
      { key: 'completed', description: 'Deployment completed' },
    ] },
    { key: 'billing', description: 'Billing and payment events' },
  ] };
  const classify = hierarchy('recursive', tree, judge);
  const classified = await run(classify, { document: document.document }, { allow: [judge, native], maxEffects: 2 });
  return { input: document, tree, routed, routingWire, classified, recursiveWire: wire };
}

/** Synthetic upstream, actual SDK and actual Go/Hono HTTP implementations. */
export async function collectComposition(root: string): Promise<Scenario[]> {
  const output = artifactDirectory(root, 'composition');
  const captures: { request: NativeInput & { model: string }; response: EvaluationResponse }[] = [];
  const backend = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as NativeInput & { model: string };
      const answers = Object.fromEntries(Object.entries(body.questions).map(([key, question]) => {
        const keys = Object.keys(question.criteria);
        return [key, { type: 'choice' as const, choice: keys[0]!, confidence: .8,
          probabilities: Object.fromEntries(keys.map((id, i) => [id, i === 0 ? .8 : .2 / (keys.length - 1)])) }];
      }));
      const response: EvaluationResponse = { model: body.model, answers, usage: { input_tokens: 7, output_tokens: 3 } };
      captures.push({ request: body, response });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response));
    } catch { res.statusCode = 500; res.end('{}'); }
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const address = backend.address();
  if (!address || typeof address === 'string') throw new Error('composition_fixture_address');
  const config = join(output, 'backends.json');
  writeFileSync(config, JSON.stringify({ name: 'routing-demo', selector: 'fixture', backends: [{
    id: 'fixture', base_url: `http://127.0.0.1:${address.port}`, model: 'fixture-model',
    api_key_env: 'FIXTURE_KEY', description: 'Public synthetic composition fixture',
  }] }), { mode: 0o600 });
  const records: Scenario[] = [];
  try {
    for (const runtime of ['go', 'hono'] as const) {
      const port = await unusedPort();
      const env = { PATH: process.env.PATH, ONE_SYSTEM_CONFIG: config, ONE_SYSTEM_ADDR: `127.0.0.1:${port}`,
        ONE_SYSTEM_API_KEY: 'synthetic-composition-key', FIXTURE_KEY: 'synthetic-backend-key' }; // ubs:ignore — public synthetic fixture keys.
      const gateway = runtime === 'go' // ubs:ignore — runtime name, not a secret.
        ? launch(join(root, '.build/one-system'), [], root, env, join(output, `${runtime}.log`))
        : launch(process.execPath, [join(root, 'hono/dist/node.js')], root, env, join(output, `${runtime}.log`));
      try {
        await ready(gateway, port);
        captures.length = 0;
        const result = await exerciseComposition(root, { endpoint: `http://127.0.0.1:${port}`,
          apiKey: 'synthetic-composition-key' }, 'fixture');
        const routedRequests = result.routingWire.map(w => JSON.parse(w.requestBody));
        const joined = routedRequests.find(r => r.state.assessments)?.state.assessments;
        const leaves = captures.filter(c => (c.request.state as Record<string, Json>).perspective).map(c => c.response);
        records.push({ id: `composition.${runtime}.router-fanout-in`,
          contract: 'The router selects the two-assessment ensemble. Exactly four native requests occur: one selection, two leaf assessments, and one adjudication. Adjudication receives both complete native leaf responses in member order without averaging their distributions, plus the original document. The final result is the adjudicator response. Only model, state and questions cross the native boundary; runtime scope metadata stays local. Synthetic answers demonstrate execution, not judgment quality.',
          observed: { runtime, input: result.input, wire: result.routingWire, upstream: captures.slice(0, 4), output: result.routed } as unknown as Json,
          passed: routedRequests.length === 4 && routedRequests.every(r => same(Object.keys(r).sort(), ['model', 'questions', 'state']))
            && same(joined, leaves) && same(result.routed, captures[3]?.response)
            && routedRequests[3]?.state.document === document.document });
        const recursiveRequests = result.recursiveWire.map(w => JSON.parse(w.requestBody));
        records.push({ id: `composition.${runtime}.recursive`,
          contract: 'The same recursive classifier traverses the external category tree. Two dependent native Choices see paths [] then [deployment], and only the current frontier. The result copies the exact terminal description and full path [deployment,cancelled]; no fabricated path confidence or unvisited leaf is returned.',
          observed: { runtime, document: document.document, tree: result.tree, wire: result.recursiveWire, output: result.classified } as unknown as Json,
          passed: same(result.classified, { path: ['deployment', 'cancelled'], label: 'Deployment cancelled' })
            && same(recursiveRequests.map(r => r.state.path), [[], ['deployment']])
            && same(recursiveRequests.map(r => Object.keys(r.questions.select.criteria)), [['deployment', 'billing'], ['cancelled', 'completed']]) });
      } finally { await stop(gateway); }
    }
  } finally {
    const closed = Promise.withResolvers<void>();
    backend.close(() => closed.resolve());
    backend.closeAllConnections();
    await closed.promise;
  }
  writeFileSync(join(output, 'observations.json'), JSON.stringify(records, null, 2), { mode: 0o600 });
  return records;
}
