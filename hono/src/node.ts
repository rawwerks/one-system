import { createServer } from 'node:http';
import { open } from 'node:fs/promises';
import { getRequestListener } from '@hono/node-server';
import { createDecisionCache, createGateway } from './app.js';
import { CONFIG_LIMIT, loadConfig } from './config.js';
import { APIError, errorResponse } from './transport.js';
import { loadCacheSettings } from './cache.js';
import { NodeDecisionStore } from './cache-store-node.js';
import { ExchangeLogger, loadLogSettings } from './logging.js';
import { NodeLogStore } from './log-store-node.js';
import { assertSeparateSQLitePaths } from './sqlite-files.js';

async function readConfigFile(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const buffer = new Uint8Array(CONFIG_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > CONFIG_LIMIT) throw new Error('Configuration exceeds 1 MiB');
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(buffer.subarray(0, length));
  } finally { await file.close(); }
}

async function main(): Promise<void> {
  const config = await loadConfig(await readConfigFile(process.env.ONE_SYSTEM_CONFIG || 'backends.json'), {
    publicKey: process.env.ONE_SYSTEM_API_KEY ?? '',
    secret: name => process.env[name],
    questions: readConfigFile,
  });
  const address = process.env.ONE_SYSTEM_ADDR || '127.0.0.1:8090';
  const match = /^(?:\[([^\]]+)\]|([^:]*)):([0-9]+)$/.exec(address);
  if (!match || Number(match[3]) > 65535) throw new Error('Invalid ONE_SYSTEM_ADDR');
  const host = match[1] ?? match[2] ?? '';
  const port = Number(match[3]);
  const cacheSettings = loadCacheSettings({
    value: name => process.env[name], storageConfigured: !!process.env.ONE_SYSTEM_CACHE_PATH,
  });
  const logSettings = loadLogSettings({
    value: name => process.env[name], storageConfigured: !!process.env.ONE_SYSTEM_LOG_PATH,
  });
  if (cacheSettings.mode !== 'off' && logSettings.mode !== 'off') assertSeparateSQLitePaths(cacheSettings.path, logSettings.path);
  const logStore = logSettings.mode === 'record' ? await NodeLogStore.open(logSettings.path) : undefined;
  let cacheStore: NodeDecisionStore | undefined;
  try {
    if (cacheSettings.mode !== 'off') cacheStore = await NodeDecisionStore.open(cacheSettings.path, cacheSettings.maxBytes);
  } catch (failure) {
    await logStore?.close();
    throw failure;
  }
  const cache = cacheStore && createDecisionCache(config, cacheSettings, cacheStore);
  const logger = logStore && new ExchangeLogger(logStore);
  const app = createGateway(config, { ...(cache && { cache }), ...(logger && { logger }) });
  const closeStores = async () => {
    try { await cacheStore?.close(); } finally { await logStore?.close(); }
  };
  // The adapter propagates outgoing disconnects into Request.signal. Native
  // globals keep the app.fetch surface identical to the Worker implementation.
  const listener = getRequestListener(request => app.fetch(request), {
    overrideGlobalObjects: false,
    autoCleanupIncoming: true,
    errorHandler: () => errorResponse(new APIError(500, 'internal_error', 'Request could not be completed')),
  });
  const server = createServer({
    maxHeaderSize: 16 << 10,
    headersTimeout: 10_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 60_000,
  }, listener);
  server.setTimeout(310_000, socket => socket.destroy());
  try {
    await cache?.revision;
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(port, host || undefined, () => {
        server.removeListener('error', reject);
        accept();
      });
    });
  } catch (failure) {
    await closeStores();
    throw failure;
  }
  process.stderr.write('one-system listening\n');
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => server.closeAllConnections(), 15_000);
    timeout.unref();
    server.close(() => {
      clearTimeout(timeout);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      void closeStores().catch(() => {
        process.stderr.write('one-system could not close persistence storage\n');
        process.exitCode = 1;
      });
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.on('error', () => {
    process.stderr.write('one-system HTTP server stopped unexpectedly\n');
    process.exitCode = 1;
    stop();
  });
}

void main().catch(() => {
  // Config paths, environment values and raw transport causes are never logged.
  process.stderr.write('one-system could not initialize configuration or listener\n');
  process.exitCode = 1;
});
