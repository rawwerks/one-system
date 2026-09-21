// Bun's imported lock is local cache; package-lock.json remains authoritative.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function equal(a, b) {
  return JSON.stringify(canonical(a ?? {})) === JSON.stringify(canonical(b ?? {}));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function checkLocks(manifest, npm, bun) {
  if (npm.lockfileVersion !== 3 || !npm.packages?.['']) {
    throw new Error('Expected npm package-lock.json v3 with a root package.');
  }
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies'];
  for (const field of fields) {
    if (!equal(manifest[field], npm.packages[''][field])) {
      throw new Error(`package.json ${field} differs from package-lock.json; refresh the canonical lock intentionally.`);
    }
  }
  if (bun === undefined) return;
  // Bun 1.4 imports npm locks as v2/configVersion 0; npm package tuples
  // retain the v1 [name@version, registry, metadata, integrity] layout.
  const supportedFormat = (bun?.lockfileVersion === 1 &&
    (bun.configVersion === undefined || bun.configVersion === 0)) ||
    (bun?.lockfileVersion === 2 && bun.configVersion === 0);
  if (!supportedFormat || !isRecord(bun.workspaces) ||
      !isRecord(bun.workspaces['']) || !isRecord(bun.packages)) {
    throw new Error('Unsupported local bun.lock format; preserve it and regenerate from package-lock.json.');
  }
  for (const field of fields) {
    if (!equal(manifest[field], bun.workspaces[''][field])) {
      throw new Error(`Local bun.lock ${field} is stale.`);
    }
  }
  const expected = [];
  for (const [path, pkg] of Object.entries(npm.packages)) {
    if (!path) continue;
    if (!path.startsWith('node_modules/') || pkg.link || !pkg.version || !pkg.integrity) {
      throw new Error(`Unsupported canonical package entry: ${path}`);
    }
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    expected.push({ pkg, spec: `${name}@${pkg.version}` });
  }
  const importedPackages = Object.values(bun.packages);
  for (const imported of importedPackages) {
    if (!Array.isArray(imported) || imported.length !== 4 ||
        typeof imported[0] !== 'string' || typeof imported[1] !== 'string' ||
        !isRecord(imported[2]) || typeof imported[3] !== 'string') {
      throw new Error('Unsupported local bun.lock package entry; preserve it and regenerate from package-lock.json.');
    }
  }
  if (expected.length !== importedPackages.length) {
    throw new Error('Local bun.lock package count differs from package-lock.json.');
  }
  // Bun and npm hoist platform packages differently. Compare package multisets,
  // including dependency edges, rather than their physical install paths.
  for (const { pkg, spec } of expected) {
    const index = importedPackages.findIndex(imported =>
      imported[0] === spec && imported[3] === pkg.integrity);
    if (index < 0) {
      throw new Error(`Local bun.lock version or integrity differs for ${spec}.`);
    }
    const [imported] = importedPackages.splice(index, 1);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      if (!equal(pkg[field], imported[2]?.[field])) {
        throw new Error(`Local bun.lock ${field} differs for ${spec}.`);
      }
    }
  }
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    const read = name => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
    if (existsSync(resolve(root, 'bun.lockb'))) {
      throw new Error('A legacy bun.lockb could shadow the canonical npm lock; preserve and remove it before setup.');
    }
    const bunPath = resolve(root, 'bun.lock');
    const bun = existsSync(bunPath) ? Bun.JSONC.parse(readFileSync(bunPath, 'utf8')) : undefined;
    checkLocks(read('package.json'), read('package-lock.json'), bun);
    console.log('Hono lockfiles agree; package-lock.json is authoritative.');
  } catch (error) {
    console.error(`Hono setup stopped: ${error.message}`);
    console.error('Preserve any local bun.lock you need, then regenerate that ignored file from the reviewed npm lock before retrying.');
    process.exitCode = 1;
  }
}
