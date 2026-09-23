import { spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactDirectory, launch, ready, request, stop, unusedPort } from './worker.ts';
import type { Json } from './scenarios.ts';
import type { Scenario } from './scenarios.ts';

/** Invoke the adapter's schema engine; TypeScript owns all scenario expectations. */
export function validateLayaDocument(root: string, python: string, name: 'ModelMetadataList' | 'SystemOneResponse', document: Json): { valid: boolean; errors: Json[] } {
  const components = JSON.parse(readFileSync(join(root, 'schema/typesafe.openapi.json'), 'utf8')).components;
  const schema = { $ref: `#/components/schemas/${name}`, components };
  const validation = spawnSync(python, ['-c', 'import json,sys; from jsonschema import Draft202012Validator; value=json.load(sys.stdin); print(json.dumps([{"path":list(error.absolute_path),"rule":error.validator} for error in Draft202012Validator(value["schema"]).iter_errors(value["document"])]))'], {
    cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME },
    input: JSON.stringify({ schema, document }), timeout: 20_000, maxBuffer: 2 << 20, encoding: 'utf8',
  });
  if (validation.status !== 0) throw new Error('laya_schema_engine_failed');
  const errors: unknown = JSON.parse(validation.stdout);
  if (!Array.isArray(errors)) throw new Error('laya_schema_evidence_invalid');
  return { valid: errors.length === 0, errors: errors as Json[] };
}

/** The adapter remains Python production code; scenarios and their expectations live here. */
export async function collectLaya(root: string, options: { checkpoint?: boolean } = {}): Promise<Scenario[]> {
  const output = artifactDirectory(root, 'laya');
  const python = process.env.LAYA_PYTHON ?? join(root, '.venv/bin/python');
  const runtime = process.env.LAYA_RUNTIME ?? 'torch';
  const result: Scenario[] = [];
  const record = (id: string, contract: string, observed: Json, passed: boolean) => result.push({ id: `laya.${id}`, contract, observed, passed });
  const incomplete = (id: string, reason: string) => record(id, 'The requested Laya profile needs actual runtime and checkpoint evidence; unavailable evidence is incomplete.', { status: 'incomplete', reason }, false);
  if (!existsSync(python)) { incomplete('runtime', 'laya_python_missing'); return result; }
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LOCAL_API_KEY: 'synthetic-local-key', LAYA_RUNTIME: runtime };
  const importProbe = spawnSync(python, ['-c', 'import adapters.laya'], { cwd: root, env, timeout: 20_000, encoding: 'utf8' });
  if (importProbe.status !== 0) {
    if (importProbe.stderr?.includes('ModuleNotFoundError')) incomplete('runtime', 'laya_adapter_dependency_missing');
    else record('adapter-import', 'The production adapter must import successfully.', { exit_code: importProbe.status, signal: importProbe.signal }, false);
    return result;
  }
  for (const [id, document, expectedValid] of [
    ['valid-catalogue', { models: [{ name: 'synthetic-laya', description: 'Synthetic schema control', release_date: '2026-09-19' }] }, true],
    ['missing-release-date', { models: [{ name: 'synthetic-laya', description: 'Synthetic schema control' }] }, false],
  ] as [string, Json, boolean][]) {
    const schema = validateLayaDocument(root, python, 'ModelMetadataList', document);
    record(`schema-control-${id}`, `This synthetic catalogue control must be ${expectedValid ? 'accepted' : 'rejected'} by the vendored ModelMetadataList schema; release_date is required.`, { document, schema }, schema.valid === expectedValid);
  }
  const roundedControls: Json[] = [
    { type: 'choice', choice: 'vocabulary', probabilities: { mixed: 0.1667, other: 0.297, vocabulary: 0.5364 }, confidence: 0.0959 },
    { type: 'score', score: 1.5599, probabilities: { '0': 0.11, '1': 0.22, '2': 0.6699 }, confidence: 0 },
    ...[{ a: 0, b: 0 }, { a: 0.2, b: 0.3 }, { a: true, b: false }, { a: -0.1, b: 1.1 }].map(probabilities => ({ type: 'choice', probabilities })),
  ];
  const normalization = spawnSync(python, ['-c', [
    'import json,sys',
    'from adapters.laya import normalize_distribution',
    'def translate(answer):',
    '    try:',
    '        normalize_distribution(answer)',
    '        return {"answer":answer}',
    '    except Exception as error:',
    '        return {"error":type(error).__name__}',
    'print(json.dumps([translate(answer) for answer in json.load(sys.stdin)]))',
  ].join('\n')], { cwd: root, env, input: JSON.stringify(roundedControls), timeout: 20_000, encoding: 'utf8' });
  type Normalized = { answer?: { type: string; probabilities: Record<string, number>; confidence: number; score?: number }; error?: string };
  let normalizationEvidence: Json = null;
  try { normalizationEvidence = JSON.parse(normalization.stdout); } catch { /* Failed evidence remains explicit. */ }
  const normalized = Array.isArray(normalizationEvidence) ? normalizationEvidence as Normalized[] : [];
  const normalizedAnswer = (item: Normalized | undefined): boolean => {
    const answer = item?.answer;
    if (!answer) return false;
    const probabilities = Object.values(answer.probabilities);
    const total = probabilities.reduce((sum, p) => sum + p, 0);
    const entropy = -probabilities.reduce((sum, p) => sum + (p > 0 ? p * Math.log(p) : 0), 0);
    return probabilities.every(p => Number.isFinite(p) && p >= 0 && p <= 1) && Math.abs(total - 1) <= 1e-12
      && Math.abs(answer.confidence - (1 - entropy / Math.log(probabilities.length))) <= 1e-12
      && (answer.type !== 'score' || Math.abs(Number(answer.score) - Object.entries(answer.probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0)) <= 1e-12);
  };
  record('rounded-distributions', 'Native Choice/Score distributions must repair independent four-decimal rounding, derive confidence/score consistently, and reject invalid probability mass rather than fabricate an answer.',
    { controls: roundedControls, translated: normalizationEvidence, exit_code: normalization.status },
    normalization.status === 0 && normalized.length === roundedControls.length && normalizedAnswer(normalized[0]) && normalizedAnswer(normalized[1]) && normalized.slice(2).every(item => item.error === 'RuntimeError'));
  const empty = join(output, 'empty-checkpoint');
  mkdirSync(empty);
  for (const [id, modelPath, selectedRuntime, expectedError] of [
    ['unknown-runtime', join(output, 'missing'), 'unknown', 'LAYA_RUNTIME must be torch or mlx'],
    ['missing-checkpoint', join(output, 'missing'), 'torch', 'FileNotFoundError'],
    ['incomplete-checkpoint', empty, 'torch', 'complete downloaded checkpoint'],
  ] as const) {
    const observed = spawnSync(python, ['-m', 'adapters.laya'], { cwd: root, env: { ...env, LAYA_MODEL_PATH: modelPath, LAYA_RUNTIME: selectedRuntime }, timeout: 20_000, encoding: 'utf8' });
    const diagnostic = observed.stderr?.trim().split('\n').at(-1)?.split(output).join('<scenario>') ?? '';
    record(id, `Production adapter startup must reject this configuration with ${expectedError}, without downloading a checkpoint.`, { exit_code: observed.status, signal: observed.signal, diagnostic }, observed.status !== null && observed.status !== 0 && diagnostic.includes(expectedError));
  }
  // This is a production dependency probe, not a second Python test framework.
  const expression = runtime === 'mlx'
    ? 'import json, adapters.laya, laya_mlx; import mlx.core as mx; mx.set_default_device(mx.cpu); print(json.dumps({"runtime":"mlx","tensor_sum":mx.ones((2,)).sum().item()}))'
    : 'import json, adapters.laya, laya, torch; print(json.dumps({"runtime":"torch","tensor_sum":torch.ones(2).sum().item()}))';
  const tensor = spawnSync(python, ['-c', expression], { cwd: root, env, timeout: 60_000, encoding: 'utf8' });
  let tensorValue: Json = null;
  try { tensorValue = JSON.parse(tensor.stdout.trim().split('\n').at(-1) ?? 'null') as Json; } catch { /* Failed dependency evidence remains explicit. */ }
  record('runtime-operation', 'The selected installed runtime must import the production adapter and evaluate ones(2).sum() as 2 on CPU.', { exit_code: tensor.status, signal: tensor.signal, result: tensorValue, ...(tensor.status !== 0 ? { status: 'incomplete', reason: 'laya_runtime_unavailable' } : {}) }, tensor.status === 0 && JSON.stringify(tensorValue) === JSON.stringify({ runtime, tensor_sum: 2 }));
  if (options.checkpoint === false) return result;
  const checkpoint = process.env.LAYA_MODEL_PATH;
  if (!checkpoint) { incomplete('checkpoint', 'laya_checkpoint_not_configured'); return result; }
  let adapter: ChildProcess | undefined;
  let gateway: ChildProcess | undefined;
  try {
    const port = await unusedPort();
    adapter = launch(python, ['-m', 'adapters.laya'], root, { ...env, LAYA_MODEL_PATH: checkpoint, LAYA_ADDR: `127.0.0.1:${port}`, LAYA_THREADS: process.env.LAYA_THREADS ?? '4' }, join(output, 'adapter.log'));
    await ready(adapter, port, 120_000);
    const key = 'synthetic-local-key';
    const input = JSON.parse(readFileSync(join(root, 'examples/english.json'), 'utf8'));
    input.model = 'laya-english';
    input.questions.urgency = { type: 'score', instructions: 'How urgently does this need attention?', criteria: [{ urgency: 'Can wait' }, ['Needs attention soon'], { urgency: 'Immediate danger' }] };
    const catalogue = await request(port, '/v1/models', key);
    const models = JSON.parse(catalogue.body).models;
    const catalogueSchema = validateLayaDocument(root, python, 'ModelMetadataList', JSON.parse(catalogue.body));
    record('catalogue', 'Authenticated catalogue must satisfy the vendored ModelMetadataList schema and describe laya-english with its local capacity limits.', { response: catalogue, schema: catalogueSchema }, catalogueSchema.valid && catalogue.status === 200 && Array.isArray(models) && models.length === 1 && models[0].name === 'laya-english' && typeof models[0].description === 'string' && models[0].description.includes('never truncate'));
    for (const [id, body] of [['models', undefined], ['evaluation', JSON.stringify(input)]] as const) {
      const response = await request(port, id === 'models' ? '/v1/models' : '/v1/systemone', undefined, body);
      record(`unauthenticated-${id}`, 'The local adapter must reject unauthenticated native HTTP requests with 401.', response, response.status === 401);
    }
    const valid = (body: string): boolean => {
      try {
        const value = JSON.parse(body);
        const { department, refund_requested: refund, urgency } = value.answers;
        const unit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
        const distribution = (value: Record<string, unknown>, names: string[]) => value && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key) && unit(value[key])) && Math.abs(Object.values(value).reduce<number>((sum, v) => sum + Number(v), 0) - 1) <= 1e-8;
        return value.model === 'laya-english' && JSON.stringify(Object.keys(value.answers).sort()) === JSON.stringify(Object.keys(input.questions).sort())
          && department.type === 'choice' && department.choice === 'billing' && unit(department.confidence) && distribution(department.probabilities, ['billing', 'technical', 'sales'])
          && refund.type === 'noul' && unit(refund.noul) && !Object.hasOwn(refund, 'confidence')
          && urgency.type === 'score' && unit(urgency.confidence) && Number.isFinite(urgency.score) && urgency.score >= 0 && urgency.score <= 2 && distribution(urgency.probabilities, ['0', '1', '2'])
          && Math.abs(urgency.score - Object.entries(urgency.probabilities).reduce((sum, [level, p]) => sum + Number(level) * Number(p), 0)) <= 1e-8
          && JSON.stringify(urgency.legend) === JSON.stringify(Object.fromEntries(input.questions.urgency.criteria.map((item: Json, index: number) => [String(index), item])))
          && Object.values(value.answers).every(answer => !Object.hasOwn(answer as object, 'action'))
          && Number.isSafeInteger(value.usage.input_tokens) && value.usage.input_tokens > 0 && Number.isSafeInteger(value.usage.output_tokens) && value.usage.output_tokens >= 0;
      } catch { return false; }
    };
    const response = await request(port, '/v1/systemone', key, JSON.stringify(input));
    const responseValue = JSON.parse(response.body);
    const responseSchema = validateLayaDocument(root, python, 'SystemOneResponse', responseValue);
    record('native-inference', 'Actual local inference must satisfy the vendored SystemOneResponse schema and return native Choice, Noul and Score answers for the English refund request, with billing selected, preserved structured score legend, finite probabilities and positive input usage. The refund likelihood must agree with the clear refund request: assess the actual Noul value against the customer text, without an invented probability threshold.', { request: input, response, schema: responseSchema, refund_likelihood: responseValue.answers?.refund_requested?.noul ?? null }, response.status === 200 && responseSchema.valid && valid(response.body));
    for (const [id, change] of [
      ['state-too-long', (value: typeof input) => { value.state = 'word '.repeat(600); }],
      ['literal-mask', (value: typeof input) => { value.state = 'literal [MASK]'; }],
      ['criterion-too-long', (value: typeof input) => { value.questions.department.criteria.billing = 'word '.repeat(60); }],
    ] as const) {
      const invalid = structuredClone(input); change(invalid);
      const response = await request(port, '/v1/systemone', key, JSON.stringify(invalid));
      record(id, 'Inputs containing mask tokens or exceeding token capacity must return 422 without silent truncation.', { request: invalid, response }, response.status === 422);
    }
    const binary = join(root, '.build/one-system');
    if (!existsSync(binary)) { incomplete('go-proxy', 'go_gateway_not_built'); return result; }
    const gatewayPort = await unusedPort();
    const config = join(output, 'backends.json');
    writeFileSync(config, JSON.stringify({ name: 'routing-demo', selector: 'local', backends: [{ id: 'local', base_url: `http://127.0.0.1:${port}`, model: 'laya-english', api_key_env: 'LOCAL_API_KEY', description: 'Local scenario model' }] }), { mode: 0o600 });
    gateway = launch(binary, [], root, { ONE_SYSTEM_CONFIG: config, ONE_SYSTEM_ADDR: `127.0.0.1:${gatewayPort}`, ONE_SYSTEM_API_KEY: 'synthetic-router-key', LOCAL_API_KEY: key }, join(output, 'gateway.log'));
    await ready(gateway, gatewayPort);
    const routedInput = { ...input, model: 'routing-demo' };
    const routed = await request(gatewayPort, '/v1/systemone', 'synthetic-router-key', JSON.stringify(routedInput));
    const routedValue = JSON.parse(routed.body);
    const routedSchema = validateLayaDocument(root, python, 'SystemOneResponse', routedValue);
    record('go-proxy', 'A real Go router must proxy the native request to the local adapter, satisfying the vendored SystemOneResponse schema and returning native model, answers, preserved score legend and usage. The refund likelihood must agree with the clear refund request; assess the actual Noul value against the customer text without an invented probability threshold.', { request: routedInput, response: routed, schema: routedSchema, refund_likelihood: routedValue.answers?.refund_requested?.noul ?? null }, routed.status === 200 && routedSchema.valid && valid(routed.body));
    await stop(gateway);
    record('go-shutdown', 'The Go gateway must exit cleanly on SIGTERM after local adapter inference.', { exit_code: gateway.exitCode, signal: gateway.signalCode }, gateway.exitCode === 0);
    return result;
  } finally {
    try { if (gateway) await stop(gateway); } finally { if (adapter) await stop(adapter); }
    writeFileSync(join(output, 'observations.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  }
}
