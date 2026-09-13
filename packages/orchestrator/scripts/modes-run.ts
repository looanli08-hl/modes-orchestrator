/**
 * modes-run — the MVP as one interactive command (spec-mvp §1 + §2.5).
 *
 * Usage:  bun packages/orchestrator/scripts/modes-run.ts [--mode compete|brainstorm|cascade] "<prompt>" [repoPath]
 *         echo A | bun ...modes-run.ts ...   (piped pick, for testing)
 * compete (default): fan-out → cross-review → show both diffs → you pick → merge.
 *   repoPath defaults to the current directory (must be a git repo).
 * brainstorm: N lanes answer in parallel → synthesis of the diversity. No pick, no merge.
 * cascade: cheap CLI first, escalate on failure or empty diff → winner diff → merge or not.
 */

import path from 'node:path';
import readline from 'node:readline';

import { mergeLane } from '../src/gate/mergeLane';
import { recordUserPick } from '../src/gate/recordUserPick';
import type { UserPick } from '../src/gate/userGate';
import { runBrainstorm } from '../src/patterns/brainstorm';
import { runCascade } from '../src/patterns/cascade';
import { runTask } from '../src/run/runTask';

const args = process.argv.slice(2);
const modeFlagIndex = args.indexOf('--mode');
const mode = modeFlagIndex >= 0 ? args[modeFlagIndex + 1] : 'compete';
if (modeFlagIndex >= 0) args.splice(modeFlagIndex, 2);

const prompt = args[0];
if (!prompt || (mode !== 'compete' && mode !== 'brainstorm' && mode !== 'cascade')) {
  console.error('usage: bun modes-run.ts [--mode compete|brainstorm|cascade] "<prompt>" [repoPath]');
  process.exit(2);
}
const repoPath = path.resolve(args[1] ?? process.cwd());

if (mode === 'brainstorm') {
  console.log(`prompt: ${prompt}`);
  console.log('brainstorming with kimi + qwen …\n');

  const result = await runBrainstorm({
    prompt,
    lanes: [
      { lane: 'A', cli: 'kimi' },
      { lane: 'B', cli: 'qwen' },
    ],
    synthesizerCli: 'kimi',
    workDir: repoPath,
  });

  for (const lane of result.lanes) {
    console.log(`\n──── LANE ${lane.lane} (${lane.outcome}) ────`);
    console.log(lane.answer.slice(0, 1500));
  }
  console.log(`\n──── SYNTHESIS ────`);
  console.log(result.synthesis ?? '(skipped — all lanes failed)');
  console.log(`\nevents: ${result.eventsFile}`);
  process.exit(0);
}

if (mode === 'cascade') {
  console.log(`repo: ${repoPath}`);
  console.log(`prompt: ${prompt}`);
  console.log('cascading qwen → kimi (cheap first, escalate on failure or empty diff) …\n');

  const result = await runCascade({
    repoPath,
    prompt,
    chain: [{ cli: 'qwen' }, { cli: 'kimi' }],
  });

  console.log(`task: ${result.taskId}`);
  for (const attempt of result.attempts) {
    console.log(`  level ${attempt.level} (${attempt.cli}): ${attempt.outcome} in ${(attempt.latency / 1000).toFixed(1)}s`);
  }

  if (result.winner) {
    console.log(`\n──── WINNER level ${result.winner.level} (${result.winner.cli}) ────`);
    console.log(result.winner.summary.slice(0, 400));
    console.log(result.winner.diff.slice(0, 2000));
  } else {
    console.log('\nno winner — the chain is exhausted, every level failed');
  }

  // The gate: merge the winner or don't. recordUserPick only appends to the JSONL
  // log (no lane-set validation), so the 'cascade-N' pick string is fine.
  let merge = false;
  if (result.winner) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => rl.question('\nMerge? [y/N] ', resolve));
    rl.close();
    merge = answer.trim().toLowerCase() === 'y';
  }

  const pick: UserPick = merge && result.winner ? `cascade-${result.winner.level}` : 'neither';
  await recordUserPick(result.eventsFile, { taskId: result.taskId, pick, reviewVerdict: null });

  if (pick === 'neither') {
    console.log(`\nRecorded: neither. Worktrees kept at ${repoPath}/.modes-worktrees/ for inspection.`);
  } else {
    const winner = result.winner!;
    await mergeLane({
      repoPath,
      worktreePath: winner.worktreePath,
      branch: winner.branch,
      taskId: result.taskId,
      pick,
    });
    console.log(`\nMerged ${pick} into the current branch. Gate recorded (verifier human:${pick}).`);
  }
  process.exit(0);
}

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
const laneLetters = result.lanes.map((l) => l.lane);
const answer = await new Promise<string>((resolve) =>
  rl.question(`\nPick ${laneLetters.join(' / ')} / neither? `, resolve)
);
rl.close();

const pick = answer.trim().toUpperCase();
const normalized: UserPick = laneLetters.includes(pick) ? pick : 'neither';

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
