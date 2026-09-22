import { Hono } from 'hono';
import { INT64_MAX, compact, compareIDs, encodeObject, finiteFloat, object, parseJSON, quote, raw, replaceFields, text, validationView } from './codec.js';
import type { JsonNode, JsonObject } from './codec.js';
import type { Backend, FeatureSelection, GatewayConfig } from './config.js';
import { APIError, BODY_LIMIT, callBackend, captureBounded, deadline, errorResponse, readBoundedBytes } from './transport.js';
import type { GatewayDependencies, Usage } from './transport.js';
import { DecisionCache, configurationRevision } from './cache.js';
import type { CacheSettings, DecisionStore } from './cache.js';
import { LoggingUnavailable } from './logging.js';
import type { CapturedBody, ExchangeLogger, LogExchange } from './logging.js';
import { validateModels, validateRequest, validateResponse } from './generated/validators.js';
import { backendSelectionQuestion, backendSelectionQuestionDigest, openAPIDigest } from './generated/assets.js';
export { loadConfig } from './config.js';
export type { GatewayConfig, ConfigDependencies } from './config.js';
export type { GatewayDependencies } from './transport.js';
export { DecisionCache, loadCacheSettings } from './cache.js';
export type { CacheSettings, CacheSettingsSource, DecisionStore } from './cache.js';
export { ExchangeLogger, loadLogSettings } from './logging.js';
export type { LogRecord, LogStore } from './logging.js';

/** All hosts partition decisions using the same pinned public contract bytes. */
export function createDecisionCache(
  config: GatewayConfig, settings: CacheSettings, store: DecisionStore, now?: () => number,
): DecisionCache {
  return new DecisionCache(settings, store, configurationRevision(config, settings.epoch, {
    openAPI: openAPIDigest, selectorQuestion: backendSelectionQuestionDigest,
  }), now);
}

const selectorID = 'backend';
const encoder = new TextEncoder();
const letter = /\p{L}/u;

// true-up:anchor id=hard-capability-check
interface QuestionShape { readonly kind: string; readonly criteria: bigint }

// Analyze validated questions once; keep their original JSON for forwarding.
function questionShapes(questions: JsonObject): QuestionShape[] {
  return Array.from(questions.fields.values(), node => {
    const q = object(node);
    const criteria = q.fields.get('criteria');
    return {
      kind: text(q.fields.get('type')),
      criteria: BigInt(criteria?.kind === 'object' ? criteria.fields.size : criteria?.kind === 'array' ? criteria.items.length : 0),
    };
  });
}

function supports(backend: Backend, stringState: boolean, questions: readonly QuestionShape[]): boolean {
  const c = backend.capabilities;
  if (!c) return true;
  if (c.maxQuestions !== undefined && BigInt(questions.length) > c.maxQuestions) return false;
  if (c.structuredState === false && !stringState) return false;
  for (const q of questions) {
    if (!c.questionTypes.includes(q.kind)) return false;
    if (q.kind === 'noul') continue;
    if (c.minCriteria !== undefined && q.criteria < c.minCriteria) return false;
    if (c.maxCriteria !== undefined && q.criteria > c.maxCriteria) return false;
  }
  return true;
}

// true-up:end id=hard-capability-check

function summarize(state: JsonNode): { characters: number; non_ascii_letter_fraction: number } {
  const source = compact(raw(state));
  let characters = 0;
  let letters = 0;
  let nonASCII = 0;
  for (const c of source) {
    characters++;
    if (letter.test(c)) {
      letters++;
      if (c.codePointAt(0)! > 127) nonASCII++;
    }
  }
  return { characters, non_ascii_letter_fraction: letters === 0 ? 0 : Math.round(nonASCII / letters * 100) / 100 };
}

function eligibleBackends(config: GatewayConfig, state: JsonNode, questions: readonly QuestionShape[]): string[] {
  const summary = summarize(state);
  let widest = 0n;
  for (const q of questions) {
    if (q.criteria > widest) widest = q.criteria;
  }
  const eligible: string[] = [];
  const capable: string[] = [];
  for (const [id, backend] of config.backends) {
    if (!supports(backend, state.kind === 'string', questions)) continue;
    capable.push(id);
    const limits = backend.limits;
    if (limits) {
      if (limits.maxCharacters !== undefined && BigInt(summary.characters) > limits.maxCharacters) continue;
      if (limits.maxNonASCIILetterFraction !== undefined && summary.non_ascii_letter_fraction > limits.maxNonASCIILetterFraction) continue;
      if (limits.maxQuestions !== undefined && BigInt(questions.length) > limits.maxQuestions) continue;
      if (limits.maxCriteria !== undefined && widest > limits.maxCriteria) continue;
    }
    eligible.push(id);
  }
  if (eligible.length === 0) eligible.push(...capable);
  return eligible.sort(compareIDs);
}

function taskText(questions: JsonObject): string {
  const parts: string[] = [];
  for (const id of Array.from(questions.fields.keys()).sort(compareIDs)) {
    const instructions = object(questions.fields.get(id)).fields.get('instructions');
    if (instructions === undefined || instructions.kind === 'null') continue;
    const content = instructions.kind === 'string' ? instructions.value : raw(instructions);
    if (content !== '') parts.push(content);
  }
  return parts.join(' ');
}

function escalates(selection: FeatureSelection, answers: JsonObject): boolean {
  for (const rule of selection.rules) {
    try {
      const answer = object(answers.fields.get(rule.question));
      // Go decodes every known float64 field in the rule-answer struct before
      // choosing a value. Overflow anywhere in that typed view invalidates it.
      const noul = finiteFloat(answer.fields.get('noul'));
      const score = finiteFloat(answer.fields.get('score'));
      const probabilities = answer.fields.get('probabilities');
      const choices = new Map<string, number>();
      if (probabilities !== undefined && probabilities.kind !== 'null') {
        for (const [name, value] of object(probabilities).fields) choices.set(name, finiteFloat(value));
      }
      const type = text(answer.fields.get('type'));
      const value = type === 'noul' ? noul : type === 'score' ? score : type === 'choice' ? choices.get(rule.choice) ?? 0 : 0;
      if (value > rule.above) return true;
    } catch {
      // Unreadable feature answers never provide evidence for disclosure.
    }
  }
  return false;
}

async function systemOne(
  request: Request, config: GatewayConfig, fetcher: typeof fetch, template: JsonObject,
  cache: DecisionCache | undefined, responseHeaders: Record<string, string>,
  logging?: { logger: ExchangeLogger; requestID: string }, captured?: CapturedBody,
): Promise<Response> {
  let received: Uint8Array;
  if (captured) {
    if (!captured.complete) throw new APIError(422, 'invalid_body', 'Request body is unreadable or exceeds 8 MiB');
    received = captured.bytes;
  } else {
    const bodyRead = deadline(request.signal, 30_000);
    try { received = await readBoundedBytes(request.body, BODY_LIMIT, bodyRead.signal); } catch {
      throw new APIError(422, 'invalid_body', 'Request body is unreadable or exceeds 8 MiB');
    } finally { bodyRead.close(); }
  }
  // Cache identity uses received bytes, never a lossy UTF-8 round trip.
  const source = new TextDecoder('utf-8', { ignoreBOM: true }).decode(received);
  let original: JsonObject;
  try {
    original = object(parseJSON(source));
    if (!validateRequest(validationView(original))) throw new Error('Invalid request');
  } catch {
    throw new APIError(422, 'schema_validation', 'Request does not match the official SystemOneRequest schema');
  }
  let model: string;
  let questions: JsonObject;
  try {
    model = text(original.fields.get('model'));
    questions = object(original.fields.get('questions'));
  } catch {
    throw new APIError(422, 'invalid_request', 'Request could not be decoded');
  }
  if (model !== config.name && !config.backends.has(model)) throw new APIError(422, 'unsupported_model', 'Unknown model; see GET /v1/models');
  const operation = deadline(request.signal, 300_000);
  try {
    const state = original.fields.get('state')!;
    const shapes = questionShapes(questions);
    const eligible = model === config.name ? eligibleBackends(config, state, shapes) : supports(config.backends.get(model)!, state.kind === 'string', shapes) ? [model] : [];
    if (eligible.length === 0) throw new APIError(422, 'unsupported_capability', 'No requested backend supports these inputs');
    let selectorRequest: { backend: Backend; payload: string; questions: JsonObject } | undefined;
    if (eligible.length > 1) {
      let selectorState: string;
      let selectorQuestions: JsonObject;
      if (config.selection) {
        selectorState = JSON.stringify({ request: taskText(questions) });
        selectorQuestions = config.selection.questions;
      } else {
        const capabilities = encodeObject(eligible.map(id => [id, quote(config.backends.get(id)!.description)] as const));
        const question = replaceFields(template, new Map([['criteria', capabilities]]));
        selectorQuestions = object(parseJSON(encodeObject([[selectorID, question]])));
        selectorState = config.selector === config.fallback ? raw(state) : encodeObject([
          ['question_definitions', '[' + Array.from(questions.fields.keys()).sort(compareIDs).map(id => raw(questions.fields.get(id)!)).join(',') + ']'],
          ['input_summary', JSON.stringify(summarize(state))],
        ]);
      }
      const backend = config.backends.get(config.selector)!;
      if (!supports(backend, selectorState.trimStart().startsWith('"'), questionShapes(selectorQuestions))) throw new APIError(422, 'unsupported_capability', 'Selector does not support the routing request');
      const payload = encodeObject([
        ['model', quote(backend.model)], ['state', selectorState], ['questions', raw(selectorQuestions)],
      ]);
      selectorRequest = { backend, payload, questions: selectorQuestions };
    }
    // Reject inference-free failures before looking up a decision.
    let cacheKey = '';
    let releaseCacheKey = () => {};
    if (cache) {
      const outcome = await cache.begin(request, received, questions, operation.signal, responseHeaders);
      cacheKey = outcome.key;
      releaseCacheKey = outcome.release;
      if (outcome.replay !== undefined) {
        releaseCacheKey();
        return new Response(outcome.replay, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
    }
    try {
    let choice = eligible.length === 1 ? eligible[0]! : config.selector;
    let selectionUsage: Usage = { input: 0n, output: 0n };
    if (selectorRequest) {
      let selected;
      try {
        selected = await callBackend(selectorRequest.backend, selectorRequest.payload, selectorRequest.questions, operation.signal, fetcher,
          logging && { ...logging, scope: 'selector' });
      } catch (failure) {
        if (!(failure instanceof APIError) || !config.fallback) throw failure;
        choice = config.fallback;
      }
      if (selected) {
        if (config.selection) {
          selectionUsage = selected.usage;
          choice = escalates(config.selection, selected.answers) ? config.selection.escalateTo : config.fallback;
        } else {
          let confidence: number;
          try {
            const decision = object(selected.answers.fields.get(selectorID));
            choice = text(decision.fields.get('choice'));
            const value = decision.fields.get('confidence');
            if (value?.kind !== 'number') throw new Error('Missing confidence');
            confidence = finiteFloat(value);
            if (confidence < 0 || confidence > 1) throw new Error('Invalid confidence');
          } catch {
            // Successful calls with invalid selector confidence do NOT use the
            // failure fallback: that is the current public Go contract.
            throw new APIError(502, 'invalid_selector', 'Upstream returned an invalid backend selection');
          }
          selectionUsage = selected.usage;
          if (config.fallback && choice !== config.fallback && confidence < config.escalationConfidence) choice = config.fallback;
        }
      }
    }
    const destination = config.backends.get(choice);
    if (!destination) throw new APIError(502, 'invalid_selector', 'Upstream selected an unconfigured backend');
    if (!supports(destination, state.kind === 'string', shapes)) throw new APIError(422, 'unsupported_capability', 'Selected backend does not support these inputs');
    const leaf = await callBackend(destination, replaceFields(original, new Map([['model', quote(destination.model)]])), questions, operation.signal, fetcher,
      logging && { ...logging, scope: 'backend' });
    if (selectionUsage.input > INT64_MAX - leaf.usage.input || selectionUsage.output > INT64_MAX - leaf.usage.output) {
      throw new APIError(502, 'invalid_usage', 'Upstream token usage cannot be aggregated');
    }
    const usage = replaceFields(object(leaf.body.fields.get('usage')), new Map([
      ['input_tokens', String(selectionUsage.input + leaf.usage.input)],
      ['output_tokens', String(selectionUsage.output + leaf.usage.output)],
    ]));
    const response = replaceFields(leaf.body, new Map([['usage', usage]]));
    try {
      if (!validateResponse(validationView(parseJSON(response)))) throw new Error('Invalid response');
    } catch {
      throw new APIError(502, 'invalid_response', 'Upstream response cannot be returned as SystemOneResponse');
    }
    await cache?.remember(cacheKey, leaf.body);
    return new Response(response, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    } finally { releaseCacheKey(); }
  } finally { operation.close(); }
}

// Host-neutral: loadConfig validates registry/secrets/assets, then the same
// application works with app.fetch(Request), Node HTTP, or a Worker fetch event.
export function createGateway(config: GatewayConfig, dependencies: GatewayDependencies = {}): Hono {
  const { cache, logger } = dependencies;
  const automaticModel = {
    name: config.name,
    description: 'A SystemOne Choice selects the configured TypeSafe-compatible backend best suited to the supplied state and questions.',
    release_date: '2026-09-19',
  };
  const ids = Array.from(config.backends.keys()).sort(compareIDs);
  const catalogue = JSON.stringify({ models: [automaticModel, ...ids.map(id => ({
    name: id, description: config.backends.get(id)!.description, release_date: '2026-09-20',
  }))] });
  const capabilities = encodeObject([
    ['version', '1'], ['models', '[' + ids.map(id => encodeObject([
      ['name', quote(id)], ['capabilities', config.backends.get(id)!.capabilities?.json ?? 'null'],
    ])).join(',') + ']'],
  ]);
  if (!validateModels(validationView(parseJSON(catalogue)))) throw new Error('Invalid model catalogue');
  const template = object(parseJSON(backendSelectionQuestion));
  const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const keyHash = crypto.subtle.digest('SHA-256', encoder.encode('Bearer ' + config.publicKey));
  const app = new Hono();
  app.onError((error) => errorResponse(error instanceof APIError ? error : new APIError(500, 'internal_error', 'Request could not be completed')));
  app.notFound(() => errorResponse(new APIError(404, 'not_found', 'Endpoint not found')));
  app.all('*', async context => {
    const request = context.req.raw;
    let path: string;
    let logPath: string;
    try { logPath = new URL(request.url).pathname; } catch { logPath = ''; }
    try { path = decodeURIComponent(logPath); } catch { path = ''; }
    const responseHeaders: Record<string, string> = {};
    let exchange: LogExchange | undefined;
    let captured: CapturedBody | undefined;
    let requestID = '';
    try {
      if (logger) {
        requestID = crypto.randomUUID();
        const bodyRead = deadline(request.signal, 30_000);
        try { captured = await captureBounded(request.body, BODY_LIMIT, bodyRead.signal); }
        finally { bodyRead.close(); }
        // Includes malformed requests, unknown endpoints, and authentication
        // rejects. No routing or inference runs until this append is durable.
        exchange = await logger.begin(requestID, 'gateway', request.method, logPath, captured);
      }
      let response: Response;
      let errorCode: string | undefined;
      try {
        const method = path === '/v1/models' || path === '/v1/capabilities' ? 'GET' : path === '/v1/systemone' ? 'POST' : undefined;
        if (!method) throw new APIError(404, 'not_found', 'Endpoint not found');
        const provided = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(request.headers.get('Authorization') ?? '')));
        const expected = new Uint8Array(await keyHash);
        let difference = 0;
        for (let index = 0; index < expected.length; index++) difference |= provided[index]! ^ expected[index]!;
        if (difference !== 0) {
          responseHeaders['WWW-Authenticate'] = 'Bearer';
          throw new APIError(401, 'unauthorized', 'A valid bearer API key is required');
        }
        if (request.method !== method) {
          responseHeaders.Allow = method;
          throw new APIError(405, 'method_not_allowed', 'Method not allowed');
        }
        response = method === 'GET'
          ? new Response(path === '/v1/capabilities' ? capabilities : catalogue, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
          : await systemOne(request, config, fetcher, template, cache, responseHeaders, logger && { logger, requestID }, captured);
      } catch (failure) {
        // Do not retry the failed upstream event or activate fallback. A final
        // gateway response is a distinct event and may still be committed.
        const error = failure instanceof LoggingUnavailable
          ? new APIError(503, 'logging_unavailable', 'Exchange logging is unavailable')
          : failure instanceof APIError ? failure : new APIError(500, 'internal_error', 'Request could not be completed');
        errorCode = error.code;
        response = errorResponse(error);
      }
      for (const [name, value] of Object.entries(responseHeaders)) response.headers.set(name, value);
      if (exchange) {
        // Audit the generated response, not a claim that the client received it.
        const body = await captureBounded(response.clone().body, BODY_LIMIT, new AbortController().signal);
        await exchange.record('response', body, response.status, response.headers.get('X-One-System-Cache') ?? undefined, errorCode);
      }
      return response;
    } catch (failure) {
      return errorResponse(failure instanceof LoggingUnavailable
        ? new APIError(503, 'logging_unavailable', 'Exchange logging is unavailable')
        : new APIError(500, 'internal_error', 'Request could not be completed'), responseHeaders);
    }
  });
  return app;
}
