/** Verify allowlisted bundle contents and smoke the native binary without inference. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { assets, command, regularAsset, targets } from './package-go.ts';

type Registry = { name: string; backends: { id: string; base_url: string; api_key_env: string }[] };
async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  return address.port;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
}

async function smoke(directory: string, executable: string, launchCwd: string): Promise<void> {
  const calls: string[] = [], failures: unknown[] = [];
  // Ephemeral synthetic credentials, unrelated to any user or provider credential.
  const gatewayKey = randomBytes(24).toString('hex'), backendKey = randomBytes(24).toString('hex');
  const upstream = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, `Bearer ${backendKey}`);
      const parts = [];
      for await (const part of request) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      calls.push(request.url || '');
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, raw]) => {
        const question = raw as { type: string; criteria?: Record<string, unknown> };
        if (question.type === 'choice') {
          const options = Object.keys(question.criteria || {});
          const choice = options.includes('math_or_logic') ? 'math_or_logic' : options[0];
          return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 1 : 0])) }];
        }
        assert.equal(question.type, 'noul');
        return [id, { type: 'noul', noul: 0.9 }];
      }));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'synthetic-model', answers, usage: { input_tokens: 1, output_tokens: 1 } }));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  const upstreamPort = await listen(upstream);
  try {
    for (const file of assets.filter(asset => asset.endsWith('backends.json'))) {
      const registry: Registry = JSON.parse(await readFile(join(directory, file), 'utf8'));
      const env: NodeJS.ProcessEnv = { ONE_SYSTEM_API_KEY: gatewayKey, ONE_SYSTEM_CONFIG: file };
      for (const backend of registry.backends) {
        backend.base_url = `http://127.0.0.1:${upstreamPort}/${backend.id}`;
        env[backend.api_key_env] = backendKey;
      }
      // Only extracted temporary copies change; distributed configs remain untouched.
      await writeFile(join(directory, file), JSON.stringify(registry));
      const reservation = createServer();
      const port = await listen(reservation);
      await close(reservation);
      env.ONE_SYSTEM_ADDR = `127.0.0.1:${port}`;
      const child = spawn(executable, [], { cwd: launchCwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = new Promise<void>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', () => resolveExit());
      });
      // Attach immediately to avoid an unhandled rejection during startup polling.
      void exited.catch(() => {});
      let diagnostic = '';
      child.stderr.on('data', (part: Buffer) => { diagnostic = (diagnostic + part.toString()).slice(-8192); });
      child.stdout.resume();
      const base = `http://127.0.0.1:${port}`, headers = { authorization: `Bearer ${gatewayKey}` };
      try {
        let ready = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Packaged config ${file} failed startup: ${diagnostic}`);
          try {
            const response = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(200) });
            if (response.status === 200) { await response.json(); ready = true; break; }
            await response.arrayBuffer();
          } catch { /* The process may not be listening yet. */ }
          await delay(25);
        }
        assert(ready, `Packaged config ${file} did not become ready: ${diagnostic}`);
        const denied = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(2000) });
        assert.equal(denied.status, 401);
        await denied.arrayBuffer();
        const capabilities = await fetch(`${base}/v1/capabilities`, { headers, signal: AbortSignal.timeout(2000) });
        assert.equal(capabilities.status, 200);
        await capabilities.json();
        if (file === 'examples/jev-lint.backends.json' || file === 'examples/privacy.backends.json') {
          calls.length = 0;
          const privacy = file.includes('privacy');
          const result = await fetch(`${base}/v1/systemone`, {
            method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ model: privacy ? (registry.name) : 'hosted', state: 'Synthetic arithmetic example.', questions: { q: { type: 'noul', instructions: 'Is two plus two four?' } } }),
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(result.status, 200, `${file}: ${await result.clone().text()}`);
          const body = await result.json();
          assert.equal(body.answers.q.noul, 0.9);
          assert.deepEqual(calls, privacy ? ['/local/v1/systemone', '/hosted/v1/systemone'] : ['/hosted/v1/systemone']);
        }
        console.log(`Native startup/auth/capabilities passed: ${file}`);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        try { await exited; } finally { clearTimeout(timer); }
      }
    }
    assert.deepEqual(failures, []);
    console.log('Native direct inference and privacy question-file routing passed (synthetic loopback only).');
  } finally { await close(upstream); }
}

export async function checkPackages(output: string): Promise<void> {
  const checksums = (await readFile(join(output, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  const seen = new Set<string>();
  const nativeTarget = `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
  const scratch = await mkdtemp(join(output, '.verify-'));
  let nativeDirectory: string | undefined;
  try {
    for (const line of checksums) {
      const match = /^([a-f0-9]{64})  (one-system-(linux|darwin)-(amd64|arm64)\.tar\.gz)$/.exec(line);
      assert(match, 'Invalid checksum record');
      const [, expectedHash, archiveName, os, arch] = match;
      assert(!seen.has(archiveName), 'Duplicate checksum record');
      seen.add(archiveName);
      const archive = join(output, archiveName), prefix = archiveName.replace(/\.tar\.gz$/, '');
      assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), expectedHash, `Checksum: ${archiveName}`);
      const expectedFiles = [...assets, 'one-system', 'INSTALL.md', 'THIRD_PARTY_NOTICES.txt', 'build-info.json'].map(path => `${prefix}/${path}`);
      const entries = (await command('tar', ['-tzf', archive])).split('\n');
      assert.deepEqual(entries.filter(entry => !entry.endsWith('/')).sort(), expectedFiles.sort(), `Allowlist: ${archiveName}`);
      assert(entries.filter(entry => entry.endsWith('/')).every(entry => [prefix + '/', prefix + '/examples/'].includes(entry)), 'Unexpected archive directory');
      const modes = (await command('tar', ['-tvzf', archive])).split('\n');
      assert(modes.every(entry => entry.startsWith('-') || entry.startsWith('d')), 'Links and special archive entries are forbidden');
      await command('tar', ['-xzf', archive, '-C', scratch]);
      const directory = join(scratch, prefix), executable = join(directory, 'one-system');
      assert.equal((await lstat(executable)).mode & 0o777, 0o755);
      const binary = await readFile(executable);
      if (os === 'linux') {
        assert.equal(binary.subarray(0, 4).toString('hex'), '7f454c46');
        assert.equal(binary[4], 2, 'ELF must be 64-bit');
        assert.equal(binary.readUInt16LE(18), arch === 'amd64' ? 62 : 183);
      } else {
        assert.equal(binary.readUInt32LE(0), 0xfeedfacf);
        assert.equal(binary.readUInt32LE(4), arch === 'amd64' ? 0x01000007 : 0x0100000c);
      }
      let info;
      try {
        info = JSON.parse(await readFile(join(directory, 'build-info.json'), 'utf8'));
      } catch (cause) {
        throw new Error(`Invalid build metadata: ${archiveName}`, { cause });
      }
      assert.equal(info.target, `${os}-${arch}`);
      assert.equal(info.cgo, false);
      console.log(`Checksum, allowlist and binary architecture passed: ${archiveName}`);
      if (`${os}-${arch}` === nativeTarget) nativeDirectory = directory;
    }
    assert.equal(seen.size, targets.length, 'Expected all four platform bundles');
    assert(nativeDirectory, `No native bundle for this host (${nativeTarget})`);
    await smoke(nativeDirectory, join(nativeDirectory, 'one-system'), nativeDirectory);
    const prefix = join(scratch, "installed gateway's"), bin = join(scratch, "launcher's bin");
    const installer = await regularAsset(resolve(output), 'install.sh');
    await command('sh', [installer, '--from', resolve(output), '--prefix', prefix, '--bin-dir', bin], { cwd: scratch });
    console.log('Installed launcher: exercising all configurations from an unrelated working directory.');
    await smoke(prefix, join(bin, 'one-system'), scratch);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] === '--help') {
    console.log('Usage: node verification/check-go-packages.ts OUTPUT_DIRECTORY\nChecks four bundles, installs the host-native one, and exercises both its binary and installed launcher against synthetic loopback backends.');
    if (process.argv[2] !== '--help') process.exitCode = 1;
  } else await checkPackages(resolve(process.argv[2]));
}
