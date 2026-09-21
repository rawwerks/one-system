import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { machine, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const installer = fileURLToPath(new URL('../scripts/install.sh', import.meta.url));
const architecture = { x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64' }[machine()];
const target = `${platform()}-${architecture}`;
const bundle = `one-system-${target}`;
const archiveName = `${bundle}.tar.gz`;
let realTar: string;

before(async () => {
  assert.ok(['linux', 'darwin'].includes(platform()) && architecture, 'requires a supported native bundle target');
  assert.ok((await lstat(installer)).isFile(), 'requires the actual installer');
  realTar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
  execFileSync('sh', ['-c', 'command -v sha256sum || command -v shasum'], { stdio: 'pipe' });
  if (platform() === 'darwin') {
    const version = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' });
    assert.ok(Number(version.split('.')[0]) >= 13, 'requires macOS 13 or newer');
  }
});

type Entry = { name: string; type?: '0' | '1' | '2' | '5'; body?: string; link?: string };

// Core Node generates ustar records without GNU tar or a compiler.
// These fixtures check rejection and installed permissions, not gateway runtime.
function archive(entries: Entry[]): Buffer {
  const records: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    let name = entry.name;
    if (Buffer.byteLength(name) > 100) {
      const split = name.lastIndexOf('/', 155);
      assert.ok(split > 0 && Buffer.byteLength(name.slice(0, split)) <= 155);
      header.write(name.slice(0, split), 345, 155, 'utf8');
      name = name.slice(split + 1);
    }
    assert.ok(Buffer.byteLength(name) <= 100);
    assert.ok(Buffer.byteLength(entry.link ?? '') <= 100);
    const body = Buffer.from(entry.body ?? '');
    const octal = (value: number, offset: number, width: number) => {
      header.write(`${value.toString(8).padStart(width - 1, '0')}\0`, offset, width, 'ascii');
    };
    header.write(name, 0, 100, 'utf8');
    octal(entry.type === '5' || entry.name.endsWith('/one-system') ? 0o755 : 0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(body.length, 124, 12);
    octal(0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? '0', 156, 1, 'ascii');
    header.write(entry.link ?? '', 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    records.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]));
}

function bundleEntries(): Entry[] {
  return [
    { name: `${bundle}/`, type: '5' },
    { name: `${bundle}/examples/`, type: '5' },
    ...['one-system', 'INSTALL.md', 'THIRD_PARTY_NOTICES.txt', 'build-info.json', 'backends.json',
      'examples/local.backends.json', 'examples/privacy.backends.json', 'examples/jev-lint.backends.json',
      'examples/simple-jev.backends.json', 'examples/routing.questions.json', 'examples/english.json',
      'examples/multilingual.json'].map(name => ({ name: `${bundle}/${name}`, body: `synthetic ${name}\n` })),
  ];
}

type Snapshot = null | { type: 'link'; target: string } | { type: 'file'; mode: number; contents: string }
  | { type: 'directory'; mode: number; children: Record<string, Snapshot> };

async function snapshot(path: string): Promise<Snapshot> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { type: 'link', target: await readlink(path) };
  if (stat.isFile()) return { type: 'file', mode: stat.mode, contents: (await readFile(path)).toString('hex') };
  assert.ok(stat.isDirectory(), `unexpected fixture entry: ${path}`);
  const children: Record<string, Snapshot> = {};
  for (const name of (await readdir(path)).sort()) children[name] = await snapshot(join(path, name));
  return { type: 'directory', mode: stat.mode, children };
}

type Fixture = {
  root: string; scratch: string; outside: string; source: string; temporary: string;
  prefix: string; binDir: string; launcher: string; home: string;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'osi-'));
  const scratch = join(root, "scratch's space");
  const binDir = join(scratch, "bin's space");
  const fixture: Fixture = {
    root, scratch, binDir, launcher: join(binDir, 'one-system'), outside: join(root, 'protected'),
    source: join(scratch, "source's space"), temporary: join(scratch, "temporary's space"),
    prefix: join(scratch, "install's space", 'one-system'), home: join(scratch, 'home'),
  };
  try {
    for (const path of [fixture.outside, fixture.source, fixture.temporary, fixture.home, binDir]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    await writeFile(join(fixture.outside, 'sentinel'), 'keep this private data\n', { mode: 0o600 });
    await publish(fixture);
    await run(fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function publish(fixture: Fixture, entries = bundleEntries()): Promise<string> {
  const bytes = archive(entries);
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(fixture.source, archiveName), bytes);
  await writeFile(join(fixture.source, 'SHA256SUMS'), `${digest}  ${archiveName}\n`);
  return digest;
}

async function rejectsSafely(fixture: Fixture, environment: NodeJS.ProcessEnv = {}): Promise<void> {
  const before = await Promise.all([snapshot(fixture.prefix), snapshot(fixture.launcher), snapshot(fixture.outside)]);
  const result = spawnSync('sh', [installer, '--from', fixture.source, '--prefix', fixture.prefix, '--bin-dir', fixture.binDir], {
    cwd: fixture.scratch, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, HOME: fixture.home, TMPDIR: fixture.temporary, LC_ALL: 'C', TAR_OPTIONS: '', ...environment },
  });
  const after = await Promise.all([snapshot(fixture.prefix), snapshot(fixture.launcher), snapshot(fixture.outside)]);
  assert.deepEqual(after, before, 'failure must preserve existing targets and protected data, and create no final targets');
  assert.deepEqual((await readdir(fixture.root)).sort(), ['protected', "scratch's space"], 'no writes outside scratch');
  assert.deepEqual(await readdir(fixture.temporary), [], 'installer-owned temporary files must be removed');
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'installer must fail normally, not time out');
  assert.notEqual(result.status, 0, `unsafe input was accepted:\n${result.stdout}\n${result.stderr}`);
}

test('verified archive installs readable data and executable entry points', async () => {
  await withFixture(async fixture => {
    // An inherited umask must not decide installed modes any more than the installer's own private one.
    const result = spawnSync('sh', ['-c', 'umask 027; exec sh "$@"', 'sh', installer,
      '--from', fixture.source, '--prefix', fixture.prefix, '--bin-dir', fixture.binDir], {
      cwd: fixture.scratch, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, HOME: fixture.home, TMPDIR: fixture.temporary, LC_ALL: 'C', TAR_OPTIONS: '' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `verified bundle was not installed:\n${result.stdout}\n${result.stderr}`);
    const modes: Record<string, number> = {};
    const walk = (node: Snapshot, path: string) => {
      assert.ok(node && node.type !== 'link', `unexpected installed entry: ${path}`);
      modes[path] = node.mode & 0o7777;
      if (node.type === 'directory') for (const [name, child] of Object.entries(node.children)) walk(child, `${path}/${name}`);
    };
    walk(await snapshot(fixture.prefix), bundle);
    const expected = Object.fromEntries(bundleEntries().map(entry => [
      entry.name.replace(/\/$/, ''), entry.type === '5' || entry.name === `${bundle}/one-system` ? 0o755 : 0o644,
    ]));
    assert.deepEqual(modes, expected, 'installed modes must match the documented bundle, not the installer umask');
    const launcher = await snapshot(fixture.launcher);
    assert.ok(launcher?.type === 'file' && (launcher.mode & 0o7777) === 0o755, 'launcher must be a 0755 regular file');
    assert.deepEqual(await readdir(fixture.temporary), [], 'installer-owned temporary files must be removed');
    assert.deepEqual((await readdir(fixture.root)).sort(), ['protected', "scratch's space"], 'no writes outside scratch');
  });
});

test('corrupted archive is rejected before tar inspection or extraction', async () => {
  await withFixture(async fixture => {
    const changed = bundleEntries();
    changed.find(entry => entry.name === `${bundle}/one-system`)!.body = 'tampered executable\n';
    await writeFile(join(fixture.source, archiveName), archive(changed));
    const tools = join(fixture.scratch, 'tools');
    const marker = join(fixture.scratch, 'tar-invoked');
    await mkdir(tools);
    // Observe actual tar use without replacing its behavior or trusting diagnostic wording.
    await writeFile(join(tools, 'tar'), '#!/bin/sh\nprintf invoked > "$INSTALL_TEST_TAR_MARKER"\nexec "$INSTALL_TEST_REAL_TAR" "$@"\n', { mode: 0o755 });
    await rejectsSafely(fixture, {
      PATH: `${tools}:${process.env.PATH}`, INSTALL_TEST_REAL_TAR: realTar, INSTALL_TEST_TAR_MARKER: marker,
    });
    assert.equal(await snapshot(marker), null, 'unverified bytes must never reach tar');
  });
});

for (const kind of ['missing', 'duplicate', 'malformed'] as const) {
  test(`${kind} selected checksum entry is rejected without installing`, async () => {
    await withFixture(async fixture => {
      const digest = await publish(fixture);
      const line = `${digest}  ${archiveName}\n`;
      const manifest = kind === 'missing' ? `${digest}  unrelated.tar.gz\n`
        : kind === 'duplicate' ? line + line : `${digest.slice(1)}  ${archiveName}\n`;
      await writeFile(join(fixture.source, 'SHA256SUMS'), manifest);
      await rejectsSafely(fixture);
    });
  });
}

for (const kind of ['traversal', 'absolute', 'symlink', 'hardlink', 'duplicate member'] as const) {
  test(`verified archive containing ${kind} is rejected without filesystem damage`, async () => {
    await withFixture(async fixture => {
      const entries = bundleEntries();
      const sentinel = join(fixture.outside, 'sentinel');
      if (kind === 'traversal' || kind === 'absolute') {
        // Enough parent components to reach / from any scratch extraction directory;
        // the only attack destination is our own protected fixture, never user data.
        const name = kind === 'absolute' ? sentinel : `${'../'.repeat(32)}${sentinel.slice(1)}`;
        entries.push({ name, body: 'overwrite protected data\n' });
      } else if (kind === 'duplicate member') {
        entries.push({ name: `${bundle}/backends.json`, body: 'replacement configuration\n' });
      } else {
        const index = entries.findIndex(entry => entry.name === `${bundle}/backends.json`);
        entries[index] = {
          name: `${bundle}/backends.json`, type: kind === 'symlink' ? '2' : '1',
          link: kind === 'symlink' ? '../../protected/sentinel' : `${bundle}/one-system`,
        };
      }
      await publish(fixture, entries);
      await rejectsSafely(fixture);
    });
  });
}

for (const kind of ['prefix', 'launcher', 'dangling prefix', 'dangling launcher'] as const) {
  test(`existing ${kind} is preserved and blocks installation of the other target`, async () => {
    await withFixture(async fixture => {
      if (kind === 'prefix') {
        await mkdir(fixture.prefix, { recursive: true });
        await writeFile(join(fixture.prefix, 'private-config.json'), 'existing private configuration\n', { mode: 0o600 });
      } else if (kind === 'launcher') {
        await writeFile(fixture.launcher, 'existing user executable\n', { mode: 0o700 });
      } else {
        const destination = kind === 'dangling prefix' ? fixture.prefix : fixture.launcher;
        if (kind === 'dangling prefix') await mkdir(join(fixture.scratch, "install's space"));
        await symlink(join(fixture.outside, 'missing-target'), destination);
      }
      await rejectsSafely(fixture);
    });
  });
}

test('aliased launcher directory inside the install prefix is rejected before creating either target', async () => {
  await withFixture(async fixture => {
    const real = join(fixture.scratch, "real's space");
    const alias = join(fixture.scratch, "alias's space");
    await mkdir(real);
    await writeFile(join(real, 'sentinel'), 'existing sibling data\n', { mode: 0o600 });
    await symlink(real, alias);
    const before = await snapshot(real);
    const prefix = join(real, 'install');
    const binDir = join(alias, 'install', 'bin');
    await rejectsSafely({ ...fixture, prefix, binDir, launcher: join(binDir, 'one-system') });
    assert.deepEqual(await snapshot(real), before, 'resolving overlap must not create parents inside the final prefix');
    assert.equal(await readlink(alias), real, 'the existing directory alias must remain unchanged');
  });
});
