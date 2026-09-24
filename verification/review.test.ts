import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { questionProblems } from '../composition/questions.mts';
import { CAP, judgeUnits, prefilter, reasons, report, unit } from './review.ts';

const rubric = JSON.parse(readFileSync(join(import.meta.dirname, 'review.questions.json'), 'utf8'));
const clean = { scope: { type: 'choice', choice: 'belongs', probabilities: { belongs: 0.9, mixed: 0.08, unrelated: 0.02 }, confidence: 0.8 },
  weakens_checks: { type: 'choice', choice: 'none', probabilities: { none: 0.9, accounted: 0.05, unaccounted: 0.05 }, confidence: 0.8 },
  provider_dependency: { type: 'noul', noul: 0.01 } };

test('the frozen rubric is a valid native request for any route', () => {
  assert.deepEqual(questionProblems(rubric), []);
});

test('pre-filter skips deletions and lockfiles; units are capped visibly', () => {
  assert.equal(prefilter('hono/bun.lock', 'M'), 'lockfile');
  assert.equal(prefilter('go.sum', 'M'), 'lockfile');
  assert.equal(prefilter('verify.ts', 'D'), 'deleted');
  assert.equal(prefilter('router.go', 'M'), null);
  const big = unit('a.ts', ['subject'], 'x'.repeat(CAP + 10));
  assert.equal(big.truncated, true);
  assert.match((big.state as { diff: string }).diff, /\[truncated: 10 more characters\]$/);
  assert.equal(unit('b.ts', [], 'small').truncated, false);
});

test('escalation flags scope, uncertainty, nouls at the threshold, and errors', () => {
  assert.deepEqual(reasons({ file: 'a', answers: clean }), []);
  assert.deepEqual(reasons({ file: 'a', answers: { ...clean, scope: { ...clean.scope, choice: 'mixed' } } }), ['scope=mixed']);
  assert.deepEqual(reasons({ file: 'a', answers: { ...clean, weakens_checks: { ...clean.weakens_checks, choice: 'accounted' } } }), []);
  assert.deepEqual(reasons({ file: 'a', answers: { ...clean, weakens_checks: { ...clean.weakens_checks, choice: 'unaccounted' } } }), ['weakens_checks=unaccounted']);
  assert.deepEqual(reasons({ file: 'a', answers: { ...clean, scope: { ...clean.scope, probabilities: { belongs: 0.6, mixed: 0.3, unrelated: 0.1 } } } }), ['scope at risk (0.40 on mixed/unrelated)']);
  // Uncertainty between two clear labels is not risk.
  assert.deepEqual(reasons({ file: 'a', answers: { ...clean, weakens_checks: { ...clean.weakens_checks, probabilities: { none: 0.5, accounted: 0.45, unaccounted: 0.05 } } } }), []);
  assert.deepEqual(reasons({ file: 'a', answers: { ...clean, provider_dependency: { type: 'noul', noul: 0.3 } } }), ['provider_dependency 0.30']);
  assert.deepEqual(reasons({ file: 'a', error: 'System One request failed: http_502' }), ['error: System One request failed: http_502']);
});

test('every file gets its own concurrent request; a failure stays in its row', async () => {
  let active = 0, peak = 0;
  const seen: { file: string; questions: string[] }[] = [];
  const server = createServer(async (req, res) => {
    active++; peak = Math.max(peak, active);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ file: body.state.file, questions: Object.keys(body.questions) });
    await new Promise(done => setTimeout(done, 50));
    active--;
    res.setHeader('content-type', 'application/json');
    if (body.state.file === 'broken.ts') { res.statusCode = 502; res.end(JSON.stringify({ detail: [{ type: 'upstream_unavailable' }] })); return; }
    const answers = body.state.file === 'odd.ts' ? { ...clean, scope: { ...clean.scope, choice: 'unrelated' } } : clean;
    res.end(JSON.stringify({ model: 'jev', answers, usage: { input_tokens: 100, output_tokens: 5 } }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  try {
    const files = ['a.ts', 'b.ts', 'odd.ts', 'broken.ts', 'c.ts', 'd.ts'];
    const units = files.map(file => unit(file, ['Add a thing'], `diff for ${file}`));
    const questions = { scope: rubric.scope, weakens_checks: rubric.weakens_checks, provider_dependency: rubric.provider_dependency };
    const verdicts = await judgeUnits({ endpoint: `http://127.0.0.1:${port}`, apiKey: 'k' }, 'hosted', units, questions);
    assert.deepEqual(verdicts.map(v => v.file), files);
    assert.deepEqual(seen.map(s => s.file).sort(), [...files].sort());
    assert.ok(seen.every(s => s.questions.length === 3), 'all questions go in one request per file');
    assert.ok(peak > 1, 'requests run concurrently');
    const text = report(verdicts, { lockfile: 2, deleted: 1 }, 0);
    assert.match(text, /6 files judged, 1 errors; skipped lockfile 2, deleted 1; 0 truncated; 500 input tokens/);
    assert.match(text, /scope: belongs 4, unrelated 1/);
    assert.match(text, /read these 2/);
    assert.match(text, /odd\.ts: scope=unrelated/);
    assert.match(text, /broken\.ts: error: System One request failed: upstream_unavailable/);
  } finally { server.close(); server.closeAllConnections(); }
});
