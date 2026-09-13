/**
 * modes-run — the MVP as one interactive command (spec-mvp §1 walking skeleton,
 * user-facing): fan-out → cross-review → show both diffs → you pick → merge.
 *
 * Usage:  bun packages/orchestrator/scripts/modes-run.ts "<prompt>" [repoPath]
 *         echo A | bun ...modes-run.ts ...   (piped pick, for testing)
 * repoPath defaults to the current directory (must be a git repo).
 */

import path from 'node:path';
import readline from 'node:readline';

import { mergeLane } from '../src/gate/mergeLane';
import { recordUserPick } from '../src/gate/recordUserPick';
import type { UserPick } from '../src/gate/userGate';
import { runTask } from '../src/run/runTask';

const prompt = process.argv[2];
if (!prompt) {
  console.error('usage: bun modes-run.ts "<prompt>" [repoPath]');
  process.exit(2);
}
const repoPath = path.resolve(process.argv[3] ?? process.cwd());

console.log(`repo: ${repoPath}`);
console.log(`prompt: ${prompt}`);
console.log('fanning out to kimi + qwen …\n');

const result = await runTask({
  repoPath,
  prompt,
  lanes: [
    { lane: 'A', cli: 'kimi' },
    { lane: 'B', cli: 'qwen' },
  ],
  reviewerCli: 'kimi',
});

console.log(`task: ${result.taskId}`);
for (const lane of result.lanes) {
  console.log(`\n──── LANE ${lane.lane} (${lane.outcome}) ────`);
  console.log(lane.summary.slice(0, 400));
  console.log(lane.diff ? lane.diff.slice(0, 2000) : '(no changes)');
}
console.log(`\n──── REVIEW ────`);
console.log(result.review ? `${result.review.verdict}: ${result.review.rationale.slice(0, 600)}` : '(skipped — both lanes failed)');
if (result.review?.pick) {
  console.log(`评审推荐: ${result.review.pick === 'tie' ? 'TIE（质量相当）' : `LANE ${result.review.pick}`}`);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await new Promise<string>((resolve) => rl.question('\nPick A / B / neither? ', resolve));
rl.close();

const pick = answer.trim().toUpperCase();
const normalized: UserPick = pick === 'A' || pick === 'B' ? pick : 'neither';

await recordUserPick(result.eventsFile, {
  taskId: result.taskId,
  pick: normalized,
  reviewVerdict: result.review?.verdict ?? null,
});

if (normalized === 'neither') {
  console.log(`\nRecorded: neither. Worktrees kept at ${repoPath}/.modes-worktrees/ for inspection.`);
} else {
  const lane = result.lanes.find((l) => l.lane === normalized);
  if (!lane) throw new Error(`lane ${normalized} not found`);
  await mergeLane({
    repoPath,
    worktreePath: lane.worktreePath,
    branch: lane.branch,
    taskId: result.taskId,
    pick: normalized,
  });
  console.log(`\nMerged lane ${normalized} into the current branch. Gate recorded (verifier human:${normalized}).`);
}
