import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { collectRepository } from './repository.ts';

test('malformed doctor process output fails its observation without losing other evidence', { timeout: 60_000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const base = join(root, '.build/scenarios');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const fixture = mkdtempSync(join(base, 'malformed-doctor-'));
  const paths = ['verification/repository.cases.json', '.gitignore', 'hono/.gitignore', '.env.example',
    'scripts/check_package_age.py', 'scripts/doctor.py', 'scripts/check_secrets.py',
    'pyproject.toml', 'uv.lock', 'examples/requirements.lock', 'examples/skill_suggestion.py', 'Makefile'];
  for (const path of paths) {
    const destination = join(fixture, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(root, path), destination);
  }
  execFileSync('git', ['init', '--quiet'], { cwd: fixture });
  execFileSync('git', ['add', '--', ...paths], { cwd: fixture });
  const doctor = join(fixture, 'scripts/doctor.py');
  writeFileSync(doctor, `print('synthetic malformed probe output')\n${readFileSync(doctor, 'utf8')}`);
  const rows = await collectRepository(fixture);
  const expected = [...JSON.parse(readFileSync(join(root, 'verification/repository.cases.json'), 'utf8')).age.map((item: { id: string }) => `age.${item.id}`),
    'repository.system-one-tests', 'ignore.ignored', 'ignore.trackable', 'environment.template', 'lock.cooldown', 'lock.examples',
    'doctor.actual-node', 'doctor.bun-alias', 'doctor.malformed-lock', 'doctor.missing-go', 'doctor.missing-examples', 'doctor.timeout',
    'setup-laya.fresh', 'setup-laya.mature', 'setup-laya-mlx.fresh', 'setup-laya-mlx.mature',
    'scanner.missing-scanner', 'scanner.symlink-ancestor', 'scanner.staged-redaction', 'scanner.root-alias', 'scanner.staged-finding',
    'scanner.gitlink-initialized', 'scanner.gitlink-missing', 'scanner.gitlink-uninitialized', 'scanner.gitlink-pin-mismatch',
    'scanner.gitlink-symlink', 'scanner.gitlink-inner-symlink', 'scanner.tracked-directory'];
  assert.deepEqual(rows.map(row => row.id).sort(), expected.sort());
  assert.deepEqual(rows.filter(row => !row.passed).map(row => row.id), ['doctor.timeout']);
  const observed = rows.find(row => row.id === 'doctor.timeout')?.observed;
  assert.ok(observed && typeof observed === 'object' && !Array.isArray(observed));
  assert.equal(observed.returned, null);
  assert.equal(observed.exit, 0);
  assert.equal(observed.error, 'invalid_probe_json');
  const exported = JSON.stringify(rows);
  assert.equal(exported.includes(fixture), false, 'scenario evidence must not disclose the checkout root');
  assert.equal(exported.includes(encodeURIComponent(fixture)), false, 'encoded checkout roots are private too');
  const setup = rows.find(row => row.id === 'setup-laya.mature')?.observed;
  assert.ok(setup && typeof setup === 'object' && !Array.isArray(setup));
  assert.equal(setup.exit, 0);
  assert.match(String(setup.stdout), /sync --locked --python 3\.12/);
});
