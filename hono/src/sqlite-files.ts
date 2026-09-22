import { closeSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/** Refuse exposed files rather than silently changing operator permissions. */
export function checkPrivateSQLiteFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    let stats;
    try { stats = lstatSync(path + suffix); } catch (error) {
      if (suffix !== '' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('could not inspect SQLite file');
    }
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
      throw new Error('SQLite database and sidecars must be regular files with mode 0600');
    }
  }
}

export function preparePrivateSQLitePath(path: string): string {
  if (path === '' || /[\0?#]/.test(path) || path.startsWith('file:') || path === ':memory:') {
    throw new Error('SQLite path must be a plain local file path');
  }
  const absolute = resolve(path);
  const parent = dirname(absolute);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stats = lstatSync(parent);
  if (!stats.isDirectory() || (stats.mode & 0o077) !== 0) {
    throw new Error('SQLite directory must be private (0700 or stricter)');
  }
  try { closeSync(openSync(absolute, 'wx', 0o600)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('could not create SQLite file');
  }
  checkPrivateSQLiteFiles(absolute);
  return absolute;
}

/** Separate file families keep cache eviction/schema upgrades independent of audit data. */
export function assertSeparateSQLitePaths(cachePath: string, logPath: string): void {
  if (!cachePath || !logPath) return;
  const canonical = (path: string): string => {
    let current = resolve(path);
    const missing: string[] = [];
    for (;;) {
      try { return resolve(realpathSync(current), ...missing.reverse()); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try {
          lstatSync(current);
        } catch (inspectionError) {
          if ((inspectionError as NodeJS.ErrnoException).code !== 'ENOENT') throw inspectionError;
          missing.push(basename(current));
          current = dirname(current);
          continue;
        }
        throw new Error('could not resolve persistence path');
      }
    }
  };
  const family = (path: string) => ['', '-wal', '-shm', '-journal'].map(suffix => {
    const resolved = canonical(path + suffix);
    let stats;
    try { stats = statSync(resolved); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { path: resolved, stats };
  });
  const cacheFiles = family(cachePath);
  const logFiles = family(logPath);
  for (const cache of cacheFiles) {
    for (const log of logFiles) {
      if (cache.path === log.path || (cache.stats && log.stats && cache.stats.dev === log.stats.dev && cache.stats.ino === log.stats.ino)) {
        throw new Error('ONE_SYSTEM_LOG_PATH must differ from ONE_SYSTEM_CACHE_PATH, including SQLite sidecars');
      }
    }
  }
}
