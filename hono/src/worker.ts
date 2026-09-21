import type { Hono } from 'hono';
import { createGateway } from './app.js';
import { loadConfig } from './config.js';
import { object, parseJSON, text } from './codec.js';
import { APIError, errorResponse } from './transport.js';
import { bundledQuestions, bundledRegistry } from './generated/assets.js';

export interface WorkerBindings {
  // Raw registry JSON replaces a file path in a filesystem-free deployment.
  // Alternatively bundle it with ONE_SYSTEM_WORKER_CONFIG during build.
  ONE_SYSTEM_CONFIG_JSON?: string;
  ONE_SYSTEM_API_KEY: string;
  // Optional raw JSON object mapping questions_file names to RAW JSON STRINGS.
  // Bundled versioned assets are used unless a binding explicitly overrides one.
  ONE_SYSTEM_QUESTIONS_JSON?: string;
  // Backend api_key_env names refer to these runtime secret bindings.
  [name: string]: unknown;
}
const applications = new WeakMap<WorkerBindings, Promise<Hono>>();

async function application(bindings: WorkerBindings): Promise<Hono> {
  const source = bindings.ONE_SYSTEM_CONFIG_JSON ?? bundledRegistry;
  if (source === null) throw new Error('Worker registry binding is missing');
  const questions = new Map(bundledQuestions);
  if (bindings.ONE_SYSTEM_QUESTIONS_JSON !== undefined) {
    for (const [name, node] of object(parseJSON(bindings.ONE_SYSTEM_QUESTIONS_JSON)).fields) questions.set(name, text(node));
  }
  const config = await loadConfig(source, {
    publicKey: bindings.ONE_SYSTEM_API_KEY,
    secret: name => typeof bindings[name] === 'string' ? bindings[name] : undefined,
    questions: name => {
      const asset = questions.get(name);
      if (asset === undefined) throw new Error('Selection questions asset is not bound or bundled');
      return asset;
    },
  });
  return createGateway(config);
}

export default {
  async fetch(request: Request, bindings: WorkerBindings): Promise<Response> {
    try {
      let app = applications.get(bindings);
      if (!app) {
        app = application(bindings);
        applications.set(bindings, app);
      }
      return await (await app).fetch(request);
    } catch {
      return errorResponse(new APIError(500, 'gateway_configuration', 'Gateway configuration is unavailable'));
    }
  },
};
