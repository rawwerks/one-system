/** Deterministic evidence plumbing. Semantic judgments never replace these checks. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChoiceQuestion, Json } from './semantic.ts';

export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const bytes = (value: unknown): string => JSON.stringify(value);
function stable(value: any): any {
  return Array.isArray(value) ? value.map(stable) : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
}
export function read(root: string, path: string): string {
  if (!path || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('unsafe_source_path');
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const info = lstatSync(join(root, ...parts.slice(0, i)));
    if (info.isSymbolicLink() || (i === parts.length && (!info.isFile() || info.size > 2 * 1024 * 1024))) throw new Error('unsafe_source_file');
  }
  return readFileSync(join(root, path), 'utf8');
}
export function snapshot(root: string): Record<string, string> {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (git('ls-files', '--others', '--exclude-standard', '-z')) throw new Error('stage_new_source_files_before_verifying');
  const entries = git('ls-files', '--stage', '-z').split('\0').filter(Boolean);
  return Object.fromEntries(entries.map((entry): [string, string] => {
    const separator = entry.indexOf('\t');
    const [mode, revision, stage] = entry.slice(0, separator).split(' ');
    const path = entry.slice(separator + 1);
    if (stage !== '0') throw new Error('unmerged_source_files');
    if (mode !== '160000') return [path, hash(read(root, path))];
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      if (lstatSync(join(root, ...parts.slice(0, i))).isSymbolicLink()) throw new Error('unsafe_source_file');
    }
    const moduleRoot = join(root, path);
    // A gitlink is a pinned dependency, not a regular source file. Require its
    // actual checkout (including nested dependencies) to match the recorded pin.
    lstatSync(join(moduleRoot, '.git'));
    const moduleGit = (...args: string[]) => execFileSync('git', args, { cwd: moduleRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (moduleGit('rev-parse', 'HEAD').trim() !== revision) throw new Error('submodule_revision_mismatch');
    if (moduleGit('status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none')) throw new Error('modified_submodule_source');
    if (moduleGit('submodule', 'status', '--recursive').split('\n').some(line => /^[-+U]/.test(line))) throw new Error('unavailable_nested_submodule');
    return [path, hash(`gitlink:${revision}`)];
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}
export const current = (before: Record<string, string>, after: Record<string, string>): boolean => bytes(before) === bytes(after);

// Explicit export scope. A graph edge alone cannot authorize sending a private file.
const sources = new Set(['README.md', 'contract/invariants.json', 'contract/cases/capability-verification.json',
  'router.go', 'hono/src/app.ts', 'verification/README.md', 'verification/evidence.ts',
  'verification/SCENARIOS.md', 'verification/evidence.test.ts', 'verification/semantic.ts', 'verification/semantic.test.ts', 'verification/verify.ts']);
export type Graph = { nodes: Record<string, { hash: string }>; edges: { from: string; to: string; kind: string }[] };
export type Obligation = { id: string; evidence: 'capabilities' | 'self' | 'repository' | 'examples' | 'worker' | 'laya'; inputs: Record<string, string>; questions: Record<string, ChoiceQuestion> };

export function resolveFact(root: string, id: string): { text: Json; hash: string } {
  const [path, fragment] = id.split('#');
  if (!sources.has(path)) throw new Error('source_not_exportable');
  const raw = read(root, path);
  if (!fragment) return { text: raw, hash: hash(raw).slice(0, 16) };
  if (path === 'contract/invariants.json' && fragment.startsWith('invariants.')) {
    const matches = JSON.parse(raw).invariants.filter((item: any) => item.id === fragment.slice('invariants.'.length));
    if (matches.length !== 1) throw new Error('missing_or_duplicate_contract_fact');
    return { text: matches[0], hash: hash(bytes(stable(matches[0]))).slice(0, 16) };
  }
  const lines = raw.split('\n');
  const start = lines.findIndex(line => line.includes(`true-up:anchor id=${fragment}`));
  const end = lines.findIndex((line, i) => i > start && line.includes(`true-up:end id=${fragment}`));
  if (start < 0 || end <= start) throw new Error('missing_source_span');
  const text = lines.slice(start + 1, end).join('\n');
  return { text, hash: hash(text).slice(0, 16) };
}
export function loadObligations(root: string, graph: Graph) {
  const ids = new Set<string>();
  const files = readdirSync(join(root, 'verification/obligations')).filter(p => p.endsWith('.json')).sort();
  if (!files.length) throw new Error('no_verification_obligations');
  return files.map(name => {
    const path = `verification/obligations/${name}`;
    const raw = read(root, path);
    const spec = JSON.parse(raw) as Obligation;
    if (!/^[a-z][a-z0-9.-]+$/.test(spec.id) || ids.has(spec.id)
        || !['capabilities', 'self', 'repository', 'examples', 'worker', 'laya'].includes(spec.evidence) || !spec.inputs || !Object.keys(spec.inputs).length) throw new Error('invalid_obligation');
    ids.add(spec.id);
    if (graph.nodes[`file:${path}`]?.hash !== hash(raw).slice(0, 16)) throw new Error('stale_obligation_graph');
    const state: Record<string, Json> = {};
    for (const [field, id] of Object.entries(spec.inputs)) {
      const node = `${id.includes('#') ? 'fact' : 'file'}:${id}`;
      if (!graph.edges.some(e => e.from === `file:${path}` && e.to === node && e.kind === 'derives-facts-from')) throw new Error('missing_declared_dependency');
      const fact = resolveFact(root, id);
      if (graph.nodes[node]?.hash !== fact.hash) throw new Error('stale_source_fact');
      state[field] = fact.text;
    }
    return { path, spec, state };
  });
}

export function observations(records: any[], fixture: any): Json[] {
  const expected = new Set<string>();
  for (const runtime of ['go', 'hono']) for (const c of fixture.cases) for (const model of ['routing-demo', 'local']) expected.add(`${runtime}/${c.name}/${model}`);
  if (records.length !== expected.size) throw new Error('incomplete_observation_coverage');
  for (const record of records) {
    const id = `${record.runtime}/${record.case}/${record.model}`;
    const c = fixture.cases.find((item: any) => item.name === record.case);
    if (!expected.delete(id) || !c || record.version !== 1 || record.obligation !== 'routing.hard-capabilities'
        || bytes(stable(record.capabilities)) !== bytes(stable(fixture.capabilities))) throw new Error('invalid_observation_identity');
    const request = JSON.parse(record.request_raw);
    if (request.model !== record.model || bytes(request.questions.q) !== c.question_raw
        || record.response_status !== c.expected_status || !Array.isArray(record.upstream_calls)
        || record.upstream_calls.length !== c.expected_upstream_calls) throw new Error('observation_failed_native_contract');
    if (record.response_status === 422 && !JSON.parse(record.response_body).detail.some((e: any) => e.type === 'unsupported_capability')) throw new Error('wrong_rejection_reason');
    for (const call of record.upstream_calls) {
      const sent = JSON.parse(call.body_raw);
      if (sent.model !== 'local-model' || bytes(sent.questions) !== bytes(request.questions) || bytes(sent.state) !== bytes(request.state)) throw new Error('unexpected_upstream_request');
    }
  }
  // Project only the synthetic observation schema, never paths, headers or environments.
  return records.map(r => ({ runtime: r.runtime, case: r.case, model: r.model, request_raw: r.request_raw,
    capabilities: r.capabilities, response_status: r.response_status, response_body: r.response_body,
    upstream_calls: r.upstream_calls.map((c: any) => ({ body_raw: c.body_raw })) }));
}

export type CompletionInput = { native: boolean; fresh: boolean; semantic: ('clear' | 'finding' | 'unresolved' | 'not_run')[] };
export function completion(input: CompletionInput): 'failed' | 'incomplete' | 'needs_review' | 'passed' {
  if (!input.native) return 'failed';
  if (!input.fresh || !input.semantic.length || input.semantic.some(s => s === 'not_run' || s === 'unresolved')) return 'incomplete';
  if (input.semantic.some(s => s === 'finding')) return 'needs_review';
  if (input.semantic.some(s => s !== 'clear')) return 'incomplete';
  return 'passed';
}
export function selfObservations() {
  return [
    { native: false, fresh: true, semantic: ['clear'] },
    { native: true, fresh: false, semantic: ['clear'] },
    { native: true, fresh: true, semantic: [] },
    { native: true, fresh: true, semantic: ['not_run'] },
    { native: true, fresh: true, semantic: ['unresolved'] },
    { native: true, fresh: true, semantic: ['finding'] },
    { native: true, fresh: true, semantic: ['clear', 'clear'] },
  ].map(input => ({ input, output: completion(input as CompletionInput) }));
}
