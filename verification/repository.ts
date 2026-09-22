/** Executable repository scenarios: synthetic inputs and observed public-tool behavior. */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Json } from './semantic.ts';

type Observation = { id: string; contract: string; observed: Json; passed: boolean };
type Result = { code: number; stdout: string; stderr: string };
// Scope comes from the exercised operation, never its native pass label or a model verdict.
// A completed age-function call is not approval: only an empty failure list approves a lock.
const ageContracts = {
  'registry-artifacts': 'validate_package_age must inspect every wheel and sdist in the supplied registry package, not just the first artifact or the current platform. It must return a policy failure for each missing, invalid or timezone-naive upload time and for each artifact younger than 72 hours, identifying the artifact and its cooldown end for age failures. Exactly 72 hours is allowed, including equivalent timezone offsets. A registry package with no artifacts must return a failure.',
  'virtual-project': 'validate_package_age must exempt the project whose source is exactly {"virtual":"."}: it is not a registry dependency and requires no uploaded artifact or timestamp. With an aware clock and only this virtual project, the function must return an empty failure list.',
  source: 'validate_package_age must return a policy failure for a package source other than a registry source or the exact virtual-project exemption, because its upload age cannot be verified.',
  'package-list': 'validate_package_age must return a policy failure when the supplied lock has no nonempty package list, rather than approving a missing or empty list.',
  'package-entry': 'validate_package_age must return a policy failure for a malformed entry in the supplied package list, rather than ignoring or approving that entry.',
  clock: 'validate_package_age must reject a timezone-naive now argument by raising ValueError with a timezone diagnostic before validating package ages; it must not return an approval or assume the local timezone.',
} as const;
type AgeCase = { id: string; scope: keyof typeof ageContracts; lock: Json; now: string; errors: number; raises?: boolean };

export async function collectRepository(root: string): Promise<Observation[]> {
  const output: Observation[] = [];
  const fixtures = JSON.parse(readFileSync(join(root, 'verification/repository.cases.json'), 'utf8')) as {
    paths: { ignored: string[]; trackable: string[] }; age: AgeCase[];
  };
  const base = join(root, '.build/scenarios');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(base, 'repository-'));
  const env = { PATH: process.env.PATH, HOME: scratch, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const run = (command: string, args: string[], cwd = scratch, input = '', extra: Record<string, string> = {}): Promise<Result> =>
    new Promise(resolve => {
      const child = spawn(command, args, { cwd, env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', expired = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 30_000);
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.once('error', () => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: 'spawn_failed' }); });
      child.once('close', code => { clearTimeout(timer); resolve({ code: expired ? -2 : code ?? -1, stdout, stderr }); });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  const clean = (value: Json): Json => JSON.parse(JSON.stringify(value)
    .split(encodeURIComponent(scratch)).join('<scenario-root-encoded>')
    .split(encodeURIComponent(root)).join('<repository-encoded>')
    .split(scratch).join('<scenario-root>').split(root).join('<repository>'));
  const add = (id: string, contract: string, observed: Json, passed: boolean) => output.push({ id, contract, observed: clean(observed), passed });
  const makeDirectory = (name: string) => { const path = join(scratch, name); mkdirSync(path, { recursive: true }); return path; };
  const copy = (relative: string, directory: string) => {
    const destination = join(directory, relative);
    mkdirSync(join(destination, '..'), { recursive: true }); copyFileSync(join(root, relative), destination);
  };
  const executable = (path: string, body: string) => writeFileSync(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  const pythonLocation = await run(process.env.PYTHON ?? 'python3', ['-c', 'import sys; print(sys.executable)']);
  if (pythonLocation.code !== 0) throw new Error('repository_python_unavailable');
  const python = pythonLocation.stdout.trim();

  const tracked = await run('git', ['ls-files', '-z'], root);
  const pythonFiles = tracked.stdout.split('\0').filter(path => path.endsWith('.py'));
  const testFiles = pythonFiles.filter(path => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(path));
  const frameworkImports = pythonFiles.filter(path => /^(?:from unittest\b|import unittest\b|from pytest\b|import pytest\b)/m.test(readFileSync(join(root, path), 'utf8')));
  add('repository.system-one-tests', 'The tracked-Python inventory must contain no test suite filenames or unittest/pytest framework imports; cross-language checks belong to System One scenarios.',
    { operation: 'Inventory tracked Python files and search test filenames and framework imports', trackedPythonFiles: pythonFiles, testFiles, frameworkImports, gitExit: tracked.code }, tracked.code === 0 && testFiles.length === 0 && frameworkImports.length === 0);

  const ignored = makeDirectory('ignore');
  await run('git', ['init', '--quiet'], ignored);
  for (const path of ['.gitignore', 'hono/.gitignore']) copy(path, ignored);
  for (const [group, paths] of Object.entries(fixtures.paths)) {
    const result = await run('git', ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '--stdin'], ignored, paths.join('\n') + '\n');
    const actual = new Set(result.stdout.trim().split('\n'));
    const mismatches = paths.filter(path => actual.has(path) !== (group === 'ignored'));
    add(`ignore.${group}`, group === 'ignored' ? 'git check-ignore must report every supplied private/generated path as ignored using committed rules alone.' : 'git check-ignore must leave every supplied canonical source, template and lock path unmatched, so it remains trackable using committed rules alone.',
      { operation: 'Query ignore rules, not add or scan the supplied files', command: ['git', '-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '--stdin'], inputPaths: paths,
        ignoreRuleFiles: ['.gitignore', 'hono/.gitignore'], globalGitConfiguration: 'disabled', exit: result.code,
        exitSemantics: '0 means at least one matched path; 1 means no matches; other exits are errors', ignoredPaths: result.stdout.split('\n').filter(Boolean), checked: paths.length }, [0, 1].includes(result.code) && mismatches.length === 0);
  }
  const template = readFileSync(join(root, '.env.example'), 'utf8');
  const templateSyntax = await run('sh', ['-n', join(root, '.env.example')]);
  const blankKeys = ['ONE_SYSTEM_API_KEY', 'LOCAL_API_KEY', 'TYPESAFE_API_KEY'].every(key => template.split('\n').includes(`${key}=''`));
  add('environment.template', 'sh -n must accept .env.example, and its documented API-key assignments must all be blank.',
    { operation: 'Parse the shell template without executing it and inspect its API-key assignment lines', syntaxExit: templateSyntax.code,
      apiKeyAssignments: template.split('\n').filter(line => /^(ONE_SYSTEM_API_KEY|LOCAL_API_KEY|TYPESAFE_API_KEY)=/.test(line)) }, templateSyntax.code === 0 && blankKeys);

  // Python transports the real function result and computes exact timestamp facts.
  // Microseconds matter at the boundary; no policy decisions or expected labels enter this evidence.
  const ageProbe = [
    'import json,sys',
    'from datetime import datetime,timedelta,timezone',
    'from scripts.check_package_age import validate_package_age',
    'results=[]',
    'for case in json.load(sys.stdin):',
    ' now=datetime.fromisoformat(case["now"])',
    ' aware=now.tzinfo is not None and now.utcoffset() is not None',
    ' arithmetic={"minimumAgeMicroseconds":72*60*60*1000000,"clockTimezoneAware":aware,"clockUtc":now.astimezone(timezone.utc).isoformat() if aware else None,"artifacts":[]}',
    ' packages=case["lock"].get("package",[])',
    ' for package_index,package in enumerate(packages if isinstance(packages,list) else []):',
    '  if not isinstance(package,dict) or not isinstance(package.get("source"),dict) or set(package["source"])!={"registry"}: continue',
    '  wheels=package.get("wheels",[])',
    '  artifacts=[(f"wheels[{i}]",artifact) for i,artifact in enumerate(wheels)] if isinstance(wheels,list) else []',
    '  if "sdist" in package: artifacts.append(("sdist",package["sdist"]))',
    '  for location,artifact in artifacts:',
    '   fact={"path":f"lock.package[{package_index}].{location}"}',
    '   try:',
    '    uploaded=datetime.fromisoformat(artifact["upload-time"])',
    '    if uploaded.tzinfo is None or uploaded.utcoffset() is None: raise ValueError("upload time has no timezone")',
    '    uploaded=uploaded.astimezone(timezone.utc)',
    '    eligible=uploaded+timedelta(hours=72)',
    '    fact.update({"uploadUtc":uploaded.isoformat(),"cooldownEndsUtc":eligible.isoformat()})',
    '    if aware: fact.update({"ageMicroseconds":(now-uploaded)//timedelta(microseconds=1),"cooldownRemainingMicroseconds":(eligible-now)//timedelta(microseconds=1)})',
    '   except (KeyError,TypeError,ValueError,OverflowError) as error: fact["timestampParseError"]=str(error)',
    '   arithmetic["artifacts"].append(fact)',
    ' try: result={"returned":True,"errors":validate_package_age(case["lock"],now)}',
    ' except ValueError as error: result={"returned":False,"raises":True,"exception_type":type(error).__name__,"exception_message":str(error)}',
    ' results.append({"output":result,"arithmetic":arithmetic})',
    'print(json.dumps(results))',
  ].join('\n');
  const ages = await run(python, ['-c', ageProbe], root, JSON.stringify(fixtures.age));
  if (ages.code !== 0) throw new Error('repository_age_probe_failed');
  const ageResults = JSON.parse(ages.stdout) as { output: { errors?: string[]; raises?: boolean }; arithmetic: Json }[];
  for (const [index, scenario] of fixtures.age.entries()) {
    const { output: result, arithmetic } = ageResults[index];
    const passed = (scenario.raises ? result.raises === true : Array.isArray(result.errors) && result.errors.length === scenario.errors)
      && (scenario.id !== 'inside-boundary' || Boolean(result.errors?.[0]?.includes('example==1.0') && result.errors[0].includes('2026-09-20T18:00:00.000001+00:00')));
    add(`age.${scenario.id}`, ageContracts[scenario.scope],
      { operation: 'Call scripts.check_package_age.validate_package_age(lock, now) directly; no CLI or installer is invoked',
        returnSemantics: 'returned records normal function completion, not lock approval. errors is the returned policy-failure list: empty accepts, nonempty rejects. An exception also rejects and returns no list.',
        input: { lock: scenario.lock, now: scenario.now }, arithmetic, output: result as Json }, passed);
  }
  const metadata = await run(python, ['-c', 'import json,tomllib; from pathlib import Path; print(json.dumps({"project":tomllib.loads(Path("pyproject.toml").read_text())["tool"]["uv"],"lock":tomllib.loads(Path("uv.lock").read_text())["options"]}))'], root);
  if (metadata.code !== 0) throw new Error('repository_lock_probe_failed');
  const options = JSON.parse(metadata.stdout) as { project: Record<string, Json>; lock: Record<string, Json> };
  const cooldown = options.project['exclude-newer'] === '3 days' && options.lock['exclude-newer-span'] === 'P3D'
    && ![...Object.keys(options.project), ...Object.keys(options.lock)].some(key => key.startsWith('exclude-newer-package'));
  add('lock.cooldown', 'The project and lock metadata must declare the same three-day cooldown without package exemptions.',
    { operation: 'Read pyproject.toml tool.uv and uv.lock options as TOML', projectCooldown: options.project['exclude-newer'] ?? null, lockCooldown: options.lock['exclude-newer-span'] ?? null, packageExemptions: [...Object.keys(options.project), ...Object.keys(options.lock)].filter(key => key.startsWith('exclude-newer-package')) }, cooldown);

  let pending = '', valid = true;
  const packages: Record<string, string> = {};
  const lockText = readFileSync(join(root, 'examples/requirements.lock'), 'utf8');
  for (const raw of lockText.split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    pending += ' ' + line.replace(/\\$/, '').trim(); if (line.endsWith('\\')) continue;
    const [header, ...hashes] = pending.trim().split(' --hash='); pending = '';
    const [pin, ...markers] = header.split(';');
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([0-9][A-Za-z0-9.!+_-]*)$/.exec(pin.trim()); // ubs:ignore — literal package-pin syntax in a regex, not JavaScript loose equality.
    if (!match) { valid = false; continue; }
    const name = match[1].toLowerCase().replace(/[-_.]+/g, '-');
    valid &&= !Object.hasOwn(packages, name) && hashes.length > 0 && hashes.every(hash => /^sha256:[0-9a-f]{64}$/.test(hash))
      && markers.length <= 1 && markers.every(marker => /^[A-Za-z0-9_.<>=!'" ()-]+$/.test(marker.trim()));
    packages[name] = match[2];
  }
  const dependencyText = /^# dependencies = (\[.*\])$/m.exec(readFileSync(join(root, 'examples/skill_suggestion.py'), 'utf8'))?.[1];
  let inline: unknown; try { inline = JSON.parse(dependencyText ?? 'null'); } catch { inline = null; }
  const yaml = (packages.pyyaml ?? '').split('.').map(Number);
  const lockValid = valid && !pending && Object.keys(packages).length > 0 && packages['typesafe-sdk'] === '0.7.0'
    && /^\d+\.\d+\.\d+$/.test(packages.pyyaml ?? '') && yaml[0] === 6 && (yaml[1] > 0 || yaml[2] >= 2)
    && JSON.stringify(inline) === JSON.stringify(['typesafe-sdk==0.7.0', 'PyYAML>=6.0.2,<7']);
  add('lock.examples', 'Example dependencies agree with explicit inline metadata and exact, uniquely named, index-only hashed pins; SDK is 0.7.0 and YAML is at least 6.0.2 below 7.',
    { operation: 'Parse examples/requirements.lock and compare examples/skill_suggestion.py inline dependency metadata', lockText, inlineDependencyText: dependencyText ?? null, packages }, lockValid);

  const doctor = makeDirectory('doctor'); copy('scripts/doctor.py', doctor);
  mkdirSync(join(doctor, 'hono'));
  const doctorScript = join(doctor, 'scripts/doctor.py');
  const node = join(doctor, 'node'), bun = join(doctor, 'bun');
  executable(bun, 'console.log("1.3.11")');
  for (const scenario of ['actual-node', 'bun-alias', 'malformed-lock']) {
    const lockContents = scenario === 'malformed-lock' ? 'not json' : JSON.stringify({ packages: { '': { dependencies: {}, devDependencies: {} } } });
    const nodeVersions: Record<string, string> = scenario === 'bun-alias' ? { node: '24.14.1', bun: '1.3.11' } : { node: '24.14.1' };
    writeFileSync(join(doctor, 'hono/package-lock.json'), lockContents);
    executable(node, `console.log(${JSON.stringify(JSON.stringify(nodeVersions))})`);
    const result = await run(python, [doctorScript, '--profile', 'hono', '--node', node, '--bun', bun], doctor);
    const label = scenario === 'actual-node' ? 'OK: Actual Node 24' : scenario === 'bun-alias' ? 'MISSING: Actual Node 24' : 'MISSING: Hono';
    const remedy = scenario === 'bun-alias' ? '--node /path/to/node' : scenario === 'malformed-lock' ? 'package-lock.json' : 'OK: Actual Node 24';
    const actionable = result.stdout.includes(label) && result.stdout.includes(remedy) && !result.stderr.includes('Traceback');
    // The Hono profile has independent prerequisites; describe the one this fixture varies.
    const contract = scenario === 'actual-node'
      ? 'Doctor must accept the supplied Node 24 version probe without a Bun identity, available Bun runner and valid empty direct-dependency lock, and exit 0 without a traceback.'
      : scenario === 'bun-alias'
        ? 'Doctor must reject the supplied runtime probe containing a Bun identity even when it reports Node 24, exit 1, and identify how to select real Node without a traceback.'
        : 'Doctor must reject the supplied malformed Hono dependency lock, exit 1, and provide a lock/setup remedy without a traceback; valid runtime probes cannot override invalid dependency metadata.';
    add(`doctor.${scenario}`, contract,
      { operation: 'Execute scripts/doctor.py --profile hono with controlled runtime probes', fixture: { profile: 'hono', nodeProbeVersions: nodeVersions, bunProbeVersion: '1.3.11', lockContents }, exit: result.code, diagnostic: result.stdout.trim(), stderr: result.stderr }, result.code === (scenario === 'actual-node' ? 0 : 1) && actionable);
  }
  for (const profile of ['go', 'examples']) {
    const broken = join(doctor, 'broken-env/bin'); mkdirSync(broken, { recursive: true });
    if (!existsSync(join(doctor, 'broken-created'))) { symlinkSync(join(doctor, 'missing-python'), join(broken, 'python')); writeFileSync(join(doctor, 'broken-created'), ''); }
    const args = profile === 'go' ? ['--go', join(doctor, 'missing-go')] : ['--uv', join(doctor, 'missing-uv'), '--example-venv', join(doctor, 'broken-env')];
    const result = await run(python, [doctorScript, '--profile', profile, ...args], doctor);
    const actionable = profile === 'go' ? result.stdout.includes('mise install') : ['MISSING: uv', 'make setup-examples', 'EXAMPLE_VENV'].every(text => result.stdout.includes(text));
    add(`doctor.missing-${profile}`, profile === 'go'
      ? 'Doctor must reject an unavailable Go executable with exit 1, toolchain setup instructions and no traceback.'
      : 'Doctor must reject unavailable uv and a broken example-environment Python link with exit 1, uv/environment setup instructions and no traceback.',
      { operation: `Execute scripts/doctor.py --profile ${profile}`, fixture: { profile, selectedExecutableExists: existsSync(join(doctor, profile === 'go' ? 'missing-go' : 'missing-uv')),
        ...(profile === 'examples' ? { pythonEnvironmentTargetExists: existsSync(join(broken, 'python')) } : {}) }, exit: result.code, diagnostic: result.stdout.trim(), stderr: result.stderr }, result.code === 1 && actionable && !result.stderr.includes('Traceback'));
  }
  const sleepy = join(doctor, 'slow-tool'); executable(sleepy, 'setTimeout(() => console.log("late"), 16_000)');
  // Keep the nonrejecting process result raw until awaited. Parsing in an early
  // .then could reject before the remaining scenarios attach their await.
  const timeoutJob = run(python, ['-c', 'import json,sys; from scripts.doctor import probe; print(json.dumps({"result":probe([sys.argv[1]])}))', sleepy], root);

  for (const target of ['setup-laya', 'setup-laya-mlx']) for (const mature of [false, true]) {
    const directory = makeDirectory(`${target}-${mature}`); copy('Makefile', directory); copy('scripts/check_package_age.py', directory);
    const timestamp = new Date(Date.now() - (mature ? 4 * 86_400_000 : 0)).toISOString();
    writeFileSync(join(directory, 'uv.lock'), `[[package]]\nname="example"\nversion="1.0"\nsource={registry="https://pypi.org/simple"}\nwheels=[{upload-time="${timestamp}"}]\n`);
    const uv = join(directory, 'uv');
    executable(uv, `const fs=require('node:fs'); const cp=require('node:child_process'); const args=process.argv.slice(2); fs.appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n'); if(args[0]==='run'){const r=cp.spawnSync(${JSON.stringify(python)},['scripts/check_package_age.py'],{stdio:'inherit'}); process.exit(r.status??1)} else if(args[0]!=='sync') process.exit(1);`);
    const result = await run('make', [target, 'PYTHON=false', `UV='${uv.replaceAll("'", "'\\''")}'`], directory);
    const calls = readFileSync(join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    const preflight = JSON.stringify(calls[0]) === JSON.stringify(['run', '--no-project', '--python', '3.12', 'python', 'scripts/check_package_age.py']);
    const synchronized = calls.length === 2 && calls[1][0] === 'sync' && calls[1].includes('--locked') && !calls[1].includes('--frozen');
    add(`${target}.${mature ? 'mature' : 'fresh'}`, mature
      ? 'Setup must run the shared 72-hour package-age preflight through uv before package sync; with the supplied four-day-old artifact it must then request locked, not frozen, sync and exit 0 without invoking Make’s PYTHON command (set to false by this fixture).'
      : 'Setup must run the shared 72-hour package-age preflight through uv; with the supplied newly uploaded artifact it must fail before any package sync and report the cooldown without invoking Make’s PYTHON command (set to false by this fixture).',
      { operation: `Execute make ${target} with PYTHON=false and controlled uv`, fixture: { lockText: readFileSync(join(directory, 'uv.lock'), 'utf8'), artifactAgeDaysAtCreation: mature ? 4 : 0,
        uvBehavior: 'Record each invocation; uv run executes the real package-age CLI and propagates its exit; uv sync only records the requested installation and exits 0' },
        exit: result.code, calls, stdout: result.stdout, stderr: result.stderr }, preflight && (mature ? result.code === 0 && synchronized : result.code !== 0 && calls.length === 1 && result.stderr.includes('72-hour')));
  }

  // Observe real Python filesystem activity without making test decisions in Python.
  const scannerAudit = [
    'import json,os,runpy,sys',
    'script,root,report=sys.argv[1:]',
    'root=os.path.abspath(root)',
    'events=[]',
    'def audit(event,args):',
    ' if event not in ("open","shutil.copyfile","os.scandir","os.listdir") or not args or not isinstance(args[0],(str,bytes,os.PathLike)): return',
    ' path=os.path.abspath(os.fsdecode(args[0]))',
    ' if os.path.commonpath((root,path)) == root: events.append({"event":event,"path":os.path.relpath(path,root)})',
    'sys.addaudithook(audit)',
    'sys.argv=[script]',
    'try: runpy.run_path(script,run_name="__main__")',
    'finally:',
    ' with open(report,"w") as output: json.dump(events,output)',
  ].join('\n');
  const git = async (directory: string, args: string[], input = '') => {
    const result = await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Synthetic Fixture',
      '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], directory, input);
    if (result.code !== 0) throw new Error(`repository_git_fixture_failed: ${args[0]}`);
    return result.stdout.trim();
  };
  for (const scenario of ['missing-scanner', 'symlink-ancestor', 'staged-redaction', 'root-alias', 'staged-finding',
    'gitlink-initialized', 'gitlink-missing', 'gitlink-uninitialized', 'gitlink-pin-mismatch', 'gitlink-symlink', 'gitlink-inner-symlink', 'tracked-directory']) {
    const directory = makeDirectory(`scanner-${scenario}`); copy('scripts/check_secrets.py', directory);
    await git(directory, ['init', '--quiet']);
    writeFileSync(join(directory, '.gitignore'), 'bin/\ncalls.jsonl\nscanner-results.jsonl\n.secrets/\n');
    writeFileSync(join(directory, 'public.txt'), 'synthetic public content\n');
    await git(directory, ['add', '--', '.gitignore', 'scripts/check_secrets.py', 'public.txt']);
    const bin = join(directory, 'bin'); mkdirSync(bin);
    const callsFile = join(directory, 'calls.jsonl');
    const resultsFile = join(directory, 'scanner-results.jsonl');
    const auditFile = join(scratch, `scanner-${scenario}-audit.json`);
    if (scenario !== 'missing-scanner') executable(join(bin, 'gitleaks'), `
const fs=require('node:fs'), path=require('node:path');
const args=process.argv.slice(2), exit=${scenario === 'staged-finding' ? "args.includes('--staged')?1:0" : '0'};
function manifest(root, prefix='') {
  return fs.readdirSync(path.join(root,prefix),{withFileTypes:true}).flatMap(entry => {
    const name=path.join(prefix,entry.name);
    return entry.isDirectory()?manifest(root,name):[name];
  }).sort();
}
fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(args)+'\\n');
fs.appendFileSync(${JSON.stringify(resultsFile)},JSON.stringify({args,exit,cwd:process.cwd(),manifest:args[0]==='dir'?manifest(args.at(-1)):null})+'\\n');
process.exit(exit);`);
    const expectedFiles = ['.gitignore', 'public.txt', 'scripts/check_secrets.py'];
    const repositories = ['.'];
    const ignoredCanaries: string[] = [];
    const filesystemChanges: Json[] = [];
    let gitlink: { path: string; indexedCommit: string; head: string | null; nestedPath: string | null; indexEntries: string[] } | null = null;
    if (scenario.startsWith('gitlink-')) {
      const childPath = 'third_party/skills', child = join(directory, childPath);
      mkdirSync(child, { recursive: true });
      await git(child, ['init', '--quiet']);
      writeFileSync(join(child, '.gitignore'), '.secrets/\n');
      writeFileSync(join(child, 'child.ts'), 'export const child = "synthetic";\n');
      mkdirSync(join(child, '.secrets'));
      writeFileSync(join(child, '.secrets/canary.txt'), 'synthetic private child canary\n');
      ignoredCanaries.push(`${childPath}/.secrets/canary.txt`);
      await git(child, ['add', '--', '.gitignore', 'child.ts']);
      let nestedPath: string | null = null;
      if (scenario === 'gitlink-initialized') {
        nestedPath = `${childPath}/nested`;
        const nested = join(directory, nestedPath); mkdirSync(nested);
        await git(nested, ['init', '--quiet']);
        writeFileSync(join(nested, '.gitignore'), '.secrets/\n');
        writeFileSync(join(nested, 'nested.ts'), 'export const nested = "synthetic";\n');
        mkdirSync(join(nested, '.secrets'));
        writeFileSync(join(nested, '.secrets/canary.txt'), 'synthetic private nested canary\n');
        ignoredCanaries.push(`${nestedPath}/.secrets/canary.txt`);
        await git(nested, ['add', '--', '.gitignore', 'nested.ts']);
        await git(nested, ['commit', '--quiet', '-m', 'Synthetic nested fixture']);
        await git(child, ['update-index', '--add', '--cacheinfo', `160000,${await git(nested, ['rev-parse', 'HEAD'])},nested`]);
        writeFileSync(join(child, '.gitmodules'), '[submodule "nested"]\n\tpath = nested\n\turl = ./synthetic-nested\n');
        await git(child, ['add', '--', '.gitmodules']);
        writeFileSync(join(nested, 'nested-draft.ts'), 'export const draft = "synthetic";\n');
        expectedFiles.push(`${childPath}/.gitmodules`, `${nestedPath}/.gitignore`, `${nestedPath}/nested.ts`, `${nestedPath}/nested-draft.ts`);
        repositories.push(nestedPath);
      }
      await git(child, ['commit', '--quiet', '-m', 'Synthetic child fixture']);
      const pin = await git(child, ['rev-parse', 'HEAD']);
      await git(directory, ['update-index', '--add', '--cacheinfo', `160000,${pin},${childPath}`]);
      writeFileSync(join(directory, '.gitmodules'), `[submodule "skills"]\n\tpath = ${childPath}\n\turl = ./synthetic-skills\n`);
      await git(directory, ['add', '--', '.gitmodules']);
      writeFileSync(join(child, 'child-draft.ts'), 'export const draft = "synthetic";\n');
      expectedFiles.push('.gitmodules', `${childPath}/.gitignore`, `${childPath}/child.ts`, `${childPath}/child-draft.ts`);
      repositories.push(childPath);
      gitlink = { path: childPath, indexedCommit: pin, head: pin, nestedPath, indexEntries: (await git(child, ['ls-files', '--stage'])).split('\n').filter(Boolean) };
      if (scenario === 'gitlink-missing' || scenario === 'gitlink-uninitialized') {
        rmSync(child, { recursive: true });
        if (scenario === 'gitlink-uninitialized') mkdirSync(child);
        gitlink.head = null;
        filesystemChanges.push({ path: childPath, action: 'removed initialized repository', replacement: scenario === 'gitlink-uninitialized' ? 'empty directory without its own Git repository' : 'absent path' });
      } else if (scenario === 'gitlink-pin-mismatch') {
        await git(child, ['commit', '--quiet', '--allow-empty', '-m', 'Synthetic mismatching HEAD']);
        gitlink.head = await git(child, ['rev-parse', 'HEAD']);
      } else if (scenario === 'gitlink-symlink') {
        mkdirSync(join(directory, '.secrets'));
        renameSync(child, join(directory, '.secrets/child'));
        symlinkSync(join(directory, '.secrets/child'), child);
        ignoredCanaries.push('.secrets/child/.secrets/canary.txt');
        filesystemChanges.push({ action: 'moved repository and replaced original path with symlink', from: childPath, to: '.secrets/child' });
      } else if (scenario === 'gitlink-inner-symlink') {
        const blob = await git(child, ['hash-object', '-w', '--stdin'], 'synthetic public content');
        await git(child, ['update-index', '--add', '--cacheinfo', `100644,${blob},z-linked/canary.txt`]);
        symlinkSync(join(child, '.secrets'), join(child, 'z-linked'));
        ignoredCanaries.push(`${childPath}/z-linked/canary.txt`);
        gitlink.indexEntries = (await git(child, ['ls-files', '--stage'])).split('\n').filter(Boolean);
      }
    }
    if (scenario === 'symlink-ancestor') {
      const privateDirectory = join(directory, '.secrets'); mkdirSync(privateDirectory); writeFileSync(join(privateDirectory, 'synthetic.txt'), 'synthetic private content');
      const blob = await git(directory, ['hash-object', '-w', '--stdin'], 'synthetic public content');
      await git(directory, ['update-index', '--add', '--cacheinfo', `100644,${blob},public/synthetic.txt`]);
      symlinkSync(privateDirectory, join(directory, 'public'));
      ignoredCanaries.push('.secrets/synthetic.txt', 'public/synthetic.txt');
    } else if (scenario === 'tracked-directory') {
      const blob = await git(directory, ['hash-object', '-w', '--stdin'], 'synthetic tracked file');
      await git(directory, ['update-index', '--add', '--cacheinfo', `100644,${blob},z-directory`]);
      mkdirSync(join(directory, 'z-directory'));
      writeFileSync(join(directory, 'z-directory/canary.txt'), 'synthetic directory canary\n');
      ignoredCanaries.push('z-directory/canary.txt');
      filesystemChanges.push({ path: 'z-directory', indexedMode: '100644', worktreeIsDirectory: lstatSync(join(directory, 'z-directory')).isDirectory(), childPaths: ['z-directory/canary.txt'] });
    }
    const location = scenario === 'root-alias' ? join(scratch, 'scanner-alias') : directory;
    if (location !== directory) symlinkSync(directory, location);
    const linkedPath = scenario === 'symlink-ancestor' ? 'public' : scenario === 'gitlink-symlink' ? gitlink!.path
      : scenario === 'gitlink-inner-symlink' ? `${gitlink!.path}/z-linked` : null;
    // This is fixture setup, not a promised snapshot: later path changes can require
    // rejecting the whole repository before copying even the baseline public files.
    expectedFiles.sort(); repositories.sort();
    const fixture = {
      scanner: { executableExists: existsSync(join(bin, 'gitleaks')), controlledProcess: scenario !== 'missing-scanner',
        configuredExitByPhase: scenario === 'missing-scanner' ? null : scenario === 'staged-finding' ? { current: 0, staged: 1, history: 0 } : { current: 0, staged: 0, history: 0 } },
      repositoryRootIsAlias: lstatSync(location).isSymbolicLink(),
      internalSymlink: linkedPath === null ? null : { path: linkedPath, target: relative(directory, readlinkSync(join(directory, linkedPath))), targetExists: existsSync(join(directory, linkedPath)) },
      stagedPaths: (await git(directory, ['ls-files', '--cached'])).split('\n').filter(Boolean),
      indexEntries: (await git(directory, ['ls-files', '--stage'])).split('\n').filter(Boolean),
      ignoredPrivateDirectory: '.secrets/', ignoredCanaries, gitlink, configuredRepositoryPaths: repositories,
      baselinePublicFiles: expectedFiles, filesystemChanges,
    };
    const result = await run(python, ['-c', scannerAudit, join(location, 'scripts/check_secrets.py'), directory, auditFile], directory, '', { PATH: scenario === 'missing-scanner' ? bin : `${bin}:${env.PATH ?? ''}` });
    const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : [];
    const projected = calls.map(args => args.filter(arg => !arg.startsWith('/')));
    const scannerResults = existsSync(resultsFile) ? readFileSync(resultsFile, 'utf8').trim().split('\n').map(line => {
      const invocation = JSON.parse(line) as { args: string[]; exit: number; cwd: string; manifest: string[] | null };
      return { arguments: invocation.args.filter(arg => !arg.startsWith('/')), cwd: relative(directory, invocation.cwd) || '.', exit: invocation.exit, manifest: invocation.manifest };
    }) : [];
    const filesystemEvents = existsSync(auditFile) ? JSON.parse(readFileSync(auditFile, 'utf8')) as { event: string; path: string }[] : null;
    const copyAttempts = filesystemEvents?.filter(event => event.event === 'shutil.copyfile').map(event => event.path) ?? [];
    const privateAccesses = filesystemEvents?.filter(event => ignoredCanaries.includes(event.path)
      || event.path.split('/').includes('.secrets')) ?? [];
    const rejectedPath = scenario.includes('symlink') || ['gitlink-missing', 'gitlink-uninitialized', 'gitlink-pin-mismatch', 'tracked-directory'].includes(scenario);
    let passed = false;
    if (scenario === 'missing-scanner') passed = result.code === 1 && result.stdout.includes('Gitleaks is required') && calls.length === 0;
    else if (rejectedPath) {
      const diagnostic = scenario.includes('symlink') ? 'symlink' : scenario === 'tracked-directory' ? 'non-file' : 'submodule';
      passed = result.code === 1 && result.stdout.includes(diagnostic) && calls.length === 0 && copyAttempts.length === 0;
    } else if (scenario === 'staged-finding') passed = result.code === 1 && calls.length === 2 && calls[1].includes('--staged') && !result.stdout.includes('Secret scan passed');
    else {
      passed = result.code === 0 && calls.length === 1 + 2 * repositories.length && calls[0][0] === 'dir'
        && scannerResults[0]?.cwd === '.' && JSON.stringify(scannerResults[0]?.manifest) === JSON.stringify(expectedFiles)
        && JSON.stringify([...copyAttempts].sort()) === JSON.stringify(expectedFiles)
        && repositories.every(repository => {
          const phases = scannerResults.filter(invocation => invocation.cwd === repository && invocation.arguments[0] === 'git');
          return phases.length === 2 && phases[0].arguments.includes('--staged') && phases[0].arguments.includes('--pre-commit')
            && phases[1].arguments.includes('--log-opts=--all');
        });
    }
    passed &&= filesystemEvents !== null && privateAccesses.length === 0 && calls.every(args => args.includes('--redact=100'));
    // Preflight rejection and scanning are distinct operations. Invalid fixture inputs
    // demand rejection; they do not themselves constitute a broken scanner contract.
    const contract = scenario === 'missing-scanner'
      ? 'check_secrets.py must exit 1 with a Gitleaks installation remedy when no scanner is available on PATH, before any source copy or scanner invocation; it must not claim a clean scan.'
      : rejectedPath
        ? 'check_secrets.py must reject the supplied unsafe working-tree/index setup with exit 1 and a diagnostic identifying the path problem, before any source copy or scanner invocation, even for earlier safe files. Missing, uninitialized or commit-mismatched indexed gitlinks, any symlink beneath the canonical repository root (including ancestors and paths inside submodules), and ordinary tracked-file entries replaced by directories must all fail this preflight. An initialized pinned gitlink does not excuse an unsafe descendant. Rejection must not claim a clean scan.'
        : 'check_secrets.py must complete source preflight before copying, resolving a repository-root alias to its canonical root without allowing internal symlinks. For these supplied safe inputs, tracked and nonignored files in the root and initialized pinned child/nested repositories must form exactly one current-source snapshot. Scan that snapshot, then staged changes and all Git refs of each repository. Continue only after a zero scanner exit; propagate the first nonzero exit and stop before later phases without a clean-scan claim. Exit 0 only after all requested scans succeed.';
    add(`scanner.${scenario}`, `${contract} Ignored private working-tree files must never be opened, copied or enumerated. Every scanner invocation, if any, must request full redaction.`,
      { operation: 'Execute scripts/check_secrets.py; controlled Gitleaks records calls, snapshot manifests and phase exits, not real secret-detection accuracy',
        fixture, exit: result.code, scannerCalls: projected, scannerResults, filesystemEvents, copyAttempts, privateAccesses, diagnostic: result.stdout.trim(), stderr: result.stderr }, passed);
  }
  const timeout = await timeoutJob;
  let returned: Json = null;
  let parseError = false;
  if (timeout.code === 0) {
    try { returned = JSON.parse(timeout.stdout) as Json; }
    catch { parseError = true; }
  }
  const timedOut = timeout.code === 0 && !parseError && returned !== null && typeof returned === 'object' && !Array.isArray(returned) && returned.result === null;
  add('doctor.timeout', 'doctor.probe must return None (JSON null) when the invoked tool exceeds its 15-second deadline, not return the delayed output as a successful probe. The observing Python process may exit 0 after recording this unavailable result.',
    { operation: 'Call scripts.doctor.probe([slow-tool]) and serialize its return value', fixture: { probeDeadlineMilliseconds: 15_000, toolOutputDelayMilliseconds: 16_000, toolOutput: 'late' }, returned, exit: timeout.code,
      ...(parseError ? { error: 'invalid_probe_json' } : {}) }, timedOut);
  return output.sort((a, b) => a.id.localeCompare(b.id));
}
