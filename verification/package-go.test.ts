import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { packageGo, regularAsset } from './package-go.ts';
import { checkPackages } from './check-go-packages.ts';

async function fixture(): Promise<string> {
  const base = process.env.TMPDIR || join(process.cwd(), '.build');
  await mkdir(base, { recursive: true });
  return await mkdtemp(join(base, 'package-test-'));
}

test('packaging rejects empty, unknown and duplicate target selections before writing', async () => {
  const dir = await fixture();
  try {
    for (const targets of [[], ['windows-amd64'], ['linux-amd64', 'linux-amd64']]) {
      await assert.rejects(packageGo(join(dir, 'output'), targets), /Targets must be unique/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('bundle assets reject symlinks including parent directories', async () => {
  const dir = await fixture();
  try {
    await mkdir(join(dir, 'real'));
    await writeFile(join(dir, 'real', 'config.json'), '{}');
    assert.equal(await regularAsset(dir, 'real/config.json'), join(dir, 'real', 'config.json'));
    await symlink('real/config.json', join(dir, 'linked.json'));
    await symlink('real', join(dir, 'linked'));
    await assert.rejects(regularAsset(dir, 'linked.json'), /regular file/);
    await assert.rejects(regularAsset(dir, 'linked/config.json'), /regular file/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('corrupt archive fails its checksum before extraction or execution', async () => {
  const dir = await fixture();
  try {
    const name = 'one-system-linux-amd64.tar.gz';
    const original = Buffer.from('synthetic original');
    const digest = createHash('sha256').update(original).digest('hex');
    await writeFile(join(dir, 'SHA256SUMS'), `${digest}  ${name}\n`);
    await writeFile(join(dir, name), 'synthetic corruption');
    await assert.rejects(checkPackages(dir), /Checksum:/);
    assert.equal(await readFile(join(dir, name), 'utf8'), 'synthetic corruption');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('checksum manifest cannot request a path outside the bundle directory', async () => {
  const dir = await fixture();
  try {
    await writeFile(join(dir, 'SHA256SUMS'), `${'0'.repeat(64)}  ../outside.tar.gz\n`);
    await assert.rejects(checkPackages(dir), /Invalid checksum record/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
