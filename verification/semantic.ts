/** System One supplies atomic judgments; ordinary code owns their composition. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ChoiceQuestion = {
  type: 'choice';
  instructions: string | Json[] | { [key: string]: Json };
  criteria: Record<string, Json>;
};
export type ChoiceAnswer = {
  type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number>;
};
export type EvaluationResponse = {
  model: string; answers: Record<string, ChoiceAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};
export type WireEvidence = { requestBody: string; responseBody?: string; responseStatus?: number };
export type EvaluationOptions = {
  endpoint: string; apiKey: string; model: string; expectedModel: string;
  state: Json; questions: Record<string, ChoiceQuestion>; timeoutMs?: number;
  /** Synchronous persistence hook; receives payloads only, never authentication headers. */
  onWire?: (wire: WireEvidence) => void;
};

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const outcomes = ['supports', 'contradicts', 'insufficient_context'];

function fail(message: string): never { throw new Error(message); }
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function content(value: unknown): boolean { return typeof value === 'string' || object(value) || Array.isArray(value); }
function sameKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function answer(value: unknown, criteria: string[]): asserts value is ChoiceAnswer {
  if (!object(value) || value.type !== 'choice' || !text(value.choice)
      || !probability(value.confidence) || !object(value.probabilities)
      || !sameKeys(value.probabilities, criteria)) fail('invalid_answer');
  const distribution = Object.values(value.probabilities);
  if (!distribution.every(probability)) fail('invalid_probabilities');
  // API distributions are rounded; tolerate one hundredth across three choices.
  const sum = distribution.reduce((total, p) => total + p, 0);
  if (Math.abs(sum - 1) > 0.010000001) fail('invalid_probabilities');
  if (!Object.hasOwn(value.probabilities, value.choice)
      || value.probabilities[value.choice] !== Math.max(...distribution)) fail('invalid_choice');
}

function validateResponse(value: unknown, questions: Record<string, ChoiceQuestion>, model: string): asserts value is EvaluationResponse {
  if (!object(value) || value.model !== model) fail('unexpected_response_model');
  if (!object(value.answers) || !sameKeys(value.answers, Object.keys(questions))) fail('invalid_answer_ids');
  for (const [id, question] of Object.entries(questions)) answer(value.answers[id], Object.keys(question.criteria));
  const usage = value.usage;
  if (!object(usage) || !['input_tokens', 'output_tokens'].every(key =>
    Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0)) fail('invalid_usage');
}

function serialize(value: unknown): string {
  let body: string;
  try {
    body = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) fail('invalid_request');
      if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item)) fail('invalid_request');
      return item;
    });
  } catch { fail('invalid_request'); }
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) fail('request_too_large');
  return body;
}

/** endpoint is the complete gateway URL, including /v1/systemone. */
export async function evaluate(options: EvaluationOptions) {
  const { endpoint, apiKey, model, expectedModel, state, questions } = options;
  let url: URL;
  try { url = new URL(endpoint); } catch { fail('invalid_endpoint'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/systemone') fail('invalid_endpoint');
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) fail('invalid_timeout');
  if (!text(apiKey) || /[\r\n]/.test(apiKey) || !text(model) || !text(expectedModel)
      || !content(state) || !object(questions) || Object.keys(questions).length === 0) fail('invalid_request');
  for (const question of Object.values(questions)) {
    if (!object(question) || question.type !== 'choice' || !content(question.instructions)
        || !object(question.criteria) || Object.keys(question.criteria).length < 2
        || Object.keys(question.criteria).length > 255
        || !Object.values(question.criteria).every(value => value === null || content(value))) fail('invalid_request');
  }
  const requestBody = serialize({ model, state, questions });
  // Return the exact serialized snapshot, even if the caller later mutates its input.
  const request = JSON.parse(requestBody) as { model: string; state: Json; questions: Record<string, ChoiceQuestion> };
  const record = (wire: WireEvidence) => {
    try { options.onWire?.(wire); } catch { fail('evidence_write_failed'); }
  };
  record({ requestBody });
  const signal = AbortSignal.timeout(timeoutMs);
  let responseBody: string;
  let responseStatus: number;
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: requestBody, redirect: 'error', signal,
    });
    responseStatus = response.status;
    if (!response.body) fail('invalid_response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); fail('response_too_large'); }
      chunks.push(value);
    }
    try { responseBody = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
    catch { fail('invalid_response_encoding'); }
  } catch (error) {
    if (signal.aborted) fail('evaluation_timeout');
    if (error instanceof Error && ['invalid_response', 'response_too_large', 'invalid_response_encoding'].includes(error.message)) throw error;
    fail('evaluation_transport_error');
  }
  // Persist exact bounded bytes before any HTTP, JSON, model or answer validation.
  record({ requestBody, responseBody, responseStatus });
  if (responseStatus < 200 || responseStatus >= 300) fail('evaluation_http_error');
  let response: unknown;
  try { response = JSON.parse(responseBody); } catch { fail('invalid_response_json'); }
  validateResponse(response, request.questions, expectedModel);
  return { request, response, requestBody, responseBody };
}

/** No invented certainty threshold: retain each distribution and selected judgment. */
export function compose(answers: Record<string, ChoiceAnswer>): {
  status: 'clear' | 'finding' | 'unresolved'; answers: Record<string, ChoiceAnswer>;
} {
  if (!object(answers) || Object.keys(answers).length === 0) fail('invalid_answer_ids');
  let status: 'clear' | 'finding' | 'unresolved' = 'clear';
  for (const value of Object.values(answers)) {
    answer(value, outcomes);
    if (value.choice === 'contradicts') status = 'finding';
    if (value.choice === 'insufficient_context' && status !== 'finding') status = 'unresolved';
  }
  return { status, answers };
}
