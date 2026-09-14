/**
 * modes-eval — run the real-CLI end-to-end eval suite, unattended.
 *
 * Usage:  bun packages/orchestrator/scripts/modes-eval.ts [--all] [scenarioId...]
 *         (no arguments runs the core tier; --all runs every scenario;
 *          explicit scenario ids run regardless of tier)
 *
 * Every scenario runs the full pipeline against real CLIs (lanes kimi + qwen,
 * reviewer/synthesizer kimi) in a throwaway git repo, auto-picks, merges, verifies,
 * and checks the scenario's expectations. A summary line per run is appended to
 * packages/orchestrator/evals/eval-runs.jsonl (gitignored — eval data is not code).
 * Exit code: 0 when every scenario passed, 1 otherwise.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EVAL_SCENARIOS, selectScenarios } from '../src/eval/scenarios';
import { runEval, type ScenarioResult } from '../src/eval/runEval';
import { mergeLane } from '../src/gate/mergeLane';
import { recordUserPick } from '../src/gate/recordUserPick';
import { runBrainstorm } from '../src/patterns/brainstorm';
import { runCascade } from '../src/patterns/cascade';
import { runRoundtable } from '../src/patterns/roundtable';
import { runSingle } from '../src/patterns/single';
import { runTask } from '../src/run/runTask';

const here = path.dirname(fileURLToPath(import.meta.url));
const evalsDir = path.resolve(here, '..', 'evals');
const runsFile = path.join(evalsDir, 'eval-runs.jsonl');
/** per-scenario event logs are copied here before the throwaway repos evaporate */
const eventsDir = path.join(evalsDir, 'events');

const args = process.argv.slice(2);
const all = args.includes('--all');
const ids = args.filter((a) => a !== '--all');
const scenarios = selectScenarios(EVAL_SCENARIOS, { ids, all });
if (scenarios.length === 0) {
  console.error(`no scenario matches; known ids: ${EVAL_SCENARIOS.map((s) => s.id).join(', ')}`);
  process.exit(2);
}

const scope = ids.length > 0 ? 'selected ids' : all ? 'all tiers' : 'core tier';
console.log(`modes-eval: ${scenarios.length} scenario(s) (${scope}), real CLIs (lanes kimi+qwen, reviewer/synthesizer kimi)\n`);

const results = await runEval(
  scenarios,
  { runTask, runBrainstorm, runCascade, runRoundtable, runSingle, recordPick: recordUserPick, mergeLane },
  { eventsDir }
);

function formatRow(r: ScenarioResult): string {
  const status = r.pass ? 'PASS' : 'FAIL';
  const duration = `${(r.durationMs / 1000).toFixed(1)}s`;
  const pick = r.pick ? ` pick=${r.pick}` : '';
  const routed = r.resolvedMode ? ` auto→${r.resolvedMode}` : '';
  const lanes = r.laneOutcomes ? ` lanes=${JSON.stringify(r.laneOutcomes)}` : '';
  const failures = r.failures.length > 0 ? `\n    failures: ${r.failures.join('; ')}` : '';
  return `${status}  ${r.scenarioId.padEnd(18)} ${duration.padStart(8)}  events=${r.eventCount ?? '-'}${routed}${pick}${lanes}${failures}`;
}

console.log('\n──── EVAL REPORT ────');
for (const r of results) {
  console.log(formatRow(r));
}
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
for (const r of results) {
  console.log(`  ${r.scenarioId}: workDir=${r.workDir || '(cleaned up)'} events=${r.eventsFile ?? '(none)'} snapshot=${r.eventsSnapshot ?? '(none)'}`);
}

await mkdir(evalsDir, { recursive: true });
await appendFile(
  runsFile,
  JSON.stringify({ ts: new Date().toISOString(), passed, total: results.length, results }) + '\n',
  'utf8'
);
console.log(`\nsummary appended to ${runsFile}`);

process.exit(passed === results.length ? 0 : 1);
