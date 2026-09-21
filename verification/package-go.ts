/** Build reproducible Go release assets. Requires Go, Node 24 and GNU tar. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const targets = ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'] as const;
export const assets = [
  'backends.json',
  'examples/local.backends.json', 'examples/privacy.backends.json',
  'examples/jev-lint.backends.json', 'examples/simple-jev.backends.json',
  'examples/routing.questions.json', 'examples/english.json', 'examples/multilingual.json',
] as const;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function command(executable: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (part: string) => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part: string) => { stderr += part; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolvePromise(stdout.trim()) : reject(new Error(`${executable} failed (${code}): ${stderr.trim()}`)));
  });
}

export async function regularAsset(sourceRoot: string, path: string): Promise<string> {
  const filename = join(sourceRoot, path);
  if (!(await lstat(filename)).isFile() || await realpath(filename) !== join(await realpath(sourceRoot), path)) {
    throw new Error(`Bundle asset must be a regular file without symlink components: ${path}`);
  }
  return filename;
}

export async function packageGo(output: string, selected: readonly string[] = targets): Promise<void> {
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(target => !(targets as readonly string[]).includes(target))) {
    throw new Error(`Targets must be unique entries from: ${targets.join(',')}`);
  }
  const go = process.env.GO || 'go', tar = process.env.GNU_TAR || 'tar';
  const env = { ...process.env, GOTOOLCHAIN: 'local', GOFLAGS: '', GOENV: 'off', GOWORK: 'off', GOEXPERIMENT: '', CGO_ENABLED: '0' };
  const tarVersion = await command(tar, ['--version']);
  if (!tarVersion.includes('GNU tar')) throw new Error('Packaging requires GNU tar (set GNU_TAR=gtar on macOS).');
  const goVersion = await command(go, ['version'], { cwd: root, env });
  // Keep dependency declarations read-only and do not use ambient Go workspaces.
  // Enumerate compiled dependencies, not the larger module graph (which includes
  // test-only modules absent from a fresh cache). This also downloads required modules.
  const modules = await command(go, ['list', '-mod=readonly', '-deps', '-f', '{{if .Module}}{{if not .Module.Main}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{end}}{{end}}', '.'], { cwd: root, env });
  const goRoot = await command(go, ['env', 'GOROOT'], { cwd: root, env });
  let notices = `Third-party notices for the bundled executable\n\nGo standard library\n\n${await readFile(join(goRoot, 'LICENSE'), 'utf8')}\n`;
  for (const module of [...new Set(modules.split('\n').filter(Boolean))].sort()) {
    const [name, version, directory] = module.split('|');
    notices += `\n${name} ${version}\n\n${await readFile(join(directory, 'LICENSE'), 'utf8')}\n`;
  }
  notices += `\nTypeSafe System One API description\n\nThe executable embeds schema/typesafe.openapi.json, TypeSafe's OpenAPI description of the System One API. It is TypeSafe's work and is not covered by One System's MIT license. See schema/README.md in the source repository.\n`;
  for (const asset of [...assets, 'docs/binary-install.md', 'scripts/install.sh']) await regularAsset(root, asset);
  // Refuse to replace or clean any existing directory, including a failed prior build.
  await mkdir(output, { recursive: false });
  const stage = await mkdtemp(join(output, '.stage-'));
  try {
    const settled = await Promise.allSettled(selected.map(async target => {
      const [goos, goarch] = target.split('-');
      const name = `one-system-${target}`, directory = join(stage, name);
      await mkdir(directory, { mode: 0o755 });
      for (const asset of assets) {
        await mkdir(dirname(join(directory, asset)), { recursive: true, mode: 0o755 });
        await copyFile(await regularAsset(root, asset), join(directory, asset));
        await chmod(join(directory, asset), 0o644);
      }
      await copyFile(await regularAsset(root, 'docs/binary-install.md'), join(directory, 'INSTALL.md'));
      await writeFile(join(directory, 'THIRD_PARTY_NOTICES.txt'), notices);
      await writeFile(join(directory, 'build-info.json'), `${JSON.stringify({ target, toolchain: goVersion, cgo: false, flags: ['-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid='] }, null, 2)}\n`);
      for (const file of ['INSTALL.md', 'THIRD_PARTY_NOTICES.txt', 'build-info.json']) await chmod(join(directory, file), 0o644);
      await command(go, ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=', '-o', join(directory, 'one-system'), '.'], {
        cwd: root, env: { ...env, GOOS: goos, GOARCH: goarch, GOAMD64: 'v1', GOARM64: 'v8.0' },
      });
      await chmod(join(directory, 'one-system'), 0o755);
      const tarfile = join(stage, `${name}.tar`);
      await command(tar, ['--format=ustar', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--mode=u+rwX,go+rX,go-w', '-cf', tarfile, '-C', stage, name]);
      const archive = gzipSync(await readFile(tarfile), { level: 9 });
      const filename = `${name}.tar.gz`;
      await writeFile(join(output, filename), archive);
      return `${createHash('sha256').update(archive).digest('hex')}  ${filename}`;
    }));
    const failures = settled.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Packaging failed; retained output is incomplete.');
    const checksums = settled.map(result => (result as PromiseFulfilledResult<string>).value).sort();
    await copyFile(await regularAsset(root, 'scripts/install.sh'), join(output, 'install.sh'));
    await chmod(join(output, 'install.sh'), 0o755);
    await writeFile(join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
    console.log(`Built ${checksums.length} bundles and installer in ${output}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node verification/package-go.ts OUTPUT_DIRECTORY [linux-amd64,linux-arm64,darwin-amd64,darwin-arm64]\nThe output directory must not exist. Defaults to all four targets. Requires Go, Node 24, GNU tar.');
  } else if (args.length < 1 || args.length > 2) {
    console.error('Expected OUTPUT_DIRECTORY and optional comma-separated targets; use --help.');
    process.exitCode = 1;
  } else {
    await packageGo(resolve(args[0]), args[1]?.split(','));
  }
}
