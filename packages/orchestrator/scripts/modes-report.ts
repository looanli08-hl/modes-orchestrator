/**
 * modes-report — aggregate the retained eval data into a plain-text report.
 *
 * Usage:  bun packages/orchestrator/scripts/modes-report.ts [--last N]
 *         (defaults to the most recent 10 runs)
 *
 * Reads packages/orchestrator/evals/eval-runs.jsonl (run summaries) joined with the
 * per-scenario event snapshots under packages/orchestrator/evals/events/ retained by
 * modes-eval. Sections with insufficient data print "(no data)" — nothing is invented.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_LAST_RUNS, loadReportData, renderReport } from '../src/eval/report';

const here = path.dirname(fileURLToPath(import.meta.url));
const evalsDir = path.resolve(here, '..', 'evals');

const args = process.argv.slice(2);
let last = DEFAULT_LAST_RUNS;
const lastIndex = args.indexOf('--last');
if (lastIndex !== -1) {
  const value = Number(args[lastIndex + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`--last expects a positive integer, got "${args[lastIndex + 1]}"`);
    process.exit(2);
  }
  last = value;
}

const { runs, eventsBySnapshot } = await loadReportData(evalsDir, last);
console.log(renderReport(runs, eventsBySnapshot));
