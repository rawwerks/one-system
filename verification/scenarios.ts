/** Executable observations consumed by System One; no Python test discovery. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChoiceQuestion, Json } from './semantic.ts';

export type Scenario = { id: string; contract: string; observed: Json; passed: boolean };
export const coreGroups = ['repository', 'examples', 'worker'] as const;
export type Group = typeof coreGroups[number] | 'laya' | 'laya-startup';

export function requireObligations(kinds: string[], includeLaya = false): void {
  for (const kind of ['capabilities', 'self', ...coreGroups, ...(includeLaya ? ['laya'] : [])]) {
    if (!kinds.includes(kind)) throw new Error('missing_required_obligation');
  }
}

export function scenarioStatus(rows: Scenario[]): 'passed' | 'failed' | 'incomplete' {
  if (!rows.length || rows.some(row => !row.id || !row.contract || typeof row.passed !== 'boolean')) throw new Error('invalid_scenario_evidence');
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('duplicate_scenario_evidence');
  const missing = (row: Scenario) => row.observed !== null && typeof row.observed === 'object' && !Array.isArray(row.observed) && row.observed.status === 'incomplete';
  if (rows.some(row => !row.passed && !missing(row))) return 'failed';
  return rows.some(missing) ? 'incomplete' : 'passed';
}

export async function collect(group: Group, root: string): Promise<Scenario[]> {
  switch (group) {
    case 'repository': return (await import('./repository.ts')).collectRepository(root);
    case 'examples': return (await import('./examples.ts')).collectExamples(root);
    case 'worker': return (await import('./worker.ts')).collectWorker(root);
    case 'laya': case 'laya-startup': return (await import('./laya.ts')).collectLaya(root, { checkpoint: group === 'laya' });
  }
}

// Semantic state excludes the deterministic verdict so the model must compare
// actual observations with their promises, rather than repeat a pass label.
export function semanticRows(rows: Scenario[]): Json[] {
  scenarioStatus(rows);
  return rows.map(({ id, contract, observed }) => ({ id, contract, observed }));
}


export function scenarioQuestions(template: Record<string, ChoiceQuestion>, rows: Json[]): Record<string, ChoiceQuestion> {
  const questions: Record<string, ChoiceQuestion> = {};
  for (const row of rows) {
    if (!row || Array.isArray(row) || typeof row !== 'object' || typeof row.id !== 'string') throw new Error('invalid_scenario_identity');
    for (const [name, question] of Object.entries(template)) {
      if (typeof question.instructions !== 'string' || !question.instructions.includes('{{case_id}}')) throw new Error('missing_scenario_question_binding');
      const id = `${name}:${row.id}`;
      if (Object.hasOwn(questions, id)) throw new Error('duplicate_scenario_question');
      questions[id] = { ...question, instructions: question.instructions.replaceAll('{{case_id}}', JSON.stringify(row.id)) };
    }
  }
  if (!Object.keys(questions).length) throw new Error('no_scenario_questions');
  return questions;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2);
  const selected = requested[0] === '--group' ? requested[1] : 'all';
  if ((requested.length && (requested.length !== 2 || requested[0] !== '--group')) || !['all', ...coreGroups, 'laya', 'laya-startup'].includes(selected)) {
    console.error('Usage: node verification/scenarios.ts [--group all|repository|examples|worker|laya|laya-startup]');
    process.exitCode = 2;
  } else {
    const root = fileURLToPath(new URL('../', import.meta.url));
    mkdirSync(join(root, '.build/scenarios'), { recursive: true, mode: 0o700 });
    const output = process.env.ONE_SYSTEM_SCENARIO_EVIDENCE_DIR || mkdtempSync(join(root, '.build/scenarios/run-'));
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const groups = selected === 'all' ? [...coreGroups] : [selected as Group];
    const statuses = await Promise.all(groups.map(async group => {
      let rows: Scenario[];
      try { rows = await collect(group, root); scenarioStatus(rows); }
      catch { rows = [{ id: `${group}.collection`, contract: 'The scenario collector must execute completely.', observed: { error: 'collection_failed' }, passed: false }]; }
      const status = scenarioStatus(rows);
      writeFileSync(join(output, `${group}.json`), JSON.stringify({ version: 1, group, status, rows }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      console.log(`${group}: ${status} (${rows.length} observations)`);
      for (const row of rows.filter(row => !row.passed)) console.log(`  ${row.id}: ${JSON.stringify(row.observed)}`);
      return status;
    }));
    console.log(`Scenario evidence: ${output}`);
    process.exitCode = statuses.includes('failed') ? 1 : statuses.includes('incomplete') ? 2 : 0;
  }
}
