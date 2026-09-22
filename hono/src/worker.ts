import type { Hono } from 'hono';
import { createDecisionCache, createGateway } from './app.js';
import { loadConfig } from './config.js';
import { object, parseJSON, text } from './codec.js';
import { APIError, errorResponse } from './transport.js';
import { bundledQuestions, bundledRegistry } from './generated/assets.js';
import { loadCacheSettings } from './cache.js';
import { D1DecisionStore } from './cache-store-d1.js';
import type { D1DatabaseLike } from './cache-store-d1.js';
import { ExchangeLogger, loadLogSettings } from './logging.js';
import { R2LogStore } from './log-store-r2.js';
import type { R2BucketLike } from './log-store-r2.js';

export interface WorkerBindings {
  // Raw registry JSON replaces a file path in a filesystem-free deployment.
  // Alternatively bundle it with ONE_SYSTEM_WORKER_CONFIG during build.
  ONE_SYSTEM_CONFIG_JSON?: string;
  ONE_SYSTEM_API_KEY: string;
  // Optional raw JSON object mapping questions_file names to RAW JSON STRINGS.
  // Bundled versioned assets are used unless a binding explicitly overrides one.
  ONE_SYSTEM_QUESTIONS_JSON?: string;
  ONE_SYSTEM_CACHE_DB?: D1DatabaseLike;
  ONE_SYSTEM_CACHE_MODE?: string;
  ONE_SYSTEM_CACHE_NAMESPACE?: string;
  ONE_SYSTEM_CACHE_EPOCH?: string;
  ONE_SYSTEM_CACHE_TTL?: string;
  ONE_SYSTEM_CACHE_MAX_BYTES?: string;
  ONE_SYSTEM_LOG_BUCKET?: R2BucketLike;
  ONE_SYSTEM_LOG_MODE?: string;
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
  const value = (name: string) => typeof bindings[name] === 'string' ? bindings[name] as string : undefined;
  const cacheSettings = loadCacheSettings({ value, storageConfigured: bindings.ONE_SYSTEM_CACHE_DB !== undefined });
  const logSettings = loadLogSettings({ value, storageConfigured: bindings.ONE_SYSTEM_LOG_BUCKET !== undefined });
  const cache = cacheSettings.mode === 'off' ? undefined
    : createDecisionCache(config, cacheSettings, new D1DecisionStore(bindings.ONE_SYSTEM_CACHE_DB!, cacheSettings.maxBytes));
  const logger = logSettings.mode === 'off' ? undefined
    : new ExchangeLogger(new R2LogStore(bindings.ONE_SYSTEM_LOG_BUCKET!));
  await cache?.revision;
  return createGateway(config, { ...(cache && { cache }), ...(logger && { logger }) });
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
