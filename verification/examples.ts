/** Executable consumer scenarios. Python runs applications, never test expectations. */
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, symlinkSync, copyFileSync, renameSync, lstatSync, readlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from './semantic.ts';

type ObjectValue = { [key: string]: any };
type Run = { exit: number; stdout: string; stderr: string };
type Record = { id: string; contract: string; observed: Json; passed: boolean };
type Reply = { status?: number; body: ObjectValue };
const clone = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const parse = (text: string): any => { try { return JSON.parse(text); } catch { throw new Error('consumer_scenario_invalid_json'); } };
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ids = ['notes-organize', 'slides-author', 'slides-edit', 'tables-audit'];
const short = ['slides-author', 'slides-edit', 'notes-organize'];
const request = 'Create a presentation from my outline.';
const choice = (winner: string, probabilities: ObjectValue): ObjectValue => ({ type: 'choice', choice: winner, confidence: .8, probabilities });
const response = (answers: ObjectValue): ObjectValue => ({ model: 'routing-demo', answers, usage: { input_tokens: 4, output_tokens: 2 } });
const rank = (acts = .8, procedure = .8, prose = .1, probabilities = Object.fromEntries(ids.map((id, i) => [id, [.15, .5, .3, .05][i]]))): ObjectValue => response({
  which: choice(Object.keys(probabilities).sort((a, b) => probabilities[b] - probabilities[a])[0], probabilities),
  'gate::acts_on_user_system': { type: 'noul', noul: acts },
  'gate::would_follow_documented_procedure': { type: 'noul', noul: procedure },
  'gate::prose_suffices': { type: 'noul', noul: prose },
});
const finalChoice = (fits = [.8, .2, .1], shortlist = short, winner = 'slides-author'): ObjectValue => response({
  which: choice(winner, Object.fromEntries(shortlist.map(id => [id, id === winner ? (shortlist.length === 1 ? 1 : .8) : .2 / (shortlist.length - 1)]))),
  ...Object.fromEntries(shortlist.map((id, i) => [`fits::${id}`, { type: 'noul', noul: fits[i] }])),
});

// This is only an FFI adapter: JSON -> production function -> JSON. No scenarios,
// expected values, assertions, simulated transport, or application decisions live here.
const bridge = `import dataclasses, importlib, json, sys
from pathlib import Path
spec=json.load(sys.stdin)
args=spec.get("args", [])
for i in spec.get("path_args", []): args[i]=Path(args[i])
try:
 value=getattr(importlib.import_module(spec["module"]), spec["function"])(*args, **spec.get("kwargs", {}))
 print(json.dumps({"ok":True,"value":value},default=lambda v: {f.name:getattr(v,f.name) for f in dataclasses.fields(v) if not f.name.startswith("_")}))
except Exception as error:
 print(json.dumps({"ok":False,"error":type(error).__name__,"code":getattr(error,"code",None)}))
`;

export async function collectExamples(root: string): Promise<Record[]> {
  const build = join(root, '.build');
  mkdirSync(build, { recursive: true });
  const scratch = mkdtempSync(join(build, 'consumer-scenarios-'));
  const python = process.env.PYTHON || join(process.env.EXAMPLE_VENV || join(build, 'example-venv'), 'bin', 'python');
  const records: Record[] = [];
  const clean = (value: unknown): Json => parse(JSON.stringify(value)
    .split(encodeURIComponent(scratch)).join('<scenario-root-encoded>').split(encodeURIComponent(root)).join('<repository-encoded>')
    .split(scratch).join('<scenario-root>').split(root).join('<repository>'));
  const record = (id: string, contract: string, observed: unknown, passed: boolean): void => { records.push({ id, contract, observed: clean(observed), passed }); };
  const save = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600 });
  const read = (path: string): ObjectValue => parse(readFileSync(path, 'utf8'));
  const excerpt = (file: string, functions: string[]): string => {
    const lines = readFileSync(join(root, 'examples', file + '.py'), 'utf8').split('\n');
    return functions.map(name => {
      const begin = lines.findIndex(line => line.startsWith(`def ${name}(`) || line.startsWith(`class ${name}(`) || line.startsWith(`class ${name}:`));
      if (begin < 0) throw new Error('consumer_policy_source_missing');
      let end = begin + 1;
      while (end < lines.length && !/^(def |class |if __name__)/.test(lines[end])) end++;
      return `${file}.py:${begin + 1}\n${lines.slice(begin, end).map(line => line.replace(/\s+# ubs:ignore.*$/, '')).join('\n').trim()}`;
    }).join('\n\n');
  };
  // Describe only the synthetic filesystem we created, without following links.
  const fixturePath = (path: string): ObjectValue => {
    if (!path.startsWith(scratch + '/')) return { kind: 'unbound', supplied: path };
    if (!existsSync(path)) return { kind: 'missing', path };
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { kind: 'symlink', path, target: readlinkSync(path) };
    if (stat.isDirectory()) return { kind: 'directory', path, entries: Object.fromEntries(readdirSync(path).sort().map(name => [name, fixturePath(join(path, name))])) };
    return { kind: 'file', path, bytes: stat.size, ...(stat.size <= 8192 ? { content: readFileSync(path, 'utf8') } : { prefix: readFileSync(path, 'utf8').slice(0, 80), contentOmitted: true }) };
  };
  const env = { PATH: process.env.PATH || '', HOME: scratch, TMPDIR: scratch, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONPATH: join(root, 'examples') };
  const run = (args: string[], extra: { [key: string]: string } = {}, input = ''): Promise<Run> => new Promise((resolve, reject) => {
    const child = spawn(python, args, { cwd: root, env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', overflow = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 2 ** 21) { overflow = true; child.kill('SIGKILL'); } });
    child.stderr.on('data', data => { stderr += data; if (stderr.length > 2 ** 21) { overflow = true; child.kill('SIGKILL'); } });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ exit: overflow ? -2 : code ?? -1, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  const call = async (module: string, fn: string, args: unknown[], pathArgs: number[] = [], kwargs = {}): Promise<ObjectValue> => {
    const result = await run(['-c', bridge], {}, JSON.stringify({ module, function: fn, args, path_args: pathArgs, kwargs }));
    if (result.exit !== 0) throw new Error('consumer_function_bridge_failed'); // ubs:ignore[javascript.ctcompare.unsafe_secret_compare] Public process exit status, not a secret.
    return parse(result.stdout);
  };
  const cli = (name: string, args: string[], extra: { [key: string]: string } = {}): Promise<Run> => run([join(root, 'examples', name + '.py'), ...args], extra);
  const serializableRun = (result: Run): ObjectValue => ({ exit: result.exit, output: result.stdout.trim(), diagnostic: result.stderr.trim(), leaksRoot: result.stdout.includes(scratch) || result.stderr.includes(scratch), traceback: result.stderr.includes('Traceback') });

  async function server<T>(handler: (body: ObjectValue, path: string) => Reply | Promise<Reply>, use: (endpoint: string, calls: ObjectValue[]) => Promise<T>): Promise<T> {
    const calls: ObjectValue[] = [];
    const service = createServer(async (req: IncomingMessage, res) => {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: 'routing-demo', description: 'Synthetic automatic route', release_date: '2026-09-20' }, { name: 'fixture', description: 'Synthetic server', release_date: '2026-09-20' }] }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const call: ObjectValue = { path: req.url, body, authorized: req.headers.authorization === 'Bearer public-loopback-fixture' };
        calls.push(call);
        const reply = await handler(body, req.url || '');
        call.response = { status: reply.status || 200, body: clone(reply.body) };
        res.statusCode = reply.status || 200;
        res.setHeader('content-type', 'application/json');
        if (res.statusCode === 307) res.setHeader('location', '/redirect-trap');
        res.end(JSON.stringify(reply.body));
      } catch { res.statusCode = 500; res.end('{}'); }
    });
    await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
    const address = service.address();
    if (!address || typeof address === 'string') throw new Error('scenario_server_address');
    try { return await use(`http://127.0.0.1:${address.port}`, calls); }
    finally { service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); }
  }

  const skillContract = 'Skill suggestion uses the complete roster, ranks and verifies via native System One; mean(acts, procedure, 1-prose) >= .30 permits verification, max(fits) >= .30 returns the SECOND Choice winner. Errors never become abstentions. No retries or redirects. Private corpus transmission requires explicit permission; corpus roots and raw failures stay private.';
  const skillPolicy = excerpt('skill_suggestion', ['_answers', '_choice', '_noul', 'suggest']);
  async function skill(id: string, replies: Reply[], expected: string, exit = 0, extra: { [key: string]: string } = {}, args = [request], check?: (calls: ObjectValue[]) => boolean): Promise<ObjectValue[]> {
    const supplied = replies.map(reply => ({ status: reply.status || 200, answers: reply.body.answers || null }));
    const argv = ['--model', 'routing-demo', ...args];
    return server(() => replies.shift() || { status: 500, body: {} }, async (endpoint, calls) => {
      const count = replies.length;
      const result = await cli('skill_suggestion', argv, { TYPESAFE_ENDPOINT: endpoint, TYPESAFE_API_KEY: 'public-loopback-fixture', ...extra });
      const wire = calls.map(c => ({ path: c.path, model: c.body.model, state: c.body.state, questions: Object.keys(c.body.questions), candidates: Object.keys(c.body.questions.which.criteria) }));
      const safe = ![scratch, 'PRIVATE_CANARY', 'public-loopback-fixture', 'Traceback'].some(secret => (result.stdout + result.stderr).includes(secret));
      const native = calls.every(c => c.path === '/v1/systemone' && c.authorized && c.body.model === 'routing-demo');
      const gates = supplied[0]?.answers;
      const operands: unknown[] | null = gates ? [gates['gate::acts_on_user_system']?.noul ?? null, gates['gate::would_follow_documented_procedure']?.noul ?? null, typeof gates['gate::prose_suffices']?.noul === 'number' ? 1 - gates['gate::prose_suffices'].noul : null] : null;
      const fits = Object.entries(supplied[1]?.answers || {}).filter(([key]) => key.startsWith('fits::')).map(([key, value]) => ({ skill: key.slice(6), noul: (value as ObjectValue).noul }));
      const stages = calls.map((call, index) => ({ requestedAnswerIDs: Object.keys(call.body.questions), receivedAnswerIDs: Object.keys(supplied[index]?.answers || {}), requestedCriteria: Object.keys(call.body.questions.which.criteria), receivedChoice: supplied[index]?.answers?.which?.choice || null }));
      const input = { argv, environmentOverrides: extra, defaultEndpoint: '<loopback-server>', defaultKey: '<public-fixture-key>', corpus: extra.SKILLS_LIBRARY_PATH ? fixturePath(extra.SKILLS_LIBRARY_PATH) : publicRoster };
      const cliInterface = id === 'unknown-argument-private' ? { help: serializableRun(await cli('skill_suggestion', ['--help'])), implementationExcerpt: excerpt('skill_suggestion', ['_ArgumentParser', 'main']) } : null;
      record(`skill.${id}`, skillContract, { input, ...(cliInterface ? { cliInterface } : {}), implementationExcerpt: skillPolicy, result: serializableRun(result), suppliedResponses: supplied, inferenceCalls: calls.length, requests: wire, stages,
        arithmeticFromResponses: { gateOperands: operands, gateMean: operands?.every((v): v is number => typeof v === 'number') ? operands.reduce((a, b) => a + b, 0) / 3 : null, fitValues: fits, maximumFit: fits.length ? Math.max(...fits.map(f => f.noul)) : null } }, result.exit === exit && result.stdout === expected && calls.length === count && safe && native && (exit !== 0 || result.stderr === '') && (!check || check(calls)));
      return calls;
    });
  }
  const replies = (...bodies: ObjectValue[]): Reply[] => bodies.map(body => ({ body }));
  const publicRoster = parse(readFileSync(join(root, 'examples/skills/roster.json'), 'utf8')) as ObjectValue[];
  await skill('rank-enrich-verify', replies(rank(), finalChoice()), 'slides-author\n', 0, {}, [request], calls => {
    const [first, second] = calls.map(c => c.body);
    return same(Object.keys(first.questions.which.criteria), ids) && same(Object.keys(second.questions.which.criteria), short) && same(first.state, second.state) && short.every(id => {
      const entry = publicRoster.find(entry => entry.id === id)!;
      return second.questions.which.criteria[id] === `${entry.description_full} — ${[...entry.body.trim()].slice(0, 700).join('')}`;
    });
  });
  for (const [id, a, p, prose, second, output] of [
    ['gate-below', .449, .45, 1, false, 'no suggestion\n'], ['gate-at', .45, .45, 1, true, 'slides-author\n'],
    ['gate-inverts-prose', .6, 0, 1, false, 'no suggestion\n'],
  ] as const) await skill(id, replies(rank(a, p, prose), ...(second ? [finalChoice()] : [])), output);
  await skill('fit-below', replies(rank(), finalChoice([.299, .1, .2])), 'no suggestion\n');
  await skill('fit-at-disagrees-with-choice', replies(rank(), finalChoice([.01, .30, .2])), 'slides-author\n');
  const tied = [...ids].sort().slice(0, 3);
  await skill('stable-tie-order', replies(rank(.8, .8, .1, Object.fromEntries([...ids].reverse().map(id => [id, .25]))), finalChoice([.8, .2, .1], tied)), 'slides-author\n', 0, {}, [request], calls => same(Object.keys(calls[1].body.questions.which.criteria), tied));
  const invalid: [string, (value: ObjectValue) => void][] = [
    ['missing-gate', v => { delete v.answers['gate::prose_suffices']; }], ['extra-answer', v => { v.answers.extra = { type: 'noul', noul: 0 }; }],
    ['negative-probability', v => { v.answers.which.probabilities['slides-author'] = -.1; }], ['missing-candidate', v => { delete v.answers.which.probabilities['tables-audit']; }],
    ['unknown-choice', v => { v.answers.which.choice = 'unknown'; }], ['wrong-type', v => { v.answers['gate::acts_on_user_system'] = choice('x', { x: 1 }); }],
    ['noul-out-of-range', v => { v.answers['gate::acts_on_user_system'].noul = 1.1; }], ['missing-noul', v => { delete v.answers['gate::acts_on_user_system'].noul; }],
    ['choice-not-maximum', v => { v.answers.which.choice = 'tables-audit'; }], ['zero-distribution', v => { v.answers.which.probabilities = Object.fromEntries(ids.map(id => [id, 0])); }],
  ];
  for (const [id, corrupt] of invalid) { const value = rank(); corrupt(value); await skill(id, replies(value), '', 2); }
  const missingFit = finalChoice(); delete missingFit.answers['fits::notes-organize'];
  const unknownFinal = finalChoice(); unknownFinal.answers.which.choice = 'tables-audit';
  for (const [id, body] of [['missing-fit', missingFit], ['unknown-final-choice', unknownFinal]] as const) await skill(id, replies(rank(), body), '', 2);
  const failure = { status: 503, body: { detail: [{ msg: `PRIVATE_CANARY ${scratch}` }] } };
  await skill('first-stage-no-retry', [failure], '', 2);
  await skill('second-stage-no-retry', [{ body: rank() }, failure], '', 2);
  await skill('redirect-not-followed', [{ status: 307, body: { detail: [] } }], '', 2);
  const configurations: { [id: string]: { [name: string]: string } } = {
    'missing-key': { TYPESAFE_API_KEY: '' }, 'missing-endpoint': { TYPESAFE_ENDPOINT: '' },
    'endpoint-userinfo': { TYPESAFE_ENDPOINT: 'https://PRIVATE_CANARY@gateway.invalid' },
    'endpoint-path': { TYPESAFE_ENDPOINT: 'https://gateway.invalid/PRIVATE_CANARY' },
    'endpoint-query': { TYPESAFE_ENDPOINT: 'https://gateway.invalid?key=PRIVATE_CANARY' },
    'endpoint-scheme': { TYPESAFE_ENDPOINT: 'file:///PRIVATE_CANARY' },
  };
  for (const [id, extra] of Object.entries(configurations)) await skill(`configuration-${id}`, [], '', 2, extra);
  await skill('unknown-argument-private', [], '', 2, {}, ['--unknown=PRIVATE_CANARY', request]);

  const writeSkill = (dir: string, folder: string, id = 'alpha', description = 'A synthetic skill.', body = 'Follow the synthetic procedure.'): void => {
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, 'SKILL.md'), `---\nname: ${id}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`);
  };
  const privateDir = join(scratch, 'private-roster'); writeSkill(privateDir, 'alpha');
  await skill('private-needs-consent', [], '', 2, { SKILLS_LIBRARY_PATH: privateDir });
  await skill('single-candidate-two-stages', replies(rank(.8, .8, .1, { alpha: 1 }), finalChoice([.8], ['alpha'], 'alpha')), 'alpha\n', 0, { SKILLS_LIBRARY_PATH: privateDir }, [request, '--allow-private']);
  const relocated: ObjectValue[][] = [];
  const relocationInputs: ObjectValue[] = [];
  for (const name of ['short', 'longer-synthetic-corpus-location']) {
    const location = join(scratch, name);
    writeSkill(location, 'renamed-folder', 'alpha', `Read ${location}/guide.`, 'é'.repeat(650) + `\nUse ${location}/tool then ${encodeURIComponent(location)}/other. ` + 'Z'.repeat(900));
    relocationInputs.push({ binding: location, request: `Use ${location}/guide.`, filesystem: fixturePath(location) });
    relocated.push(await skill(`relocation-${name}`, replies(rank(.8, .8, .1, { alpha: 1 }), finalChoice([.8], ['alpha'], 'alpha')), 'alpha\n', 0, { SKILLS_LIBRARY_PATH: location }, [`Use ${location}/guide.`, '--allow-private'], calls => !JSON.stringify(calls).includes(location) && !JSON.stringify(calls).includes(encodeURIComponent(location))));
  }
  record('skill.relocation-equivalence', 'Equivalent private corpora in different directories produce identical root-free requests; redact before taking 700 Unicode codepoints.', { runs: relocated.map((calls, index) => ({ input: relocationInputs[index], capturedRequests: calls.map(call => ({ path: call.path, body: call.body })) })), identicalRequests: same(relocated[0], relocated[1]), containsPlaceholder: JSON.stringify(relocated[0]).includes('${SKILLS_LIBRARY_PATH}') }, same(relocated[0], relocated[1]) && JSON.stringify(relocated[0]).includes('${SKILLS_LIBRARY_PATH}'));
  const wideDir = join(scratch, 'wide-roster');
  const wideIds = Array.from({ length: 25 }, (_, i) => `skill-${String(i).padStart(2, '0')}`);
  for (const id of wideIds) writeSkill(wideDir, id, id, 'Complete long description. '.repeat(20));
  await skill('wide-roster-not-truncated', replies(rank(0, 0, 1, Object.fromEntries(wideIds.map(id => [id, 1 / 25])))), 'no suggestion\n', 0, { SKILLS_LIBRARY_PATH: wideDir }, [request, '--allow-private'], calls => same(Object.keys(calls[0].body.questions.which.criteria), wideIds) && calls[0].body.questions.which.criteria[wideIds[0]].length > 400);

  const rosterContract = 'Invalid, missing, duplicate or symlinked private corpora fail without fallback. Portable IDs and sorting come from skill names. Descriptions preserve multiline text. Only complete exact JSON records are accepted.';
  const corpus = async (id: string, path: string, expectedError: string | null, check?: (v: ObjectValue) => boolean): Promise<void> => {
    const actual = await call('skill_suggestion', 'load_roster', [path], [], { environ: {} });
    record(`roster.${id}`, rosterContract, { input: { function: 'load_roster', path, environ: {}, ...(path.trim() === '' ? { explicitPathArgument: true, pathCodepoints: [...path].map(character => character.codePointAt(0)), trimmedPathLength: path.trim().length } : {}), filesystem: fixturePath(path) }, implementationExcerpt: excerpt('skill_suggestion', ['_validate_record', ...(path.trim() === '' ? ['load_roster'] : [])]), outcome: actual }, expectedError ? !actual.ok && actual.error === expectedError : actual.ok && (!check || check(actual.value)));
  };
  await corpus('missing-no-fallback', join(scratch, 'absent'), 'RosterError');
  await corpus('empty-binding', ' ', 'ConfigurationError');
  const duplicate = join(scratch, 'duplicate'); writeSkill(duplicate, 'one'); writeSkill(duplicate, 'two');
  await corpus('duplicate-id', duplicate, 'RosterError');
  const ordering = join(scratch, 'ordering'); writeSkill(ordering, 'aaa', 'zeta'); writeSkill(ordering, 'zzz', 'alpha');
  await corpus('portable-sort', ordering, null, value => same(value.skills.map((s: ObjectValue) => s.id), ['alpha', 'zeta']));
  const valid = { id: 'alpha', description: 'A', description_full: 'B', body: 'C', category: 'D' };
  for (const [id, value] of Object.entries({ object: { skills: [valid] }, empty: [], missing: [{ id: 'alpha', description: 'A', body: 'C', category: 'D' }], badID: [{ ...valid, id: '../alpha' }], badText: [{ ...valid, description: ['bad'] }], unknown: [{ ...valid, location: 'PRIVATE_CANARY' }], duplicate: [valid, valid] })) {
    const file = join(scratch, `roster-${id}.json`); save(file, value); await corpus(`json-${id}`, file, 'RosterError');
  }
  for (const [id, document] of Object.entries({ malformed: '---\nname: alpha\ndescription: [unterminated\n---\nBody', duplicate: '---\nname: alpha\nname: beta\ndescription: A\n---\nBody', boolean: '---\nname: alpha\ndescription: true\n---\nBody', path: '---\nname: ../alpha\ndescription: A\n---\nBody', missing: 'No frontmatter' })) {
    const dir = join(scratch, `yaml-${id}`); mkdirSync(dir); writeFileSync(join(dir, 'SKILL.md'), document); await corpus(`yaml-${id}`, dir, 'RosterError');
  }
  const multiline = join(scratch, 'multiline'); mkdirSync(multiline); writeFileSync(join(multiline, 'SKILL.md'), '---\r\nname: alpha\r\ndescription: |\r\n  First line.\r\n  Second line.\r\n---\r\nBody.\r\n');
  await corpus('multiline-description', multiline, null, value => value.skills[0].description === 'First line.\nSecond line.' && value.skills[0].body === 'Body.');
  const linked = join(scratch, 'linked-roster'); symlinkSync(privateDir, linked, 'dir'); await corpus('symlink-root', linked, 'RosterError');
  const linkedChild = join(scratch, 'linked-child'); mkdirSync(linkedChild); symlinkSync(privateDir, join(linkedChild, 'nested'), 'dir'); await corpus('symlink-directory', linkedChild, 'RosterError');
  const linkedFile = join(scratch, 'linked-file'); mkdirSync(linkedFile); symlinkSync(join(privateDir, 'alpha/SKILL.md'), join(linkedFile, 'SKILL.md')); await corpus('symlink-file', linkedFile, 'RosterError');

  const publicRoot = join(scratch, 'public'); mkdirSync(publicRoot); mkdirSync(join(publicRoot, 'examples'));
  writeFileSync(join(publicRoot, 'router.go'), 'public source');
  // All forbidden targets exist: removing the boundary must expose a canary,
  // never appear to pass because a missing file happens to throw ENOENT.
  for (const path of [join(publicRoot, '.env'), join(publicRoot, 'backends.json'), join(scratch, 'router.go'), join(privateDir, 'skill_suggestion.py')]) writeFileSync(path, 'PRIVATE_CANARY');
  const privacyContract = 'The public review collector exports only exact allowlisted canonical regular files, rejects file/directory symlinks, files above 256 KiB, and absolute repository roots in content. Impact evidence projects only public IDs and fixed coverage enums; status success is not impact evidence.';
  for (const [id, path] of Object.entries({ env: '.env', traversal: '../router.go', dotted: './router.go', absolute: join(publicRoot, 'router.go'), nestedTraversal: 'examples/../router.go', registry: 'backends.json', allowed: 'router.go' })) {
    const value = await call('parity_review', 'read_public', [publicRoot, path], [0]);
    record(`privacy.path-${id}`, privacyContract, { input: { root: publicRoot, relativePath: path, filesystem: fixturePath(publicRoot) }, outcome: value }, path === 'router.go' ? value.ok && value.value === 'public source' : !value.ok && value.error === 'ValueError');
  }
  const publicLinks = join(scratch, 'public-links'); mkdirSync(publicLinks); symlinkSync(join(publicRoot, 'router.go'), join(publicLinks, 'router.go')); symlinkSync(privateDir, join(publicLinks, 'examples'), 'dir');
  for (const path of ['router.go', 'examples/skill_suggestion.py']) {
    const value = await call('parity_review', 'read_public', [publicLinks, path], [0]); record(`privacy.symlink-${path}`, privacyContract, { input: { root: publicLinks, relativePath: path, filesystem: fixturePath(publicLinks), targets: [fixturePath(publicRoot), fixturePath(privateDir)] }, outcome: value }, !value.ok && ['OSError', 'NotADirectoryError'].includes(value.error));
  }
  for (const [id, content, allowed] of [['at-limit', 'x'.repeat(256 * 1024), true], ['over-limit', 'x'.repeat(256 * 1024 + 1), false], ['root-in-content', publicRoot, false]] as const) {
    writeFileSync(join(publicRoot, 'router.go'), content); const value = await call('parity_review', 'read_public', [publicRoot, 'router.go'], [0]);
    record(`privacy.${id}`, privacyContract, { input: { root: publicRoot, relativePath: 'router.go', file: fixturePath(join(publicRoot, 'router.go')), maximumBytes: 256 * 1024 }, outcome: { ok: value.ok, error: value.error || null, exportedBytes: value.ok ? Buffer.byteLength(value.value) : 0 } }, value.ok === allowed);
  }
  const impact = { ok: true, workspace: { root: 'PRIVATE_CANARY' }, changedFacts: ['file:router.go', 'file:PRIVATE_CANARY'], mechanical: [], advisory: [
    { node: 'file:conformance/routing_test.go', fromSource: 'file:router.go', kind: 'derives-facts-from', raw: 'PRIVATE_CANARY' },
    { node: 'file:PRIVATE_CANARY', fromSource: 'file:router.go', kind: 'derives-facts-from' },
    { node: 'fact:contract/invariants.json#PRIVATE_CANARY', fromSource: 'file:router.go', kind: 'derives-facts-from' },
  ], proof: { sources: [{ source: 'file:router.go', dependents: [{ node: 'file:conformance/routing_test.go', kind: 'derives-facts-from', status: 'not-changed-in-range', message: 'PRIVATE_CANARY' }] }] } };
  const projection = await call('parity_review', 'sanitize_impact', [impact, ['routing.soft-eligibility']]);
  record('privacy.impact-projection', privacyContract, { input: { impact, invariantIDs: ['routing.soft-eligibility'] }, outcome: projection }, projection.ok && !JSON.stringify(projection).includes('PRIVATE_CANARY') && projection.value.omitted_records === 3 && same(projection.value.changed_facts, ['router.go']) && projection.value.edges[1].coverage === 'not-changed-in-range');
  for (const [id, value] of Object.entries({ status: { ok: true, green: true }, failed: { ok: false, changedFacts: [], mechanical: [], advisory: [] } })) {
    const actual = await call('parity_review', 'sanitize_impact', [value, []]); record(`privacy.invalid-impact-${id}`, privacyContract, { input: { impact: value, invariantIDs: [] }, outcome: actual }, !actual.ok);
  }

  await evidenceScenarios();
  await releaseScenarios();
  await ensembleScenarios();
  save(join(scratch, 'observations.json'), records);
  return records;

  async function ensembleScenarios(): Promise<void> {
    const fixture = read(join(root, 'examples/laya-jev-ensemble.json'));
    const contract = 'This public synthetic example calls explicit Laya and Jev backend IDs concurrently with identical original state/questions, waits for both valid answers, then calls Jev once to adjudicate. The adjudicator receives original_state plus both expert models/answers; every question retains its ID, type and criteria, with its original instructions nested alongside the versioned adjudication task. It answers the original questions, not which expert wins. A success prints one standard response with the composite identity, exactly the adjudicator answers and all three token usages summed. The optional fresh directory retains stage bodies and a report. Any failed or invalid stage exits 2 with empty stdout and a sanitized diagnostic, never retries, never falls back, and creates no final response; failure in either initial stage prevents adjudication. These synthetic answers exercise orchestration, not model quality.';
    function response(model: string, choice: string, level: number, noul: number, tokens: number): ObjectValue {
      return { model, answers: {
        department: { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(fixture.questions.department.criteria).map(key => [key, Number(key === choice)])) },
        refund_requested: { type: 'noul', noul },
        urgency: { type: 'score', score: level, confidence: 1, legend: Object.fromEntries(fixture.questions.urgency.criteria.map((value: string, index: number) => [String(index), value])), probabilities: { '0': Number(level === 0), '1': Number(level === 1), '2': Number(level === 2) } },
      }, usage: { input_tokens: tokens * 10, output_tokens: tokens } };
    }
    const responses = {
      laya: response('laya-synthetic', 'technical', 0, 0.1, 1),
      jev: response('jev-synthetic', 'billing', 1, 0.6, 2),
      adjudication: response('jev-synthetic', 'account', 2, 0.9, 3),
    };
    for (const variant of ['success', 'leaf-error', 'leaf-invalid', 'adjudicator-error']) {
      const directory = join(scratch, `ensemble-${variant}`);
      const events: string[] = [];
      let release: () => void = () => {};
      const bothArrived = new Promise<void>(resolve => { release = resolve; });
      let initialRequests = 0;
      await server(async body => {
        const stage = typeof body.state === 'object' && body.state?.original_state !== undefined
          ? 'adjudication' : body.model === 'laya-fixture' ? 'laya' : 'jev';
        events.push(`${stage}:received`);
        if (stage !== 'adjudication') {
          if (++initialRequests === 2) release();
          // A sequential implementation cannot complete any ensemble scenario.
          await bothArrived;
        }
        const answer = clone(responses[stage]);
        if (variant === 'leaf-invalid' && stage === 'laya') delete answer.answers.refund_requested;
        const failed = (variant === 'leaf-error' && stage === 'laya') || (variant === 'adjudicator-error' && stage === 'adjudication');
        events.push(`${stage}:response`);
        return failed ? { status: 503, body: { error: { message: 'PRIVATE_ENSEMBLE_CANARY' } } } : { body: answer };
      }, async (endpoint, calls) => {
        const actual = await cli('laya_jev_ensemble', ['--laya-model', 'laya-fixture', '--jev-model', 'jev-fixture', '--output', directory], { TYPESAFE_ENDPOINT: endpoint, TYPESAFE_API_KEY: 'public-loopback-fixture' });
        const report = existsSync(join(directory, 'report.json')) ? read(join(directory, 'report.json')) : null;
        const finalPath = join(directory, 'final.response.json');
        const final = existsSync(finalPath) ? read(finalPath) : null;
        const initial = calls.filter(call => typeof call.body.state === 'string');
        const adjudication = calls.find(call => typeof call.body.state === 'object');
        const expectedQuestions = Object.fromEntries(Object.entries(fixture.questions).map(([name, question]) => {
          const value = question as ObjectValue;
          return [name, { ...value, instructions: { original_question: value.instructions, task: fixture.adjudication_instructions } }];
        }));
        const expectedState = { original_state: fixture.state, expert_judgments: Object.fromEntries(['laya', 'jev'].map(stage => {
          const value = responses[stage as 'laya' | 'jev'];
          return [stage, { model: value.model, answers: value.answers }];
        })) };
        const initialValid = initial.length === 2 && same(initial.map(call => call.body.model).sort(), ['jev-fixture', 'laya-fixture'])
          && initial.every(call => same(call.body.state, fixture.state) && same(call.body.questions, fixture.questions));
        const adjudicationValid = adjudication?.body.model === 'jev-fixture' && same(adjudication.body.state, expectedState) && same(adjudication.body.questions, expectedQuestions)
          && ['laya', 'jev'].every(stage => events.indexOf('adjudication:received') > events.indexOf(`${stage}:response`));
        const common = initialValid && calls.every(call => call.authorized && call.path === '/v1/systemone')
          && ['laya', 'jev'].every(stage => events.indexOf(`${stage}:response`) > Math.max(events.indexOf('laya:received'), events.indexOf('jev:received')))
          && !actual.stderr.includes('PRIVATE_ENSEMBLE_CANARY') && !actual.stderr.includes('Traceback');
        const successful = variant === 'success';
        const expectedCalls = variant.startsWith('leaf-') ? 2 : 3;
        const expectedFinal = { model: fixture.model, answers: responses.adjudication.answers, usage: { input_tokens: 60, output_tokens: 6 } };
        const valid = successful
          ? actual.exit === 0 && same(JSON.parse(actual.stdout || 'null'), expectedFinal) && same(final, expectedFinal)
            && report?.status === 'completed' && adjudicationValid
          : actual.exit === 2 && actual.stdout === '' && actual.stderr.trim() !== '' && final === null && report?.status === 'incomplete'
            && (variant.startsWith('leaf-') ? !adjudication : adjudicationValid);
        record(`ensemble.${variant}`, contract, { input: fixture, variant, responseHold: 'The HTTP fixture withholds both initial responses until both requests arrive.', events, calls, outcome: serializableRun(actual), report, final }, common && calls.length === expectedCalls && valid);
      });
    }
  }

  async function evidenceScenarios(): Promise<void> {
    const contract = 'Model admission requires current rubric/candidate review plus complete matching native/gateway evidence. Missing evidence is not readiness; violations reject, uncertainty holds. Recompute wire integrity, typed-answer semantics, exact usage and bounded numeric parity even when stored hashes match. Local gate never performs inference.';
    const nativeAnswer = (body: ObjectValue): ObjectValue => {
      const reviewer = body.model === 'reviewer'; // ubs:ignore[javascript.ctcompare.unsafe_secret_compare] Public synthetic model selector, not authentication.
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, raw]) => {
        const question = raw as ObjectValue;
        if (question.type === 'noul') return [id, { type: 'noul', noul: .6 }];
        if (question.type === 'score') return [id, { type: 'score', score: .75, confidence: .75, probabilities: { '0': .25, '1': .75 }, legend: Object.fromEntries(question.criteria.map((v: unknown, i: number) => [String(i), v])) }];
        const winner = reviewer ? ('http_passthrough' in question.criteria ? 'http_passthrough' : 'clear') : Object.keys(question.criteria)[0];
        return [id, { type: 'choice', choice: winner, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(k => [k, Number(k === winner)])) }];
      }));
      return { model: reviewer ? 'reviewer-v1' : 'native-v1', answers, usage: { input_tokens: 3, output_tokens: 2 } };
    };
    await server(body => ({ body: nativeAnswer(body) }), async (endpoint, calls) => {
      const base = join(scratch, 'admission'); mkdirSync(base);
      const candidate = { id: 'fixture', question_types: ['choice', 'score', 'noul'], target: { endpoint: endpoint + '/native', model: 'native', response_model: 'native-v1' } };
      const fixture = { cases: [{ state: { first: 1, second: 2 }, questions: { pick: { type: 'choice', criteria: { a: 'First', b: 'Second' } }, grade: { type: 'score', criteria: ['Low', 'High'] }, yes: { type: 'noul' } } }] };
      save(join(base, 'candidate.json'), candidate); save(join(base, 'state.json'), { candidate }); save(join(base, 'fixtures.json'), fixture);
      const auth = { ONE_SYSTEM_TEST_KEY: 'public-loopback-fixture' };
      const review = await cli('system_one_check', ['review', '--endpoint', endpoint, '--key-env', 'ONE_SYSTEM_TEST_KEY', '--model', 'reviewer', '--expected-model', 'reviewer-v1', '--state', join(base, 'state.json'), '--questions', join(root, 'examples/integration-review.questions.json'), '--output', join(base, 'review')], auth);
      const probe = await cli('system_one_check', ['probe', '--endpoint', endpoint, '--key-env', 'ONE_SYSTEM_TEST_KEY', '--native-key-env', 'ONE_SYSTEM_TEST_KEY', '--candidate', join(base, 'candidate.json'), '--fixtures', join(base, 'fixtures.json'), '--output', join(base, 'probe')], auth);
      record('admission.live-sdk-evidence', contract, { input: { candidate, fixture }, review: serializableRun(review), probe: serializableRun(probe), calls: calls.map(c => ({ path: c.path, request: c.body, response: c.response, authorized: c.authorized })), sameState: same(calls[1]?.body.state, calls[2]?.body.state), sameQuestions: same(calls[1]?.body.questions, calls[2]?.body.questions) }, review.exit === 0 && probe.exit === 0 && same(calls.map(c => [c.path, c.body.model]), [['/v1/systemone', 'reviewer'], ['/native/v1/systemone', 'native'], ['/v1/systemone', 'fixture']]) && calls.every(c => c.authorized) && same(calls[1].body.state, calls[2].body.state) && same(calls[1].body.questions, calls[2].body.questions));
      if (review.exit !== 0 || probe.exit !== 0) return;
      const automaticCandidate = { ...candidate, id: 'routing-demo' };
      const automaticPath = join(scratch, 'automatic-candidate.json');
      save(automaticPath, automaticCandidate);
      const beforeAutomaticProbe = calls.length;
      const automaticProbe = await cli('system_one_check', ['probe', '--endpoint', endpoint, '--key-env', 'ONE_SYSTEM_TEST_KEY', '--native-key-env', 'ONE_SYSTEM_TEST_KEY', '--candidate', automaticPath, '--fixtures', join(base, 'fixtures.json'), '--output', join(scratch, 'automatic-probe')], auth);
      record('admission.automatic-route-not-backend', 'A backend parity probe must reject the configured automatic route before inference rather than attest an automatically selected backend.', { candidate: automaticCandidate, automaticModel: 'routing-demo', result: serializableRun(automaticProbe), inferenceCalls: calls.length - beforeAutomaticProbe }, automaticProbe.exit === 2 && calls.length === beforeAutomaticProbe && parse(automaticProbe.stderr).error.code === 'unexpected_model');
      const artifactPaths = ['candidate.json', ...['review', 'probe'].flatMap(sub => readdirSync(join(base, sub)).sort().map(name => `${sub}/${name}`))];
      const capture = (dir: string): ObjectValue => Object.fromEntries(artifactPaths.map(path => {
        if (!existsSync(join(dir, path))) return [path, null];
        const raw = readFileSync(join(dir, path), 'utf8');
        try { return [path, JSON.parse(raw)]; } catch { return [path, { unparsedText: raw }]; }
      }));
      const baselineArtifacts = capture(base);
      const baselineGate = await cli('system_one_check', ['gate', '--candidate', join(base, 'candidate.json'), '--review', join(base, 'review'), '--probe', join(base, 'probe')]);
      const baseline = { candidate, fixture, artifactPaths, observedGate: serializableRun(baselineGate), reviewAnswers: baselineArtifacts['review/response.json'].answers, nativeResponse: baselineArtifacts['probe/case-0-native-response.json'], gatewayResponse: baselineArtifacts['probe/case-0-gateway-response.json'] };
      const admissionPolicy = excerpt('system_one_check', ['validate_probe_inputs', 'gate']);
      const difference = (before: any, after: any, path = ''): ObjectValue[] => {
        if (same(before, after)) return [];
        if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
          const beforeKeys = Object.keys(before), afterKeys = Object.keys(after);
          return [...(same(beforeKeys, afterKeys) ? [] : [{ path, beforeKeys, afterKeys }]),
            ...[...new Set([...beforeKeys, ...afterKeys])].flatMap(key => difference(before[key], after[key], path + '/' + key))];
        }
        return [{ path, before: before ?? null, after: after ?? null }];
      };
      const mutations = async (id: string, expected: string, edit?: (dir: string) => void, withProbe = true): Promise<void> => {
        const dir = join(scratch, `gate-${id}`); mkdirSync(dir); mkdirSync(join(dir, 'review')); mkdirSync(join(dir, 'probe'));
        for (const name of ['candidate.json', 'fixtures.json']) copyFileSync(join(base, name), join(dir, name));
        for (const sub of ['review', 'probe']) for (const name of readdirSync(join(base, sub))) copyFileSync(join(base, sub, name), join(dir, sub, name));
        if (edit) edit(dir);
        const changed = capture(dir);
        const changes = artifactPaths.filter(path => !same(baselineArtifacts[path], changed[path])).map(path => ({ artifact: path,
          ...(changed[path] === null ? { before: { present: true, sha256: digest(baselineArtifacts[path]) }, after: { present: false } } : { fields: difference(baselineArtifacts[path], changed[path]) }) }));
        const before = calls.length;
        const result = await cli('system_one_check', ['gate', '--candidate', join(dir, 'candidate.json'), '--review', join(dir, 'review'), ...(withProbe ? ['--probe', join(dir, 'probe')] : [])]);
        let decision: string | null = null, error: string | null = null;
        try { decision = JSON.parse(result.stdout).decision; } catch { try { error = JSON.parse(result.stderr).error.code; } catch {} }
        const expectedExit = ['ready_for_opt_in'].includes(expected) ? 0 : ['needs_endpoint_test', 'reject', 'hold'].includes(expected) ? 1 : 2;
        record(`admission.${id}`, contract, { input: { baseline, mutations: changes, probeArgumentSupplied: withProbe }, implementationExcerpt: admissionPolicy, exit: result.exit, decision, error, additionalInferenceCalls: calls.length - before, leaksRoot: result.stderr.includes(scratch), traceback: result.stderr.includes('Traceback') }, result.exit === expectedExit && (decision || error) === expected && calls.length === before && !result.stderr.includes(scratch) && !result.stderr.includes('PRIVATE_CANARY') && !result.stderr.includes('Traceback'));
      };
      await mutations('needs-probe', 'needs_endpoint_test', undefined, false);
      await mutations('complete-ready', 'ready_for_opt_in');
      // Copy only the remaining evidence into a fresh directory: no deletion is needed.
      for (const sub of ['review', 'probe']) for (const name of readdirSync(join(base, sub))) {
        if (sub === 'review' && !['request.json', 'response.json', 'report.json', 'review-request-wire.json', 'review-response-wire.json'].includes(name)) continue;
        await mutations(`missing-${sub}-${name}`, 'missing_input', dir => {
          // Move only this fresh fixture copy aside; retain original evidence.
          renameSync(join(dir, sub, name), join(dir, `${sub}-retained-${name}`));
        });
      }
      const alter = (dir: string, path: string, fn: (v: ObjectValue) => void): void => { const value = read(join(dir, path)); fn(value); save(join(dir, path), value); };
      for (const path of ['probe/candidate.json', 'probe/fixtures.json', 'probe/case-0-native-request.json', 'probe/case-0-gateway-response.json']) await mutations(`corrupt-${path.replaceAll('/', '-')}`, 'probe_mismatch', dir => alter(dir, path, v => { v.extra = 'corruption'; }));
      for (const path of ['probe/case-0-native-request-wire.json', 'review/review-request-wire.json', 'probe/case-0-gateway-response-wire.json']) await mutations(`wire-${path.replaceAll('/', '-')}`, 'wire_mismatch', dir => alter(dir, path, value => {
        if (value.state) { if (value.state.candidate) value.state.candidate = Object.fromEntries(Object.entries(value.state.candidate).reverse()); else value.state = Object.fromEntries(Object.entries(value.state).reverse()); }
        else value.model = 'other';
      }));
      for (const [field, value] of [['candidate_sha256', 'other'], ['target_sha256', 'other'], ['model', 'other'], ['native_model', 'other'], ['expected_model', 'other'], ['fixtures_sha256', 'other'], ['tested_question_types', []], ['passed', false], ['cases', []]] as const) await mutations(`stale-${field}`, 'probe_mismatch', dir => alter(dir, 'probe/report.json', report => { report[field] = value; }));
      await mutations('duplicate-cases', 'probe_mismatch', dir => alter(dir, 'probe/report.json', report => { report.cases.push(report.cases[0]); }));
      for (const nested of [false, true]) await mutations(`reordered-candidate-${nested}`, 'review_mismatch', dir => {
        let candidate = read(join(dir, 'candidate.json')); if (nested) candidate.target = Object.fromEntries(Object.entries(candidate.target).reverse()); else candidate = Object.fromEntries(Object.entries(candidate).reverse()); save(join(dir, 'candidate.json'), candidate);
      });
      const bindReview = (dir: string, request: ObjectValue, response: ObjectValue): void => {
        for (const [name, value] of Object.entries({ 'request.json': request, 'response.json': response, 'review-request-wire.json': request, 'review-response-wire.json': response })) save(join(dir, 'review', name), value);
        alter(dir, 'review/report.json', report => { report.request_sha256 = digest(request); report.response_sha256 = digest(response); });
      };
      await mutations('stale-rubric', 'review_mismatch', dir => { const req = read(join(dir, 'review/request.json')); req.questions = Object.fromEntries(Object.entries(req.questions).reverse()); bindReview(dir, req, read(join(dir, 'review/response.json'))); });
      await mutations('recompute-question-coverage', 'invalid_fixtures', dir => {
        const candidate = read(join(dir, 'candidate.json')); candidate.question_types = ['choice', 'score']; save(join(dir, 'candidate.json'), candidate);
        const req = read(join(dir, 'review/request.json')); req.state = { candidate }; bindReview(dir, req, read(join(dir, 'review/response.json')));
      });
      for (const outcome of ['reject', 'hold'] as const) await mutations(outcome, outcome, dir => {
        const resp = read(join(dir, 'review/response.json'));
        resp.answers['inference-boundary'] = outcome === 'reject' ? choice('violation', { clear: 0, violation: 1, insufficient_evidence: 0 }) : choice('clear', { clear: .6, violation: .1, insufficient_evidence: .3 });
        bindReview(dir, read(join(dir, 'review/request.json')), resp);
      });
      await mutations('review-hash-mismatch', 'review_mismatch', dir => alter(dir, 'review/response.json', v => { v.usage.input_tokens++; }));
      for (const [id, code, change] of [
        ['parity', 'parity_mismatch', (v: ObjectValue) => { v.answers.pick.confidence = .8; }],
        ['argmax', 'choice_not_maximum', (v: ObjectValue) => { v.answers.pick.choice = 'b'; }],
        ['identity', 'unexpected_model', (v: ObjectValue) => { v.model = 'other'; }],
        ['usage', 'parity_mismatch', (v: ObjectValue) => { v.usage.input_tokens++; }],
        ['within-tolerance', 'ready_for_opt_in', (v: ObjectValue) => { v.answers.pick.confidence -= 1e-7; }],
      ] as const) await mutations(`recompute-${id}`, code, dir => {
        const resp = read(join(dir, 'probe/case-0-gateway-response.json')); change(resp);
        save(join(dir, 'probe/case-0-gateway-response.json'), resp); save(join(dir, 'probe/case-0-gateway-response-wire.json'), resp);
        alter(dir, 'probe/report.json', report => { report.cases[0].gateway_sha256 = digest(resp); });
      });
      for (const tolerance of [-1, .02, true]) await mutations(`invalid-tolerance-${tolerance}`, 'invalid_tolerance', dir => alter(dir, 'probe/report.json', report => { report.tolerance = tolerance; }));
      await mutations('invalid-json-private', 'invalid_json', dir => writeFileSync(join(dir, 'probe/fixtures.json'), 'PRIVATE_CANARY'));
    });
    await server(body => { const value = nativeAnswer(body); value.answers.pick.choice = 'b'; return { body: value }; }, async (endpoint, calls) => {
      const dir = join(scratch, 'bad-probe'); mkdirSync(dir);
      save(join(dir, 'candidate.json'), { id: 'fixture', question_types: ['choice'], target: { endpoint: endpoint + '/native', model: 'native', response_model: 'native-v1' } });
      save(join(dir, 'fixtures.json'), { cases: [{ state: 'synthetic', questions: { pick: { type: 'choice', criteria: { a: 'First', b: 'Second' } } } }] });
      const result = await cli('system_one_check', ['probe', '--endpoint', endpoint, '--key-env', 'ONE_SYSTEM_TEST_KEY', '--native-key-env', 'ONE_SYSTEM_TEST_KEY', '--candidate', join(dir, 'candidate.json'), '--fixtures', join(dir, 'fixtures.json'), '--output', join(dir, 'evidence')], { ONE_SYSTEM_TEST_KEY: 'public-loopback-fixture' });
      record('admission.native-failure-stops-probe', contract, { input: { candidate: read(join(dir, 'candidate.json')), fixtures: read(join(dir, 'fixtures.json')) }, result: serializableRun(result), calls, inferenceCalls: calls.length, recordedPassed: read(join(dir, 'evidence/report.json')).passed }, result.exit === 2 && result.stderr.includes('choice_not_maximum') && calls.length === 1 && read(join(dir, 'evidence/report.json')).passed === false);
    });
    const scoreRequest = { questions: { q: { type: 'score', criteria: ['Low', 'High'] } } };
    const score = { answers: { q: { type: 'score', score: .75, confidence: .75, legend: { '0': 'Low', '1': 'High' }, probabilities: { '0': .25, '1': .75 } } }, usage: { input_tokens: 2, output_tokens: 0 } };
    for (const variant of ['valid', 'wrong-score', 'wrong-legend']) {
      const value = clone(score); if (variant === 'wrong-score') value.answers.q.score = .25; if (variant === 'wrong-legend') value.answers.q.legend['0'] = 'High';
      const actual = await call('system_one_check', 'validate_answers', [scoreRequest, value]); record(`admission.score-${variant}`, contract, { input: { function: 'validate_answers', request: scoreRequest, response: value }, implementationExcerpt: excerpt('system_one_check', ['validate_answers']), outcome: actual }, actual.ok === (variant === 'valid'));
    }
    for (const winner of ['a', 'b']) {
      const request = { questions: { q: { type: 'choice', criteria: { a: 'A', b: 'B' } } } }, reply = response({ q: choice(winner, { a: .5, b: .5 }) });
      const actual = await call('system_one_check', 'validate_answers', [request, reply]);
      record(`admission.choice-tie-${winner}`, contract, { input: { function: 'validate_answers', request, response: reply }, implementationExcerpt: excerpt('system_one_check', ['validate_answers']), outcome: actual }, actual.ok);
    }
    for (const [id, left, right, expected] of [['within', { p: .5 }, { p: .5000001 }, true], ['outside', { p: .5 }, { p: .51 }, false], ['choice', { choice: 'a' }, { choice: 'b' }, false]] as const) {
      const actual = await call('system_one_check', 'same', [left, right, 1e-6]); record(`admission.numeric-${id}`, contract, { input: { function: 'same', left, right, tolerance: 1e-6 }, implementationExcerpt: excerpt('system_one_check', ['same']), outcome: actual }, actual.ok && actual.value === expected);
    }
    // Keep these integer JSON literals out of JavaScript's lossy Number domain.
    const integers = await run(['-c', bridge], {}, '{"module":"system_one_check","function":"same","args":[9007199254740992,9007199254740993,0.000001]}');
    const actual = parse(integers.stdout);
    record('admission.integer-precision', contract, { input: { function: 'same', rawJSONArguments: '[9007199254740992,9007199254740993,0.000001]', numericTypeAfterJSONDecode: 'Python int', tolerance: 1e-6 }, implementationExcerpt: excerpt('system_one_check', ['same']), outcome: actual }, integers.exit === 0 && actual.ok && actual.value === false);
  }
  async function releaseScenarios(): Promise<void> {
    const contract = 'Public-release review lists files through Git, so ignored files are never opened or sent, including a file tracked despite the ignore rules, which is reported unreviewed; symbolic links are reported unreviewed, never followed. Every chunk is ONE native System One request carrying the whole versioned battery under the explicit --model. Nothing is sent without --confirm-send. Code thresholds turn Noul, Choice and Score answers into pass, note, review or block. Output holds answers and paths, never file content. Findings or unreviewed paths exit 1; refusals and failures exit 2. With --history, blobs reachable from refs but absent from the index are reviewed too; a historical path that current ignore rules exclude is reported unreviewed, which makes the run exit 1 even without model findings, and its content is never sent. Text already answered in the same output ledger is not sent again, within a run or across resumed runs.';
    const policySource = excerpt('public_release_review', ['list_files', 'decide']);
    const battery = read(join(root, 'examples/public-release.questions.json'));
    const repo = join(scratch, 'release-repo'); mkdirSync(join(repo, 'src'), { recursive: true });
    const git = (...args: string[]): void => { if (spawnSync('git', args, { cwd: repo, env: { PATH: env.PATH, HOME: scratch, GIT_CONFIG_NOSYSTEM: '1' }, timeout: 30_000 }).status !== 0) throw new Error('release_fixture_git_failed'); };
    git('init', '-q');
    writeFileSync(join(repo, '.gitignore'), '.env\n*.pem\n');
    writeFileSync(join(repo, 'forced.pem'), 'PRIVATE_CANARY force-added despite the ignore rule\n');
    writeFileSync(join(repo, '.env'), 'TOKEN=PRIVATE_CANARY\n');
    writeFileSync(join(repo, 'src/clean.txt'), 'Add two numbers.\n');
    writeFileSync(join(repo, 'src/flagged.txt'), 'Synthetic text the fixture server flags.\n');
    writeFileSync(join(repo, 'untracked.txt'), 'Untracked, not ignored.\n');
    symlinkSync('.env', join(repo, 'link.txt'));
    git('add', '.gitignore', 'src', 'link.txt'); git('add', '-f', 'forced.pem');
    const reply = (body: ObjectValue): ObjectValue => ({ model: 'fixture-v1', usage: { input_tokens: 5, output_tokens: 1 }, answers: Object.fromEntries(Object.entries(body.questions).map(([id, raw]) => {
      const question = raw as ObjectValue;
      if (question.type === 'noul') return [id, { type: 'noul', noul: body.state.path === 'src/flagged.txt' && id === 'leak.secret' ? .95 : .02 }];
      const keys = question.type === 'score' ? question.criteria.map((_: unknown, i: number) => String(i)) : Object.keys(question.criteria);
      const probabilities = Object.fromEntries(keys.map((key: string, i: number) => [key, Number(i === 0)]));
      return [id, question.type === 'score' ? { type: 'score', score: 0, confidence: 1, probabilities, legend: Object.fromEntries(question.criteria.map((v: unknown, i: number) => [String(i), v])) } : { type: 'choice', choice: keys[0], confidence: 1, probabilities }];
    })) });
    await server(body => ({ body: reply(body) }), async (endpoint, calls) => {
      const bound = { TYPESAFE_ENDPOINT: endpoint, TYPESAFE_API_KEY: 'public-loopback-fixture' };
      const refusedArgv = ['--repo', repo, '--model', 'routing-demo', '--output', join(scratch, 'release-refused')];
      const refused = await cli('public_release_review', refusedArgv, bound);
      record('release.requires-confirmation', contract, { input: { argv: refusedArgv, repository: fixturePath(repo) }, result: serializableRun(refused), inferenceCalls: calls.length }, refused.exit === 2 && calls.length === 0 && !refused.stderr.includes('Traceback'));
      const output = join(scratch, 'release-out'), argv = ['--repo', repo, '--model', 'routing-demo', '--confirm-send', '--output', output];
      const result = await cli('public_release_review', argv, bound);
      const report = existsSync(join(output, 'report.json')) ? read(join(output, 'report.json')) : {};
      const written = ['report.json', 'chunks.jsonl'].map(name => existsSync(join(output, name)) ? readFileSync(join(output, name), 'utf8') : '').join('\n');
      const wire = calls.map(c => ({ path: c.path, authorized: c.authorized, model: c.body.model, statePath: c.body.state.path, questions: Object.keys(c.body.questions) }));
      const wholeBattery = calls.every(c => same(c.body.questions, battery) && c.path === '/v1/systemone' && c.authorized && c.body.model === 'routing-demo');
      const sentPaths = wire.map(w => w.statePath).sort();
      const leaked = [JSON.stringify(calls), result.stdout, result.stderr, written].some(text => text.includes('PRIVATE_CANARY'));
      const contentStored = written.includes('Add two numbers') || written.includes('Synthetic text');
      record('release.gitignore-and-battery', contract, { input: { argv, repository: fixturePath(repo), gitIndex: ['.gitignore', 'forced.pem (force-added although *.pem is ignored)', 'link.txt', 'src/clean.txt', 'src/flagged.txt'], fixtureRule: 'leak.secret is 0.95 for src/flagged.txt; every other Noul is 0.02; severity is level 0' }, implementationExcerpt: policySource, result: serializableRun(result), requests: wire, batteryQuestionIDs: Object.keys(battery), filesByAction: report.files_by_action ?? null, unreviewed: report.unreviewed ?? null, ignoredCanarySentOrStored: leaked, fileContentStored: contentStored },
        result.exit === 1 && wholeBattery && !leaked && !contentStored && same(sentPaths, ['.gitignore', 'src/clean.txt', 'src/flagged.txt', 'untracked.txt']) && same(report.files_by_action?.block, ['src/flagged.txt']) && Object.keys(report.unreviewed ?? {}).sort().join() === 'forced.pem,link.txt');
    });
    // History is published with a repository, and .gitignore does not filter it.
    const past = join(scratch, 'release-history-repo'); mkdirSync(past);
    const pastGit = (...args: string[]): void => { if (spawnSync('git', ['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: past, env: { PATH: env.PATH, HOME: scratch, GIT_CONFIG_NOSYSTEM: '1' }, timeout: 30_000 }).status !== 0) throw new Error('release_fixture_git_failed'); };
    pastGit('init', '-q');
    writeFileSync(join(past, 'kept.txt'), 'Text still present today.\n');
    writeFileSync(join(past, 'removed.txt'), 'Text that survives only in history.\n');
    writeFileSync(join(past, 'old.pem'), 'PRIVATE_CANARY\n');
    pastGit('add', 'kept.txt', 'removed.txt', 'old.pem'); pastGit('commit', '-q', '-m', 'first');
    writeFileSync(join(past, '.gitignore'), '*.pem\n');
    pastGit('rm', '-q', '--cached', 'old.pem', 'removed.txt'); pastGit('add', '.gitignore'); pastGit('commit', '-q', '-m', 'second');
    for (const name of ['removed.txt', 'old.pem']) renameSync(join(past, name), join(scratch, `release-history-${name}`));
    await server(body => ({ body: reply(body) }), async (endpoint, calls) => {
      const bound = { TYPESAFE_ENDPOINT: endpoint, TYPESAFE_API_KEY: 'public-loopback-fixture' };
      const runs: ObjectValue = {};
      for (const [mode, flags] of [['worktree', []], ['history', ['--history']]] as const) {
        const before = calls.length, output = join(scratch, 'release-history-out'), argv = ['--repo', past, '--model', 'routing-demo', '--confirm-send', '--output', output, ...flags];
        const result = await cli('public_release_review', argv, bound);
        const report = existsSync(join(output, 'report.json')) ? read(join(output, 'report.json')) : {};
        runs[mode] = { argv, result: serializableRun(result), sentPaths: calls.slice(before).map(c => c.body.state.path).sort(), sentStateFields: [...new Set(calls.slice(before).flatMap(c => Object.keys(c.body.state)))].sort(), ignoredPathsInHistory: (report.code_checks?.ignored_paths_in_history ?? []).map((e: ObjectValue) => e.path), unreviewed: report.unreviewed ?? null, scope: report.scope ?? null };
      }
      const leaked = [JSON.stringify(calls), JSON.stringify(runs)].some(text => text.includes('PRIVATE_CANARY'));
      record('release.history', contract, { input: { repository: 'first commit adds kept.txt, removed.txt and old.pem; second commit ignores *.pem and removes removed.txt and old.pem from the index and the working tree', fixtureRule: 'every Noul is 0.02, so the model reports no findings', order: 'the worktree run is first; the history run reuses the same output ledger' }, implementationExcerpt: excerpt('public_release_review', ['list_history']), runs, ignoredCanarySentOrStored: leaked },
        !leaked && same(runs.worktree.sentPaths, ['.gitignore', 'kept.txt']) && same(runs.history.sentPaths, ['removed.txt']) && same(runs.history.sentStateFields, ['content', 'lines', 'path'])
        && same(runs.history.ignoredPathsInHistory, ['old.pem']) && same(runs.worktree.ignoredPathsInHistory, []) && runs.worktree.result.exit === 0 && runs.history.result.exit === 1);
    });
    // A repository whose history adds nothing beyond the index: the state right after a first commit.
    const single = join(scratch, 'release-single-commit-repo'); mkdirSync(single);
    const singleGit = (...args: string[]): void => { if (spawnSync('git', ['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: single, env: { PATH: env.PATH, HOME: scratch, GIT_CONFIG_NOSYSTEM: '1' }, timeout: 30_000 }).status !== 0) throw new Error('release_fixture_git_failed'); };
    singleGit('init', '-q'); mkdirSync(join(single, 'docs'));
    writeFileSync(join(single, 'docs/only.txt'), 'The only file, committed once.\n');
    singleGit('add', 'docs'); singleGit('commit', '-q', '-m', 'only');
    await server(body => ({ body: reply(body) }), async (endpoint, calls) => {
      const argv = ['--repo', single, '--model', 'routing-demo', '--confirm-send', '--history', '--output', join(scratch, 'release-single-out')];
      const result = await cli('public_release_review', argv, { TYPESAFE_ENDPOINT: endpoint, TYPESAFE_API_KEY: 'public-loopback-fixture' });
      const report = existsSync(join(scratch, 'release-single-out', 'report.json')) ? read(join(scratch, 'release-single-out', 'report.json')) : {};
      record('release.history-nothing-extra', contract, { input: { argv, repository: 'one commit containing docs/only.txt; the index equals that commit, so history holds no blob beyond the index', fixtureRule: 'every Noul is 0.02, so the model reports no findings' }, result: serializableRun(result), sentPaths: calls.map(c => c.body.state.path), historyBlobs: report.totals?.history_blobs ?? null, unreviewed: report.unreviewed ?? null },
        result.exit === 0 && same(calls.map(c => c.body.state.path), ['docs/only.txt']) && report.totals?.history_blobs === 0 && same(report.unreviewed, {}));
    });
    const thresholds = { review_threshold: .35, action_threshold: .7, severity_block: 2 };
    const hazards = Object.keys(battery).filter(id => battery[id].type === 'noul');
    const answers = (nouls: ObjectValue, severity = 0, insiders = 0): ObjectValue => ({ ...Object.fromEntries(hazards.map(id => [id, { noul: nouls[id] ?? .02 }])), 'audience.intended_reader': { probabilities: { public_users: 1 - insiders, contributors: 0, insiders_only: insiders, machines: 0 } }, 'severity.exposure': { score: severity } });
    const cases: [string, ObjectValue, string][] = [
      ['quiet', answers({}), 'pass'], ['secret-at-action', answers({ 'leak.secret': .7 }), 'block'],
      ['path-below-review', answers({ 'leak.local_path': .349 }), 'pass'], ['path-at-review', answers({ 'leak.local_path': .35 }), 'review'],
      ['review-upgraded-by-severity', answers({ 'leak.local_path': .5 }, 2), 'block'], ['severity-alone', answers({}, 3), 'review'],
      ['note-at-action', answers({ 'reputation.admits_unfinished_work': .9 }), 'note'], ['note-in-review-band', answers({ 'reputation.admits_unfinished_work': .5 }), 'pass'],
      ['insiders-choice', answers({}, 0, .7), 'review'],
    ];
    const outcomes = [];
    for (const [id, supplied, expected] of cases) outcomes.push({ id, supplied, expected, actual: await call('public_release_review', 'decide', [supplied, thresholds]) });
    record('release.policy', contract, { input: { function: 'decide', policy: thresholds }, implementationExcerpt: excerpt('public_release_review', ['decide']), cases: outcomes }, outcomes.every(o => o.actual.ok && o.actual.value.action === o.expected));
  }
}
