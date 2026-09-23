/** A native System One request as a composition leaf, over plain fetch. */
import { component, CompositionError, type Component } from './runtime.mts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Question = { type: 'choice' | 'noul' | 'score'; instructions?: Json; criteria?: Json; [key: string]: Json | undefined };
export type Questions = Record<string, Question>;
export interface SystemOneRequest { model: string; state: Json; questions: Questions }
export interface SystemOneResponse {
  model: string;
  answers: Record<string, { type: string; [key: string]: Json }>;
  usage: { input_tokens: number; output_tokens: number };
}
export interface Connection {
  /** Gateway base URL, e.g. http://127.0.0.1:8090 or https://host/prefix/ */
  readonly endpoint: string;
  readonly apiKey: string;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Resolve an API path under the endpoint, keeping any base path such as /proxy/. */
const at = (endpoint: string, path: string) => new URL(path, endpoint.endsWith('/') ? endpoint : `${endpoint}/`);

/** One request, no retries. Only {model, state, questions} crosses the boundary. */
export async function ask(connection: Connection, request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResponse> {
  const response = await fetch(at(connection.endpoint, 'v1/systemone'), {
    method: 'POST', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${connection.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: request.model, state: request.state, questions: request.questions }),
  });
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new CompositionError('system_one_failed', 'System One response is too large');
  if (!response.ok) {
    let code = `http_${response.status}`;
    try { code = JSON.parse(body)?.detail?.[0]?.type ?? code; } catch { /* keep the status */ }
    throw new CompositionError('system_one_failed', `System One request failed: ${code}`);
  }
  const parsed = JSON.parse(body) as SystemOneResponse;
  const ids = Object.keys(request.questions);
  if (!parsed || typeof parsed.answers !== 'object' || ids.some(id => !parsed.answers[id])) {
    throw new CompositionError('system_one_failed', 'System One response does not answer every question');
  }
  return parsed;
}

/** The same request as a component: one admitted effect, cancelled with the run. */
export function systemOne(name: string, connection: Connection): Component<SystemOneRequest, SystemOneResponse> {
  return component(name, (request, scope) => scope.effect(signal => ask(connection, request, signal)));
}

/** Hard limits a backend declares; null means undeclared (unknown, so not restricted here). */
export interface Capabilities {
  question_types?: readonly string[];
  max_questions?: number;
  min_criteria?: number;
  max_criteria?: number;
  structured_state?: boolean;
}

/**
 * The limits a request to `model` must satisfy, one entry per backend that could
 * serve it. A backend ID yields its own entry; the automatic route name yields
 * every backend, since the gateway accepts a request that any of them supports.
 */
export async function routeCapabilities(connection: Connection, model: string, signal?: AbortSignal): Promise<(Capabilities | null)[]> {
  const get = async (path: string) => {
    const response = await fetch(at(connection.endpoint, path), {
      redirect: 'error', signal, headers: { Authorization: `Bearer ${connection.apiKey}` },
    });
    if (!response.ok) throw new CompositionError('system_one_failed', `${path} failed: http_${response.status}`);
    return response.json();
  };
  const [{ models: catalogue }, { models: profiles }] = await Promise.all([get('v1/models'), get('v1/capabilities')]) as [
    { models: { name: string }[] }, { models: { name: string; capabilities: Capabilities | null }[] }];
  const direct = profiles.find(profile => profile.name === model);
  if (direct) return [direct.capabilities];
  // The catalogue lists the automatic route first, then backend IDs.
  if (catalogue[0]?.name === model) return profiles.map(profile => profile.capabilities);
  throw new CompositionError('unsupported_model', `Gateway does not serve model ${model}`);
}
