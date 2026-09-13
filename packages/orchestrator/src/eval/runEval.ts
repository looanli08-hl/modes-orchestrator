/**
 * runEval — the unattended end-to-end eval runner. Each scenario gets a throwaway
 * git repo (or scratch dir for brainstorm), runs the real engine pipeline, then the
 * harness plays the human: it auto-picks (follow the review recommendation, else the
 * first successful lane, else "neither"), records the pick, merges, and verifies the
 * merge actually landed on the current branch. Expectations are checked against what
 * the engine did; one failing scenario never stops the rest.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { MergeLaneOptions } from '../gate/mergeLane';
import type { RecordUserPickOptions } from '../gate/recordUserPick';
import type { UserPick } from '../gate/userGate';
import type { BrainstormOptions, BrainstormResult } from '../patterns/brainstorm';
import type { CascadeOptions, CascadeResult } from '../patterns/cascade';
import type { RunTaskOptions, RunTaskResult } from '../run/runTask';
import { readEvents } from '../store/eventLogStore';
import type { EvalScenario } from './scenarios';

const execFileAsync = promisify(execFile);

/** the eval suite always competes the same two real CLIs */
export const EVAL_LANES = [
  { lane: 'A', cli: 'kimi' },
  { lane: 'B', cli: 'qwen' },
];

/** the eval cascade chain: cheapest first */
export const EVAL_CHAIN = [{ cli: 'qwen' }, { cli: 'kimi' }];

export interface EvalDeps {
  runTask: (options: RunTaskOptions) => Promise<RunTaskResult>;
  runBrainstorm: (options: BrainstormOptions) => Promise<BrainstormResult>;
  runCascade: (options: CascadeOptions) => Promise<CascadeResult>;
  recordPick: (eventsFile: string, options: RecordUserPickOptions) => Promise<void>;
  mergeLane: (options: MergeLaneOptions) => Promise<void>;
}

export interface ScenarioResult {
  scenarioId: string;
  pass: boolean;
  failures: string[];
  durationMs: number;
  eventsFile: string | null;
  /** temp repo (compete) / scratch dir (brainstorm), kept for post-mortem inspection */
  workDir: string;
  pick?: UserPick;
  laneOutcomes?: Record<string, string>;
  eventCount?: number;
  /** lane/role → latency ms, read back from the JSONL event log */
  stageLatencies?: Record<string, number>;
}

/**
 * The auto-pick policy: follow the review's quality recommendation when it names a
 * successful lane; otherwise take the first successful lane; if nothing succeeded,
 * pick "neither" (nothing mergeable → nothing merged).
 */
export function decidePick(result: RunTaskResult): UserPick {
  const successful = result.lanes.filter((l) => l.outcome === 'success');
  const recommended = result.review?.pick;
  if (recommended && recommended !== 'tie' && successful.some((l) => l.lane === recommended)) {
    return recommended;
  }
  return successful.length > 0 ? (successful[0].lane as UserPick) : 'neither';
}

interface Observation {
  laneSuccesses: number;
  hasReview: boolean;
  /** null when the scenario mode has no synthesis concept */
  hasSynthesis: boolean | null;
  /** cascade: the winning chain level, null when the chain was exhausted, undefined otherwise */
  winnerLevel?: number | null;
  /** cascade: how many levels ran before the chain stopped */
  attemptCount?: number;
}

export function checkExpectations(scenario: EvalScenario, obs: Observation): string[] {
  const failures: string[] = [];
  const { minLaneSuccess, maxLaneSuccess, expectReview, expectSynthesis, expectWinnerLevel, expectAttempts } =
    scenario.expect;
  if (minLaneSuccess !== undefined && obs.laneSuccesses < minLaneSuccess) {
    failures.push(`expected >= ${minLaneSuccess} successful lane(s), got ${obs.laneSuccesses}`);
  }
  if (maxLaneSuccess !== undefined && obs.laneSuccesses > maxLaneSuccess) {
    failures.push(`expected <= ${maxLaneSuccess} successful lane(s), got ${obs.laneSuccesses}`);
  }
  if (expectReview === true && !obs.hasReview) {
    failures.push('expected a cross-review verdict, got none');
  }
  if (expectReview === false && obs.hasReview) {
    failures.push('expected no cross-review, got one');
  }
  if (expectSynthesis === true && obs.hasSynthesis !== true) {
    failures.push('expected a synthesis, got none');
  }
  if (expectSynthesis === false && obs.hasSynthesis === true) {
    failures.push('expected no synthesis, got one');
  }
  if (expectWinnerLevel !== undefined && obs.winnerLevel !== expectWinnerLevel) {
    failures.push(
      `expected a winner at level ${expectWinnerLevel}, got ${obs.winnerLevel == null ? 'no winner' : `level ${obs.winnerLevel}`}`
    );
  }
  if (expectAttempts !== undefined && obs.attemptCount !== expectAttempts) {
    failures.push(`expected ${expectAttempts} attempt(s), got ${obs.attemptCount ?? 'unknown'}`);
  }
  return failures;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function seedRepo(dir: string, seedFiles?: Record<string, string>): Promise<void> {
  await git(dir, ['init']);
  const files = seedFiles && Object.keys(seedFiles).length > 0 ? seedFiles : { 'README.md': 'seed\n' };
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(path.join(dir, name), content, 'utf8')));
  await git(dir, ['add', '-A']);
  await git(dir, ['-c', 'user.email=modes-eval@local', '-c', 'user.name=modes-eval', 'commit', '-m', 'seed']);
}

/** commit subjects on the current branch, newest first */
async function headSubjects(repoPath: string): Promise<string[]> {
  const out = await git(repoPath, ['log', '--format=%s']);
  return out.split('\n').filter((line) => line !== '');
}

async function collectEventStats(eventsFile: string): Promise<Pick<ScenarioResult, 'eventCount' | 'stageLatencies'>> {
  const events = await readEvents(eventsFile);
  const stageLatencies: Record<string, number> = {};
  for (const event of events) {
    stageLatencies[`${event.role}:${event.lane}`] = event.latency;
  }
  return { eventCount: events.length, stageLatencies };
}

async function runCompeteScenario(scenario: EvalScenario, deps: EvalDeps, failures: string[]): Promise<ScenarioResult> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), `modes-eval-${scenario.id}-`));
  await seedRepo(workDir, scenario.seedFiles);

  const result = await deps.runTask({
    repoPath: workDir,
    prompt: scenario.prompt,
    lanes: scenario.lanes ?? EVAL_LANES,
    reviewerCli: 'kimi',
    taskType: `eval:${scenario.id}`,
  });

  if (result.state !== 'awaiting_user_pick') {
    failures.push(`expected state awaiting_user_pick, got ${result.state}`);
  }
  failures.push(
    ...checkExpectations(scenario, {
      laneSuccesses: result.lanes.filter((l) => l.outcome === 'success').length,
      hasReview: result.review !== null,
      hasSynthesis: null,
    })
  );

  // The harness plays the human gate: pick, record, merge, verify.
  const pick = decidePick(result);
  await deps.recordPick(result.eventsFile, {
    taskId: result.taskId,
    pick,
    reviewVerdict: result.review?.verdict ?? null,
  });

  if (pick === 'neither') {
    const subjects = await headSubjects(workDir);
    if (subjects.some((s) => s.startsWith('user pick:'))) {
      failures.push('picked "neither" but a merge commit landed on the current branch');
    }
  } else {
    const lane = result.lanes.find((l) => l.lane === pick);
    if (!lane) {
      failures.push(`picked lane ${pick} but it is missing from the results`);
    } else {
      try {
        await deps.mergeLane({
          repoPath: workDir,
          worktreePath: lane.worktreePath,
          branch: lane.branch,
          taskId: result.taskId,
          pick,
        });
      } catch (err) {
        failures.push(`mergeLane failed: ${String(err)}`);
      }
      const subjects = await headSubjects(workDir);
      // Merging an empty-diff lane is a git no-op ("Already up to date" — no lane commit
      // exists, so --no-ff has nothing to wrap). Assert the branch stayed clean instead of
      // demanding a merge commit git will never create.
      if (lane.diff.trim() === '') {
        if (subjects.some((s) => s.startsWith('user pick:'))) {
          failures.push(`lane ${pick} had an empty diff yet a merge commit landed on the current branch`);
        }
      } else if (!subjects.includes(`user pick: lane ${pick} (${result.taskId})`)) {
        failures.push(`merge commit for lane ${pick} not found on the current branch`);
      }
    }
  }

  const stats = await collectEventStats(result.eventsFile);
  return {
    scenarioId: scenario.id,
    pass: failures.length === 0,
    failures,
    durationMs: 0, // filled in by runScenario
    eventsFile: result.eventsFile,
    workDir,
    pick,
    laneOutcomes: Object.fromEntries(result.lanes.map((l) => [l.lane, l.outcome])),
    ...stats,
  };
}

async function runBrainstormScenario(
  scenario: EvalScenario,
  deps: EvalDeps,
  failures: string[]
): Promise<ScenarioResult> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), `modes-eval-${scenario.id}-`));

  const result = await deps.runBrainstorm({
    prompt: scenario.prompt,
    lanes: EVAL_LANES,
    synthesizerCli: 'kimi',
    workDir,
    taskType: `eval:${scenario.id}`,
  });

  failures.push(
    ...checkExpectations(scenario, {
      laneSuccesses: result.lanes.filter((l) => l.outcome === 'success').length,
      hasReview: false,
      hasSynthesis: result.synthesis !== null,
    })
  );

  const stats = await collectEventStats(result.eventsFile);
  return {
    scenarioId: scenario.id,
    pass: failures.length === 0,
    failures,
    durationMs: 0, // filled in by runScenario
    eventsFile: result.eventsFile,
    workDir,
    laneOutcomes: Object.fromEntries(result.lanes.map((l) => [l.lane, l.outcome])),
    ...stats,
  };
}

async function runCascadeScenario(scenario: EvalScenario, deps: EvalDeps, failures: string[]): Promise<ScenarioResult> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), `modes-eval-${scenario.id}-`));
  await seedRepo(workDir, scenario.seedFiles);

  const result = await deps.runCascade({
    repoPath: workDir,
    prompt: scenario.prompt,
    chain: scenario.chain ?? EVAL_CHAIN,
    taskType: `eval:${scenario.id}`,
  });

  failures.push(
    ...checkExpectations(scenario, {
      laneSuccesses: result.attempts.filter((a) => a.outcome === 'success').length,
      hasReview: false,
      hasSynthesis: null,
      winnerLevel: result.winner?.level ?? null,
      attemptCount: result.attempts.length,
    })
  );

  // The harness plays the human gate: a winner is "merge it", no winner is "neither".
  const pick: UserPick = result.winner ? `cascade-${result.winner.level}` : 'neither';
  await deps.recordPick(result.eventsFile, { taskId: result.taskId, pick, reviewVerdict: null });

  if (result.winner) {
    try {
      await deps.mergeLane({
        repoPath: workDir,
        worktreePath: result.winner.worktreePath,
        branch: result.winner.branch,
        taskId: result.taskId,
        pick,
      });
    } catch (err) {
      failures.push(`mergeLane failed: ${String(err)}`);
    }
    // A cascade winner has a non-empty diff by construction, so the merge commit
    // must exist — no empty-diff no-op case like compete has.
    const subjects = await headSubjects(workDir);
    if (!subjects.includes(`user pick: lane ${pick} (${result.taskId})`)) {
      failures.push(`merge commit for ${pick} not found on the current branch`);
    }
  } else {
    const subjects = await headSubjects(workDir);
    if (subjects.some((s) => s.startsWith('user pick:'))) {
      failures.push('chain exhausted (no winner) but a merge commit landed on the current branch');
    }
  }

  const stats = await collectEventStats(result.eventsFile);
  return {
    scenarioId: scenario.id,
    pass: failures.length === 0,
    failures,
    durationMs: 0, // filled in by runScenario
    eventsFile: result.eventsFile,
    workDir,
    pick,
    laneOutcomes: Object.fromEntries(result.attempts.map((a) => [`cascade-${a.level}`, a.outcome])),
    ...stats,
  };
}

async function runScenario(scenario: EvalScenario, deps: EvalDeps): Promise<ScenarioResult> {
  const started = Date.now();
  const failures: string[] = [];
  try {
    const result =
      scenario.mode === 'compete'
        ? await runCompeteScenario(scenario, deps, failures)
        : scenario.mode === 'brainstorm'
          ? await runBrainstormScenario(scenario, deps, failures)
          : await runCascadeScenario(scenario, deps, failures);
    result.durationMs = Date.now() - started;
    result.pass = result.failures.length === 0;
    return result;
  } catch (err) {
    // A scenario that throws (engine crash, git failure, …) fails but never stops the suite.
    return {
      scenarioId: scenario.id,
      pass: false,
      failures: [...failures, `scenario threw: ${String(err)}`],
      durationMs: Date.now() - started,
      eventsFile: null,
      workDir: '',
    };
  }
}

/** Scenarios run sequentially: real CLIs share the user's accounts and rate limits. */
export async function runEval(scenarios: EvalScenario[], deps: EvalDeps): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    // oxlint-disable-next-line no-await-in-loop -- sequential by design: real CLIs share rate limits
    results.push(await runScenario(scenario, deps));
  }
  return results;
}
