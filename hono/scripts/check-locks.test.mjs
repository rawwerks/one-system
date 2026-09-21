import { describe, expect, test } from 'bun:test';
import { checkLocks } from './check-locks.mjs';

function fixture(lockfileVersion = 1) {
  const manifest = { dependencies: { alpha: '1.0.0' } };
  const npm = { lockfileVersion: 3, packages: {
    '': structuredClone(manifest),
    'node_modules/alpha': { version: '1.0.0', integrity: 'sha512-alpha', dependencies: { beta: '^2.0.0' } },
    'node_modules/alpha/node_modules/beta': { version: '2.0.0', integrity: 'sha512-beta' },
  } };
  const bun = { lockfileVersion, workspaces: { '': structuredClone(manifest) }, packages: {
    alpha: ['alpha@1.0.0', '', { dependencies: { beta: '^2.0.0' } }, 'sha512-alpha'],
    'alpha/beta': ['beta@2.0.0', '', {}, 'sha512-beta'],
  } };
  if (lockfileVersion === 2) bun.configVersion = 0;
  return { manifest, npm, bun };
}

describe.each([1, 2])('authoritative npm lock and Bun lock v%i', lockfileVersion => {
  test('accepts equivalent package hoisting without weakening integrity checks', () => {
    const { manifest, npm, bun } = fixture(lockfileVersion);
    bun.packages.beta = bun.packages['alpha/beta'];
    delete bun.packages['alpha/beta'];
    expect(() => checkLocks(manifest, npm, bun)).not.toThrow();
    bun.packages.beta[3] = 'sha512-changed';
    expect(() => checkLocks(manifest, npm, bun)).toThrow();
  });
  test.each(['version', 'integrity'])('rejects transitive %s drift', field => {
    const { manifest, npm, bun } = fixture(lockfileVersion);
    npm.packages['node_modules/alpha/node_modules/beta'][field] = 'changed';
    expect(() => checkLocks(manifest, npm, bun)).toThrow();
  });
  test('rejects dependency edge drift', () => {
    const { manifest, npm, bun } = fixture(lockfileVersion);
    npm.packages['node_modules/alpha'].dependencies.beta = '^3.0.0';
    expect(() => checkLocks(manifest, npm, bun)).toThrow();
  });
  test('rejects an incomplete local import', () => {
    const { manifest, npm, bun } = fixture(lockfileVersion);
    delete bun.packages['alpha/beta'];
    expect(() => checkLocks(manifest, npm, bun)).toThrow();
  });
});

describe('Bun lock format boundaries', () => {
  test('checks manifest drift even without a Bun lock', () => {
    const { manifest, npm } = fixture();
    expect(() => checkLocks(manifest, npm)).not.toThrow();
    manifest.dependencies.alpha = '2.0.0';
    expect(() => checkLocks(manifest, npm)).toThrow();
  });
  test('rejects unknown lock and configuration versions', () => {
    const { manifest, npm, bun } = fixture(2);
    bun.lockfileVersion = 3;
    expect(() => checkLocks(manifest, npm, bun)).toThrow();
    bun.lockfileVersion = 2;
    bun.configVersion = 1;
    expect(() => checkLocks(manifest, npm, bun)).toThrow();
    delete bun.configVersion;
    expect(() => checkLocks(manifest, npm, bun)).toThrow();
  });
  test('rejects a package array even when its tuples match the npm lock', () => {
    const { manifest, npm, bun } = fixture(2);
    bun.packages = Object.values(bun.packages);
    expect(() => checkLocks(manifest, npm, bun)).toThrow();
  });
  test('rejects malformed package metadata rather than treating it as no dependencies', () => {
    const { manifest, npm, bun } = fixture(2);
    bun.packages['alpha/beta'][2] = null;
    expect(() => checkLocks(manifest, npm, bun)).toThrow();
  });
  test('rejects a null lock rather than treating it as an absent file', () => {
    const { manifest, npm } = fixture();
    expect(() => checkLocks(manifest, npm, null)).toThrow();
  });
});
