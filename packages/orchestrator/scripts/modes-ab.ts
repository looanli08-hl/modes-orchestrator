/**
 * modes-ab — blind A/B eval: roundtable (kimi+qwen debate) vs a single model (kimi),
 * judged blindly by kimi with order-swapped double judgments.
 *
 * Usage:  bun packages/orchestrator/scripts/modes-ab.ts [--dry-run] [questionId...]
 *         (no ids runs all six questions; --dry-run prints the questions and a sample
 *          judge prompt without spawning anything)
 *
 * Every question's raw data (both arm answers in full, both judge outputs in full,
 * the X/Y→arm mappings) is written to packages/orchestrator/evals/ab-<timestamp>/
 * (gitignored — eval data is not code), and a summary line is appended to
 * packages/orchestrator/evals/eval-ab.jsonl. Exit code: 0 when every question was
 * judged (winner or not), 1 when any arm failed.
 */

import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AB_QUESTIONS,
  buildJudgePrompt,
  formatAbReport,
  runAbQuality,
  summarizeAbResults,
  type AbQuestionResult,
} from '../src/eval/abQuality';
import { makeRealDeps } from '../src/fanout/realDeps';
import { runRoundtable } from '../src/patterns/roundtable';

const here = path.dirname(fileURLToPath(import.meta.url));
const evalsDir = path.resolve(here, '..', 'evals');
const summaryFile = path.join(evalsDir, 'eval-ab.jsonl');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const ids = args.filter((a) => a !== '--dry-run');
const questions = ids.length > 0 ? AB_QUESTIONS.filter((q) => ids.includes(q.id)) : AB_QUESTIONS;
if (questions.length === 0) {
  console.error(`no question matches; known ids: ${AB_QUESTIONS.map((q) => q.id).join(', ')}`);
  process.exit(2);
}

if (dryRun) {
  console.log(`modes-ab --dry-run: ${questions.length} question(s), judge=kimi, single=kimi, roundtable=kimi+qwen\n`);
  for (const q of questions) {
    console.log(`- ${q.id}: ${q.question}`);
  }
  const sample = questions[0];
  console.log(`\n──── SAMPLE JUDGE PROMPT (${sample.id}) ────`);
  console.log(buildJudgePrompt(sample, '<answer shown as X>', '<answer shown as Y>'));
  console.log('\ndry run: no CLIs were spawned, nothing was written.');
  process.exit(0);
}

const runTs = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(evalsDir, `ab-${runTs}`);
const workDir = await mkdtemp(path.join(os.tmpdir(), 'modes-ab-'));
const taskId = `ab-${Date.now().toString(36)}`;

console.log(`modes-ab: ${questions.length} question(s), judge=kimi, single=kimi, roundtable=kimi+qwen`);
console.log(`raw outputs → ${runDir}\n`);

const realDeps = makeRealDeps(workDir, { taskId });
const results = await runAbQuality(questions, { spawnProcess: realDeps.spawnProcess, runRoundtable }, { workDir });

/** everything needed to re-derive the verdict, raw text included — eval data is not code */
function questionRecord(r: AbQuestionResult): Record<string, unknown> {
  return {
    questionId: r.questionId,
    status: r.status,
    winner: r.winner,
    failures: r.failures,
    durationMs: r.durationMs,
    singleAnswer: r.singleAnswer,
    roundtableAnswer: r.roundtableAnswer,
    judgments: r.judgments.map((j) => ({
      mapping: j.mapping,
      pick: j.pick,
      mapped: j.mapped,
      rawOutput: j.rawOutput,
    })),
  };
}

await mkdir(runDir, { recursive: true });
for (const r of results) {
  // oxlint-disable-next-line no-await-in-loop -- sequential writes keep failures attributable
  await writeFile(path.join(runDir, `${r.questionId}.json`), JSON.stringify(questionRecord(r), null, 2), 'utf8');
}

const totals = summarizeAbResults(results);
console.log(`\n${formatAbReport(results, totals)}`);

await appendFile(
  summaryFile,
  JSON.stringify({
    ts: new Date().toISOString(),
    runDir,
    config: { judge: 'kimi', single: 'kimi', roundtable: ['kimi', 'qwen'] },
    totals,
    results: results.map((r) => ({
      questionId: r.questionId,
      status: r.status,
      winner: r.winner,
      judgments: r.judgments.map((j) => ({ mapping: j.mapping, pick: j.pick, mapped: j.mapped })),
      failures: r.failures,
      durationMs: r.durationMs,
    })),
  }) + '\n',
  'utf8'
);
console.log(`\nsummary appended to ${summaryFile}`);

process.exit(totals.armFailed === 0 ? 0 : 1);
