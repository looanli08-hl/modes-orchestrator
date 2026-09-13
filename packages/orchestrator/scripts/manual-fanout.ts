/**
 * Manual fan-out runner (spec-mvp A4 harness): fires one real prompt at the real CLI
 * lanes and prints both diffs side by side for the human to pick.
 *
 * Usage: bun packages/orchestrator/scripts/manual-fanout.ts "<prompt>" [repoPath]
 * Defaults: repoPath = fresh temp git repo; lanes A=kimi B=qwen; reviewer=kimi.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runTask } from '../src/run/runTask';

const prompt = process.argv[2] ?? "Create a file hello.txt containing the text 'hello modes'";
let repoPath = process.argv[3];

if (!repoPath) {
  repoPath = mkdtempSync(path.join(os.tmpdir(), 'modes-manual-fanout-'));
  execFileSync('git', ['init'], { cwd: repoPath });
  writeFileSync(path.join(repoPath, 'README.md'), 'seed\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['-c', 'user.email=modes@local', '-c', 'user.name=modes', 'commit', '-m', 'seed'], {
    cwd: repoPath,
  });
}

console.log(`repo: ${repoPath}`);
console.log(`prompt: ${prompt}\n`);

const result = await runTask({
  repoPath,
  prompt,
  lanes: [
    { lane: 'A', cli: 'kimi' },
    { lane: 'B', cli: 'qwen' },
  ],
  reviewerCli: 'kimi',
  timeoutMs: 5 * 60 * 1000,
});

console.log(`task: ${result.taskId}  state: ${result.state}`);
for (const lane of result.lanes) {
  console.log(`\n=== LANE ${lane.lane} (${lane.outcome}, ${lane.branch}) ===`);
  console.log(`summary: ${lane.summary.slice(0, 500)}`);
  console.log(`diff:\n${lane.diff || '(none)'}`);
}
console.log(`\n=== REVIEW ===`);
console.log(result.review ? `${result.review.verdict}: ${result.review.rationale.slice(0, 800)}` : '(skipped)');
console.log(`\nevents: ${result.eventsFile}`);
