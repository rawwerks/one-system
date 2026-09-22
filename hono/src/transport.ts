import { INT64_MAX, object, parseJSON, signedInteger, text, validationView } from './codec.js';
import type { JsonObject } from './codec.js';
import type { Backend } from './config.js';
import { validateRequest, validateResponse } from './generated/validators.js';
import type { DecisionCache } from './cache.js';
import type { CapturedBody, ExchangeLogger, LogExchange, LogScope } from './logging.js';

export const BODY_LIMIT = 8 << 20;
// Workers' fixed-length stream preserves Content-Length for local adapters:
// https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#fixedlengthstream
declare const FixedLengthStream: {
  new (length: number): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
};
export class APIError extends Error {
  constructor(readonly status: number, readonly code: string, readonly publicMessage: string) {
    super(publicMessage);
  }
}
export interface Usage { input: bigint; output: bigint }
export interface UpstreamResult { body: JsonObject; answers: JsonObject; usage: Usage }
export interface GatewayDependencies {
  // Explicit seam for Workers service bindings or in-process contract peers.
  // Implementations must honor AbortSignal and redirect:'manual'. No retries.
  readonly fetch?: typeof fetch;
  readonly cache?: DecisionCache;
  readonly logger?: ExchangeLogger;
}

export function deadline(parent: AbortSignal, milliseconds: number): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted) abort();
  else parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, milliseconds);
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
      controller.abort();
    },
  };
}

/** Preserve the exact bounded prefix even when a stream breaks or is too large. */
export async function captureBounded(stream: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<CapturedBody> {
  if (stream === null) return { bytes: new Uint8Array(0), complete: !signal.aborted, ...(signal.aborted ? { error: 'request_canceled' as const } : {}) };
  const reader = stream.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const pieces: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  let error: CapturedBody['error'];
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        const remaining = limit - length;
        const piece = value.byteLength > remaining ? value.slice(0, remaining) : value;
        pieces.push(piece);
        length += piece.byteLength;
        if (value.byteLength > remaining) { error = 'body_exceeds_limit'; break; }
      }
      signal.throwIfAborted();
      if (done) { complete = true; break; }
    }
  } catch {
    error = signal.aborted ? 'request_canceled' : 'body_unreadable';
  } finally {
    signal.removeEventListener('abort', abort);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
  return { bytes, complete, ...(error === undefined ? {} : { error }) };
}

export async function readBoundedBytes(stream: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const body = await captureBounded(stream, limit, signal);
  if (!body.complete) throw new Error('Body is incomplete');
  return body.bytes;
}

export function answersMatch(questions: JsonObject, answers: JsonObject): boolean {
  if (questions.fields.size !== answers.fields.size) return false;
  try {
    for (const [id, questionNode] of questions.fields) {
      const question = object(questionNode);
      const answer = object(answers.fields.get(id));
      const type = text(question.fields.get('type'));
      if (type !== text(answer.fields.get('type'))) return false;
      const choice = answer.fields.get('choice');
      // encoding/json decodes Choice even on score/noul answers if supplied.
      if (choice !== undefined && choice.kind !== 'null' && choice.kind !== 'string') return false;
      if (type === 'choice' && !object(question.fields.get('criteria')).fields.has(text(choice))) return false;
    }
    return true;
  } catch { return false; }
}

export async function callBackend(
  backend: Backend, payload: string, questions: JsonObject, parent: AbortSignal, fetcher: typeof fetch,
  logging?: { logger: ExchangeLogger; requestID: string; scope: Exclude<LogScope, 'gateway'> },
): Promise<UpstreamResult> {
  try {
    if (!validateRequest(validationView(parseJSON(payload)))) throw new Error('Invalid request');
  } catch {
    throw new APIError(500, 'invalid_internal_request', 'Could not construct a valid upstream request');
  }
  let url: URL;
  try { url = new URL(backend.baseURL + '/v1/systemone'); } catch {
    throw new APIError(500, 'upstream_configuration', 'Upstream configuration is invalid');
  }
  const operation = deadline(parent, 180_000);
  let response: Response | undefined;
  let exchange: LogExchange | undefined;
  let captured: CapturedBody = { bytes: new Uint8Array(0), complete: false };
  let failureCode: string | undefined;
  try {
    const bytes = new TextEncoder().encode(payload);
    if (logging) {
      exchange = await logging.logger.begin(logging.requestID, logging.scope, 'POST', url.pathname, {
        bytes: bytes.subarray(0, BODY_LIMIT), complete: bytes.byteLength <= BODY_LIMIT,
        ...(bytes.byteLength > BODY_LIMIT ? { error: 'body_exceeds_limit' as const } : {}),
      });
    }
    try {
      // Fetch may automatically retry HTTP 421 when a body's source is
      // replayable (including a string). A one-shot stream prevents another
      // inference call while retaining the exact validated JSON bytes.
      let body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
      if (typeof FixedLengthStream !== 'undefined') {
        const fixed = new FixedLengthStream(bytes.byteLength);
        // Pump concurrently with fetch: the writable side applies backpressure.
        // Fetch observes stream errors; the operation signal cancels the pump.
        void body.pipeTo(fixed.writable, { signal: operation.signal }).catch(() => {});
        body = fixed.readable;
      }
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST', redirect: 'manual', signal: operation.signal,
        // Only the configured explicit bearer key participates in auth. This
        // also prevents Fetch from attempting an implicit 401 challenge flow.
        credentials: 'omit',
        headers: { Authorization: 'Bearer ' + backend.key, 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': String(bytes.byteLength) },
        body,
        duplex: 'half',
      };
      response = await fetcher(url, init);
    } catch {
      throw new APIError(502, 'upstream_unavailable', 'Upstream request failed');
    }
    // Rejection bodies are captured only when recording is enabled; otherwise
    // preserve the existing immediate rejection and bounded cancellation.
    if (logging || response.status === 200) captured = await captureBounded(response.body, BODY_LIMIT, operation.signal);
    if (response.status !== 200) {
      let status = response.status;
      // Native Fetch may hide 407 as a network failure. Bindings and other
      // hosts that expose it must return the identical sanitized public error.
      if (status === 407) throw new APIError(502, 'upstream_unavailable', 'Upstream request failed');
      if (status < 400 || status > 599 || status === 400 || status === 401 || status === 403) status = 502;
      throw new APIError(status, 'upstream_rejected', 'Upstream could not complete the request');
    }
    let body: JsonObject;
    try {
      if (!captured.complete) throw new Error('Incomplete response');
      body = object(parseJSON(new TextDecoder('utf-8', { ignoreBOM: true }).decode(captured.bytes)));
      if (!validateResponse(validationView(body))) throw new Error('Invalid response');
    } catch {
      throw new APIError(502, 'invalid_upstream_response', 'Upstream returned an invalid SystemOneResponse');
    }
    let answers: JsonObject;
    let usage: Usage;
    try {
      answers = object(body.fields.get('answers'));
      const tokenUsage = object(body.fields.get('usage'));
      usage = { input: signedInteger(tokenUsage.fields.get('input_tokens')), output: signedInteger(tokenUsage.fields.get('output_tokens')) };
      if (usage.input < 0n || usage.output < 0n || usage.input > INT64_MAX || usage.output > INT64_MAX) throw new Error('Invalid usage');
    } catch {
      throw new APIError(502, 'invalid_upstream_response', 'Upstream returned invalid answers or token usage');
    }
    if (!answersMatch(questions, answers)) throw new APIError(502, 'mismatched_answers', 'Upstream answers do not match the requested question IDs, types, or choices');
    return { body, answers, usage };
  } catch (failure) {
    failureCode = failure instanceof APIError ? failure.code : 'upstream_unavailable';
    throw failure;
  } finally {
    // Keep the timeout and caller cancellation alive through the COMPLETE body.
    // Unread rejections are canceled; recording never drains beyond BODY_LIMIT.
    operation.close();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    if (exchange) await exchange.record('response', captured, response?.status ?? 0, undefined, failureCode);
  }
}

export function errorResponse(failure: APIError, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify({ detail: [{ loc: ['body'], msg: failure.publicMessage, type: failure.code }] }) + '\n', {
    status: failure.status, headers,
  });
}
