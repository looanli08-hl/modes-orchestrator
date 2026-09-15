/**
 * modes-run — the MVP as one interactive command (spec-mvp §1 + §2.5).
 *
 * Usage:  bun packages/orchestrator/scripts/modes-run.ts [--mode single|compete|brainstorm|cascade|roundtable|auto] "<prompt>" [repoPath]
 *         echo A | bun ...modes-run.ts ...   (piped pick, for testing)
 * compete (default): fan-out → cross-review → show both diffs → you pick → merge.
 *   repoPath defaults to the current directory (must be a git repo).
 * single: one CLI (kimi) answers directly, one shot — merge its diff or don't.
 * brainstorm: N lanes answer in parallel → synthesis of the diversity. No pick, no merge.
 * roundtable: N CLIs answer, a reviewer judges consensus, non-consensus → a revision
 *   round where lanes see each other's answers, then synthesis. No pick, no merge.
 * cascade: cheap CLI first, escalate on failure or empty diff → winner diff → merge or not.
 * auto: the AI dispatcher (kimi, rule fallback) picks the mode — the decision and its
 *   reason are printed first, then the resolved mode runs with its usual lanes/chain
 *   and the exact same display + gate.
 */

import path from 'node:path';
import readline from 'node:readline';

import { buildAgentContext, formatCliHelp } from '../src/agentContext/agentContext';
import { mergeLane } from '../src/gate/mergeLane';
import { recordUserPick } from '../src/gate/recordUserPick';
import type { UserPick } from '../src/gate/userGate';
import { runBrainstorm, type BrainstormResult } from '../src/patterns/brainstorm';
import { runCascade, type CascadeResult } from '../src/patterns/cascade';
import { runRoundtable, type RoundtableResult } from '../src/patterns/roundtable';
import { runSingle, type SingleResult } from '../src/patterns/single';
import { runRouted } from '../src/router/runRouted';
import { runTask, type RunTaskResult } from '../src/run/runTask';
import { preferredSecondCli } from '../src/spawn/cliAdapters';

/**
 * Lane B of every default topology below. qwen's own account is broken
 * (ModelScope 400, 2026-09), so the working second lane is deepseek — the qwen
 * binary pointed at DeepSeek's OpenAI-compatible endpoint (cliAdapters.ts).
 * With no DeepSeek key configured it falls back to qwen. To pin qwen
 * regardless, replace preferredSecondCli() with 'qwen' at the call site.
 */
const SECOND_CLI = preferredSecondCli();

function presentBrainstormResult(result: BrainstormResult): void {
  for (const lane of result.lanes) {
    console.log(`\n──── LANE ${lane.lane} (${lane.outcome}) ────`);
    console.log(lane.answer.slice(0, 1500));
  }
  console.log(`\n──── SYNTHESIS ────`);
  console.log(result.synthesis ?? '(skipped — all lanes failed)');
  console.log(`\nevents: ${result.eventsFile}`);
}

function presentRoundtableResult(result: RoundtableResult): void {
  console.log(`task: ${result.taskId}`);
  for (const round of result.rounds) {
    console.log(`\n════ ROUND ${round.round} ════`);
    for (const lane of round.lanes) {
      console.log(`\n──── ${lane.cli} (${lane.outcome}) ────`);
      console.log(lane.answer.slice(0, 1500));
    }
  }
  console.log(`\nconsensus after round 1: ${result.consensus ? 'YES — early stop, round 2 skipped' : 'NO'}`);
  console.log(`\n──── SYNTHESIS ────`);
  console.log(result.synthesis ?? '(skipped — all round-1 lanes failed)');
  console.log(`\nevents: ${result.eventsFile}`);
}

async function presentCascadeResult(repoPath: string, result: CascadeResult): Promise<void> {
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
}

async function presentCompeteResult(repoPath: string, result: RunTaskResult): Promise<void> {
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
}

async function presentSingleResult(repoPath: string, result: SingleResult): Promise<void> {
  const lane = result.lane;
  console.log(`task: ${result.taskId}`);
  console.log(`\n──── SINGLE (${lane.cli}, ${lane.outcome}) ────`);
  console.log(lane.summary.slice(0, 1500));
  console.log(lane.diff ? lane.diff.slice(0, 2000) : '(no changes)');

  // The gate: merge the lane's diff or don't — but only when there is one.
  const mergeable = lane.outcome === 'success' && lane.diff.trim() !== '';
  let merge = false;
  if (mergeable) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => rl.question('\nMerge? [y/N] ', resolve));
    rl.close();
    merge = answer.trim().toLowerCase() === 'y';
  }

  const pick: UserPick = merge ? 'single' : 'neither';
  await recordUserPick(result.eventsFile, { taskId: result.taskId, pick, reviewVerdict: null });

  if (pick === 'neither') {
    console.log(`\nRecorded: neither. Worktrees kept at ${repoPath}/.modes-worktrees/ for inspection.`);
  } else {
    await mergeLane({ repoPath, worktreePath: lane.worktreePath, branch: lane.branch, taskId: result.taskId, pick });
    console.log(`\nMerged single (${lane.cli}) into the current branch. Gate recorded (verifier human:${pick}).`);
  }
}

const args = process.argv.slice(2);

// meta flags exit before prompt parsing — `--help` must never be read as a prompt
if (args.includes('--agent-context')) {
  console.log(JSON.stringify(buildAgentContext(), null, 2));
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(formatCliHelp());
  process.exit(0);
}

const modeFlagIndex = args.indexOf('--mode');
const mode = modeFlagIndex >= 0 ? args[modeFlagIndex + 1] : 'compete';
if (modeFlagIndex >= 0) args.splice(modeFlagIndex, 2);

const prompt = args[0];
if (
  !prompt ||
  (mode !== 'single' && mode !== 'compete' && mode !== 'brainstorm' && mode !== 'cascade' && mode !== 'auto' && mode !== 'roundtable')
) {
  console.error('usage: bun modes-run.ts [--mode single|compete|brainstorm|cascade|roundtable|auto] "<prompt>" [repoPath]');
  process.exit(2);
}
const repoPath = path.resolve(args[1] ?? process.cwd());

if (mode === 'auto') {
  // the AI dispatcher (a kimi call, rule fallback built in) decides; the decision
  // and its reason print before the resolved mode starts spending quota.
  const { classification, result } = await runRouted({ prompt, repoPath });
  const source = classification.dispatchSource === 'ai' ? 'AI dispatch' : 'rules fallback';
  console.log(`repo: ${repoPath}`);
  console.log(`prompt: ${prompt}`);
  console.log(`auto → ${classification.mode} (${source}): ${classification.reason}\n`);

  if (classification.mode === 'single') {
    await presentSingleResult(repoPath, result as SingleResult);
  } else if (classification.mode === 'brainstorm') {
    presentBrainstormResult(result as BrainstormResult);
  } else if (classification.mode === 'roundtable') {
    presentRoundtableResult(result as RoundtableResult);
  } else if (classification.mode === 'cascade') {
    await presentCascadeResult(repoPath, result as CascadeResult);
  } else {
    await presentCompeteResult(repoPath, result as RunTaskResult);
  }
  process.exit(0);
}

if (mode === 'single') {
  console.log(`repo: ${repoPath}`);
  console.log(`prompt: ${prompt}`);
  console.log('single shot with kimi (no fallback — one shot, honest result) …\n');

  const result = await runSingle({ repoPath, prompt, cli: 'kimi' });
  await presentSingleResult(repoPath, result);
  process.exit(0);
}

if (mode === 'brainstorm') {
  console.log(`prompt: ${prompt}`);
  console.log(`brainstorming with kimi + ${SECOND_CLI} …\n`);

  const result = await runBrainstorm({
    prompt,
    lanes: [
      { lane: 'A', cli: 'kimi' },
      { lane: 'B', cli: SECOND_CLI },
    ],
    synthesizerCli: 'kimi',
    workDir: repoPath,
  });

  presentBrainstormResult(result);
  process.exit(0);
}

if (mode === 'roundtable') {
  console.log(`prompt: ${prompt}`);
  console.log(`roundtable with kimi + ${SECOND_CLI} (up to 2 rounds, early stop on consensus) …\n`);

  const result = await runRoundtable({
    prompt,
    clis: ['kimi', SECOND_CLI],
    workDir: repoPath,
  });

  presentRoundtableResult(result);
  process.exit(0);
}

if (mode === 'cascade') {
  console.log(`repo: ${repoPath}`);
  console.log(`prompt: ${prompt}`);
  console.log(`cascading ${SECOND_CLI} → kimi (cheap first, escalate on failure or empty diff) …\n`);

  const result = await runCascade({
    repoPath,
    prompt,
    chain: [{ cli: SECOND_CLI }, { cli: 'kimi' }],
  });

  await presentCascadeResult(repoPath, result);
  process.exit(0);
}

console.log(`repo: ${repoPath}`);
console.log(`prompt: ${prompt}`);
console.log(`fanning out to kimi + ${SECOND_CLI} …\n`);

const result = await runTask({
  repoPath,
  prompt,
  lanes: [
    { lane: 'A', cli: 'kimi' },
    { lane: 'B', cli: SECOND_CLI },
  ],
  reviewerCli: 'kimi',
});

await presentCompeteResult(repoPath, result);
