/** Cross-language executable scenarios; each row carries its own deterministic verdict. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Scenario = { id: string; contract: string; observed: Json; passed: boolean };
export const coreGroups = ['repository', 'examples', 'worker'] as const;
export type Group = typeof coreGroups[number] | 'laya' | 'laya-startup';

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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2);
  const selected = requested[0] === '--group' ? requested[1] : 'all'; // ubs:ignore — CLI flag comparison, not a secret.
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
