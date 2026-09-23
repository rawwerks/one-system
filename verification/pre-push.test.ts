import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const hook = resolve(import.meta.dirname, '..', '.githooks', 'pre-push');
const zero = '0'.repeat(40);

type Result = { code: number | null; stderr: string };

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}, stdin = ''): Promise<Result> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', code => done({ code, stderr }));
    // A hook may reject and exit before reading its ref list; that EPIPE is not the result under test.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', ...args], cwd);
  assert.equal(result.code, 0, result.stderr);
}

async function head(cwd: string): Promise<string> {
  return (await readFile(join(cwd, '.git', 'refs', 'heads', 'main'), 'utf8')).trim();
}

// The committed gate records each run outside the checkout, so tests can count
// runs and see the hook's environment without depending on the real suite.
async function fixture(gate: string): Promise<{ dir: string; repo: string; env: NodeJS.ProcessEnv; runs: () => Promise<string[]> }> {
  const base = process.env.TMPDIR || join(process.cwd(), '.build');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'pre-push-test-'));
  const repo = join(dir, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(repo, 'Makefile'), `gate:\n\t@echo "git_dir=$$GIT_DIR" >> "$(RUNS)"\n\t${gate}\n`);
  await git(repo, 'add', 'Makefile');
  await git(repo, 'commit', '--quiet', '-m', 'gate');
  const log = join(dir, 'runs.log');
  const env = { ONE_SYSTEM_PRE_PUSH_TARGETS: 'gate', ONE_SYSTEM_PRE_PUSH_DIR: join(dir, 'checkouts'), RUNS: log };
  const runs = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { dir, repo, env, runs };
}

async function push(repo: string, env: NodeJS.ProcessEnv, lines: string[]): Promise<Result> {
  return await run(hook, ['origin', 'https://example.invalid/repo.git'], repo, env, lines.map(line => `${line}\n`).join(''));
}

test('the pushed commit is checked, not the working tree, and git hook variables do not leak', async () => {
  const { dir, repo, env, runs } = await fixture('@true');
  try {
    const sha = await head(repo);
    await writeFile(join(repo, 'Makefile'), 'gate:\n\t@false\n');
    const result = await push(repo, { ...env, GIT_DIR: join(repo, '.git'), GIT_INDEX_FILE: join(repo, '.git', 'index') },
      [`refs/heads/main ${sha} refs/heads/main ${zero}`]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await runs(), ['git_dir=']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failing commit blocks the push and leaves no checkout behind', async () => {
  const { dir, repo, env, runs } = await fixture('@false');
  try {
    const sha = await head(repo);
    const result = await push(repo, env, [`refs/heads/main ${sha} refs/heads/main ${zero}`]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /push blocked/);
    assert.equal((await runs()).length, 1);
    const listed = await new Promise<string>(done => {
      let out = '';
      const child = spawn('git', ['worktree', 'list', '--porcelain'], { cwd: repo });
      child.stdout.on('data', chunk => { out += chunk; });
      child.on('close', () => done(out));
    });
    assert.equal(listed.match(/^worktree /gm)?.length, 1);
    // A failure is never remembered as a pass.
    assert.notEqual((await push(repo, env, [`refs/heads/main ${sha} refs/heads/main ${zero}`])).code, 0);
    assert.equal((await runs()).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deleted refs including notes and other non-branch refs are not checked', async () => {
  const { dir, repo, env, runs } = await fixture('@false');
  try {
    const sha = await head(repo);
    const result = await push(repo, env, [
      `(delete) ${zero} refs/heads/old ${sha}`,
      `(delete) ${zero} refs/notes/mycelium ${sha}`,
      `refs/archive/snapshot ${sha} refs/archive/snapshot ${zero}`,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await runs(), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('note creation blocks the entire push before a preceding branch gets a checkout', async () => {
  const { dir, repo, env, runs } = await fixture('@true');
  try {
    const sha = await head(repo);
    const result = await push(repo, env, [
      `refs/heads/main ${sha} refs/heads/main ${zero}`,
      `refs/notes/mycelium ${sha} refs/notes/mycelium ${zero}`,
    ]);
    assert.notEqual(result.code, 0);
    assert.deepEqual(await runs(), []);
    await assert.rejects(access(join(dir, 'checkouts')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('validation skip cannot publish any notes destination, even from a branch source', async () => {
  const { dir, repo, env, runs } = await fixture('@true');
  try {
    const sha = await head(repo);
    const result = await push(repo, { ...env, ONE_SYSTEM_SKIP_PRE_PUSH: '1' }, [
      `(delete) ${zero} refs/notes/mycelium ${sha}`,
      `refs/heads/main ${sha} refs/heads/main ${zero}`,
      `refs/heads/main ${sha} refs/notes/review/agent ${'1'.repeat(40)}`,
    ]);
    assert.notEqual(result.code, 0);
    assert.deepEqual(await runs(), []);
    await assert.rejects(access(join(dir, 'checkouts')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('validation skip cannot remap a notes source into a branch destination', async () => {
  const { dir, repo, env, runs } = await fixture('@true');
  try {
    const sha = await head(repo);
    const result = await push(repo, { ...env, ONE_SYSTEM_SKIP_PRE_PUSH: '1' }, [
      `refs/notes/mycelium ${sha} refs/heads/exported-notes ${zero}`,
    ]);
    assert.notEqual(result.code, 0);
    assert.deepEqual(await runs(), []);
    await assert.rejects(access(join(dir, 'checkouts')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a tree that already passed is not checked again, including under a tag', async () => {
  const { dir, repo, env, runs } = await fixture('@true');
  try {
    const sha = await head(repo);
    assert.equal((await push(repo, env, [`refs/heads/main ${sha} refs/heads/main ${zero}`])).code, 0);
    const again = await push(repo, env, [
      `refs/heads/main ${sha} refs/heads/main ${zero}`,
      `refs/tags/v1.0.0 ${sha} refs/tags/v1.0.0 ${zero}`,
    ]);
    assert.equal(again.code, 0, again.stderr);
    assert.equal((await runs()).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the documented skip is explicit and reported', async () => {
  const { dir, repo, env, runs } = await fixture('@false');
  try {
    const sha = await head(repo);
    const result = await push(repo, { ...env, ONE_SYSTEM_SKIP_PRE_PUSH: '1' }, [`refs/heads/main ${sha} refs/heads/main ${zero}`]);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /skipped/);
    assert.deepEqual(await runs(), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an object that cannot be resolved blocks the push instead of passing unchecked', async () => {
  const { dir, repo, env } = await fixture('@true');
  try {
    const sha = await head(repo);
    const unknown = await push(repo, env, [`refs/heads/main ${'1'.repeat(40)} refs/heads/main ${zero}`]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /push blocked/);
    // git --git-dir from another directory still exports GIT_DIR to the hook.
    const elsewhere = await run(hook, ['origin', 'https://example.invalid/repo.git'], dir,
      { ...env, GIT_DIR: join(repo, '.git') }, `refs/heads/main ${sha} refs/heads/main ${zero}`);
    assert.equal(elsewhere.code, 0, elsewhere.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a pass under other targets is not a pass for the suite', async () => {
  const { dir, repo, env, runs } = await fixture('@true');
  try {
    const sha = await head(repo);
    await writeFile(join(repo, 'Makefile'), 'gate:\n\t@true\nstrict:\n\t@echo run >> "$(RUNS)"\n\t@false\n');
    await git(repo, 'commit', '--quiet', '-am', 'two targets');
    const tip = await head(repo);
    assert.notEqual(tip, sha);
    assert.equal((await push(repo, env, [`refs/heads/main ${tip} refs/heads/main ${zero}`])).code, 0);
    const strict = await push(repo, { ...env, ONE_SYSTEM_PRE_PUSH_TARGETS: 'strict' }, [`refs/heads/main ${tip} refs/heads/main ${zero}`]);
    assert.notEqual(strict.code, 0);
    assert.deepEqual(await runs(), ['run']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('another worktree whose directory is briefly missing keeps its registration', async () => {
  const { dir, repo, env } = await fixture('@true');
  try {
    const sha = await head(repo);
    const other = join(dir, 'other'), aside = join(dir, 'aside');
    await git(repo, 'worktree', 'add', '--quiet', '--detach', other, sha);
    await rename(other, aside);
    assert.equal((await push(repo, env, [`refs/heads/main ${sha} refs/heads/main ${zero}`])).code, 0);
    await rename(aside, other);
    await git(other, 'status', '--short');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('without an override the suite is check, or check-push on a revision that predates the single gate', async () => {
  const { dir, repo, env, runs } = await fixture('@true');
  try {
    const rules = (names: string[]) => names.map(name => `${name}:\n\t@echo ${name} >> "$(RUNS)"\n`).join('');
    const { ONE_SYSTEM_PRE_PUSH_TARGETS: _, ...defaults } = env;
    await writeFile(join(repo, 'Makefile'), rules(['setup-dev', 'check', 'check-push']));
    await git(repo, 'commit', '--quiet', '-am', 'before the single gate');
    assert.equal((await push(repo, defaults, [`refs/heads/main ${await head(repo)} refs/heads/main ${zero}`])).code, 0);
    await writeFile(join(repo, 'Makefile'), rules(['setup-dev', 'check']));
    await git(repo, 'commit', '--quiet', '-am', 'with the single gate');
    assert.equal((await push(repo, defaults, [`refs/heads/main ${await head(repo)} refs/heads/main ${zero}`])).code, 0);
    assert.deepEqual(await runs(), ['setup-dev', 'check-push', 'setup-dev', 'check']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
