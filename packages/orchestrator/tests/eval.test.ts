/**
 * Eval harness unit tests — runEval with injected fake deps (no real CLIs).
 * Covers: expectation checking (min/max lane success, review, synthesis), the
 * auto-pick policy (follow recommendation / first successful lane / neither),
 * merge verification on the temp git repo, and suite resilience (a throwing
 * scenario fails without stopping the rest). The temp git repos are real —
 * only the CLI runners are faked.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkExpectations, decidePick, runEval, type EvalDeps, type ScenarioResult } from '../src/eval/runEval';
import { EVAL_SCENARIOS, selectScenarios, type EvalScenario } from '../src/eval/scenarios';
import { recordUserPick } from '../src/gate/recordUserPick';
import type { CascadeResult } from '../src/patterns/cascade';
import type { RoundtableResult } from '../src/patterns/roundtable';
import type { RunTaskResult } from '../src/run/runTask';
import { EVENT_LOG_SCHEMA_VERSION, type EventLogRole } from '../src/schema/eventLog';
import { appendEvent, readEvents } from '../src/store/eventLogStore';

const execFileAsync = promisify(execFile);

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

function trackTempDir(result: ScenarioResult[]): void {
  for (const r of result) {
    if (r.workDir) tempDirs.push(r.workDir);
  }
}

async function appendFakeEvent(eventsFile: string, taskId: string, lane: string, role: EventLogRole, outcome: string) {
  await mkdir(path.dirname(eventsFile), { recursive: true });
  await appendEvent(eventsFile, {
    schema_version: EVENT_LOG_SCHEMA_VERSION,
    task_id: taskId,
    lane,
    attempt_id: `${taskId}-${lane}-1`,
    task_type: 'eval:fake',
    model: 'fake',
    provider: 'fake',
    role,
    outcome: outcome as 'success' | 'failed',
    score: null,
    cost: null,
    latency: 1,
    verifier: 'fake',
    ts: new Date().toISOString(),
  });
}

interface FakeTaskConfig {
  outcomes: Record<string, 'success' | 'failed'>;
  review?: { verdict: 'agreed' | 'disagreed' | 'failed'; pick: string | null; rationale: string } | null;
  /** when true, successful lanes report an empty diff (lane ran but changed nothing) */
  emptyDiffs?: boolean;
}

/** fake runTask: records worker/reviewer events into a real JSONL log, returns scripted lanes */
function makeFakeRunTask(config: FakeTaskConfig): EvalDeps['runTask'] {
  return async (options) => {
    const taskId = 'task-fake';
    const eventsFile = path.join(options.repoPath, '.modes', 'events.jsonl');
    const lanes: RunTaskResult['lanes'] = [];
    for (const [lane, outcome] of Object.entries(config.outcomes)) {
      // oxlint-disable-next-line no-await-in-loop -- append-only log: writes must stay ordered
      await appendFakeEvent(eventsFile, taskId, lane, 'worker', outcome);
      lanes.push({
        lane,
        outcome,
        summary: `${lane} summary`,
        diff: outcome === 'success' && !config.emptyDiffs ? `diff from ${lane}` : '',
        worktreePath: path.join(options.repoPath, '.modes-worktrees', `${taskId}-${lane}`),
        branch: `modes/${taskId}-${lane}`,
      });
    }
    const review = config.review === undefined ? { verdict: 'agreed' as const, pick: null, rationale: 'r' } : config.review;
    if (review) {
      await appendFakeEvent(eventsFile, taskId, 'review', 'reviewer', 'success');
    }
    return { taskId, state: 'awaiting_user_pick', lanes, review, eventsFile };
  };
}

function makeFakeRunBrainstorm(config: {
  outcomes: Record<string, 'success' | 'failed'>;
  synthesis: string | null;
}): EvalDeps['runBrainstorm'] {
  return async (options) => {
    const taskId = 'task-fake';
    const eventsFile = path.join(options.workDir, '.modes', 'events.jsonl');
    const lanes = [];
    for (const [lane, outcome] of Object.entries(config.outcomes)) {
      // oxlint-disable-next-line no-await-in-loop -- append-only log: writes must stay ordered
      await appendFakeEvent(eventsFile, taskId, lane, 'worker', outcome);
      lanes.push({ lane, outcome, answer: `${lane} answer` });
    }
    if (config.synthesis !== null) {
      await appendFakeEvent(eventsFile, taskId, 'synthesis', 'synthesizer', 'success');
    }
    return { taskId, lanes, synthesis: config.synthesis, eventsFile };
  };
}

/** fake runCascade: records one worker event per attempt into a real JSONL log, returns a scripted winner */
function makeFakeRunCascade(config: {
  attempts: { cli: string; outcome: 'success' | 'failed' }[];
  winnerLevel: number | null;
}): EvalDeps['runCascade'] {
  return async (options) => {
    const taskId = 'task-fake';
    const eventsFile = path.join(options.repoPath, '.modes', 'events.jsonl');
    const attempts: CascadeResult['attempts'] = [];
    for (const [i, attempt] of config.attempts.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- append-only log: writes must stay ordered
      await appendFakeEvent(eventsFile, taskId, 'cascade', 'worker', attempt.outcome);
      attempts.push({ level: i + 1, cli: attempt.cli, outcome: attempt.outcome, latency: 1 });
    }
    const winner: CascadeResult['winner'] =
      config.winnerLevel === null
        ? null
        : {
            level: config.winnerLevel,
            cli: config.attempts[config.winnerLevel - 1].cli,
            summary: 'winner summary',
            diff: 'diff from winner',
            worktreePath: path.join(options.repoPath, '.modes-worktrees', `${taskId}-cascade-${config.winnerLevel}`),
            branch: `modes/${taskId}-cascade-${config.winnerLevel}`,
          };
    return { taskId, winner, attempts, eventsFile };
  };
}

/** fake runRoundtable: records worker/reviewer/synthesizer events into a real JSONL log, returns scripted rounds */
function makeFakeRunRoundtable(config: {
  consensus: boolean;
  synthesis: string | null;
}): EvalDeps['runRoundtable'] {
  return async (options) => {
    const taskId = 'task-fake';
    const eventsFile = path.join(options.workDir, '.modes', 'events.jsonl');
    const lanes: RoundtableResult['rounds'][number]['lanes'] = [];
    for (const cli of options.clis) {
      // oxlint-disable-next-line no-await-in-loop -- append-only log: writes must stay ordered
      await appendFakeEvent(eventsFile, taskId, cli, 'worker', 'success');
      lanes.push({ cli, outcome: 'success', answer: `${cli} answer` });
    }
    const rounds: RoundtableResult['rounds'] = [{ round: 1, lanes }];
    if (!config.consensus) {
      await appendFakeEvent(eventsFile, taskId, 'consensus', 'reviewer', 'success');
      const revised = lanes.map((l) => Object.assign({}, l, { answer: `${l.cli} revised` }));
      for (const l of revised) {
        // oxlint-disable-next-line no-await-in-loop -- append-only log: writes must stay ordered
        await appendFakeEvent(eventsFile, taskId, l.cli, 'worker', 'success');
      }
      rounds.push({ round: 2, lanes: revised });
    } else {
      await appendFakeEvent(eventsFile, taskId, 'consensus', 'reviewer', 'success');
    }
    if (config.synthesis !== null) {
      await appendFakeEvent(eventsFile, taskId, 'synthesis', 'synthesizer', 'success');
    }
    return { taskId, rounds, consensus: config.consensus, synthesis: config.synthesis, eventsFile };
  };
}

/** fake mergeLane: simulates the real merge by landing its exact commit subject */
const fakeMergeLane: EvalDeps['mergeLane'] = async ({ repoPath, taskId, pick }) => {
  await execFileAsync(
    'git',
    ['-c', 'user.email=t@modes', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', `user pick: lane ${pick} (${taskId})`],
    { cwd: repoPath }
  );
};

function makeDeps(overrides: Partial<EvalDeps> = {}): EvalDeps {
  return {
    runTask: makeFakeRunTask({ outcomes: { A: 'success', B: 'success' } }),
    runBrainstorm: makeFakeRunBrainstorm({ outcomes: { A: 'success', B: 'success' }, synthesis: 'combined' }),
    runCascade: makeFakeRunCascade({ attempts: [{ cli: 'cheap', outcome: 'success' }], winnerLevel: 1 }),
    runRoundtable: makeFakeRunRoundtable({ consensus: false, synthesis: 'combined' }),
    recordPick: recordUserPick,
    mergeLane: fakeMergeLane,
    ...overrides,
  };
}

const COMPETE: EvalScenario = {
  id: 'fake-compete',
  mode: 'compete',
  tier: 'core',
  prompt: 'do something',
  expect: { minLaneSuccess: 2, expectReview: true },
};

const BRAINSTORM: EvalScenario = {
  id: 'fake-brainstorm',
  mode: 'brainstorm',
  tier: 'core',
  prompt: 'think about something',
  expect: { minLaneSuccess: 2, expectSynthesis: true },
};

const CASCADE: EvalScenario = {
  id: 'fake-cascade',
  mode: 'cascade',
  tier: 'core',
  prompt: 'do something cheap first',
  chain: [{ cli: 'cheap' }, { cli: 'strong' }],
  expect: { expectWinnerLevel: 1, expectAttempts: 1 },
};

const AUTO: EvalScenario = {
  id: 'fake-auto',
  mode: 'auto',
  tier: 'core',
  prompt: 'Create a file util.js with a clamp function',
  expect: { expectMode: 'cascade', expectWinnerLevel: 1, expectAttempts: 1 },
};

const ROUNDTABLE: EvalScenario = {
  id: 'fake-roundtable',
  mode: 'roundtable',
  tier: 'core',
  prompt: 'debate something',
  expect: { minLaneSuccess: 2, minRounds: 1, expectSynthesis: true, expectRoles: ['worker', 'reviewer', 'synthesizer'] },
};

describe('decidePick', () => {
  const base: RunTaskResult = {
    taskId: 't',
    state: 'awaiting_user_pick',
    lanes: [
      { lane: 'A', outcome: 'success', summary: '', diff: '', worktreePath: '', branch: '' },
      { lane: 'B', outcome: 'success', summary: '', diff: '', worktreePath: '', branch: '' },
    ],
    review: { verdict: 'agreed', pick: 'B', rationale: '' },
    eventsFile: '',
  };

  it('follows the review recommendation when it names a successful lane', () => {
    expect(decidePick(base)).toBe('B');
  });

  it('ignores a recommendation for a failed lane and takes the first success', () => {
    const result = {
      ...base,
      lanes: base.lanes.map((l) => (l.lane === 'B' ? { ...l, outcome: 'failed' as const } : l)),
    };
    expect(decidePick(result)).toBe('A');
  });

  it('treats tie / null recommendations as no recommendation', () => {
    expect(decidePick({ ...base, review: { verdict: 'agreed', pick: 'tie', rationale: '' } })).toBe('A');
    expect(decidePick({ ...base, review: { verdict: 'agreed', pick: null, rationale: '' } })).toBe('A');
  });

  it('picks neither when every lane failed', () => {
    const result = {
      ...base,
      lanes: base.lanes.map((l) => Object.assign({}, l, { outcome: 'failed' as const })),
      review: null,
    };
    expect(decidePick(result)).toBe('neither');
  });

  it('N lanes: follows a recommendation for any lane letter in this run', () => {
    const result: RunTaskResult = {
      ...base,
      lanes: [...base.lanes, { lane: 'C', outcome: 'success', summary: '', diff: '', worktreePath: '', branch: '' }],
      review: { verdict: 'agreed', pick: 'C', rationale: '' },
    };
    expect(decidePick(result)).toBe('C');
  });

  it('N lanes: a recommendation for a lane not in this run is not followed', () => {
    const result = { ...base, review: { verdict: 'agreed' as const, pick: 'C', rationale: '' } };
    expect(decidePick(result)).toBe('A');
  });
});

describe('checkExpectations', () => {
  const obs = { laneSuccesses: 2, hasReview: true, hasSynthesis: null };

  it('passes when all bounds are satisfied', () => {
    expect(checkExpectations(COMPETE, obs)).toEqual([]);
  });

  it('fails below minLaneSuccess and above maxLaneSuccess', () => {
    const scenario = { ...COMPETE, expect: { minLaneSuccess: 2, maxLaneSuccess: 1 } };
    const failures = checkExpectations(scenario, obs);
    expect(failures.some((f) => f.includes('<= 1'))).toBe(true);
    expect(checkExpectations(scenario, { ...obs, laneSuccesses: 1 })[0]).toContain('>= 2');
  });

  it('checks review and synthesis presence both ways', () => {
    expect(checkExpectations(COMPETE, { ...obs, hasReview: false })[0]).toContain('cross-review');
    expect(checkExpectations(BRAINSTORM, { laneSuccesses: 2, hasReview: false, hasSynthesis: false })[0]).toContain(
      'synthesis'
    );
    const noReview = { ...COMPETE, expect: { expectReview: false } };
    expect(checkExpectations(noReview, obs)[0]).toContain('no cross-review');
  });
});

describe('runEval', () => {
  it('compete happy path: follows recommendation, records the pick, verifies the merge', async () => {
    const results = await runEval(
      [COMPETE],
      makeDeps({ runTask: makeFakeRunTask({ outcomes: { A: 'success', B: 'success' }, review: { verdict: 'agreed', pick: 'B', rationale: 'r' } }) })
    );
    trackTempDir(results);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.pass).toBe(true);
    expect(r.pick).toBe('B');
    expect(r.eventCount).toBe(4); // 2 workers + reviewer + gate
    expect(r.stageLatencies).toHaveProperty('gate:gate');

    const { stdout } = await execFileAsync('git', ['log', '--format=%s'], { cwd: r.workDir });
    expect(stdout).toContain('user pick: lane B (task-fake)');

    const events = await readEvents(r.eventsFile!);
    expect(events.find((e) => e.role === 'gate')?.verifier).toBe('human:B');
  });

  it('no usable recommendation falls back to the first successful lane', async () => {
    const results = await runEval(
      [COMPETE],
      makeDeps({ runTask: makeFakeRunTask({ outcomes: { A: 'failed', B: 'success' }, review: { verdict: 'disagreed', pick: 'A', rationale: 'r' } }) })
    );
    trackTempDir(results);
    expect(results[0].pick).toBe('B');
  });

  it('all lanes failed → pick neither and no merge commit lands', async () => {
    const scenario: EvalScenario = { ...COMPETE, expect: { minLaneSuccess: 0, maxLaneSuccess: 0 } };
    const results = await runEval(
      [scenario],
      makeDeps({ runTask: makeFakeRunTask({ outcomes: { A: 'failed', B: 'failed' }, review: null }) })
    );
    trackTempDir(results);

    expect(results[0].pass).toBe(true);
    expect(results[0].pick).toBe('neither');
    const { stdout } = await execFileAsync('git', ['log', '--format=%s'], { cwd: results[0].workDir });
    expect(stdout.trim()).toBe('seed');
  });

  it('expectation violations fail the scenario with readable reasons', async () => {
    const results = await runEval(
      [COMPETE],
      makeDeps({ runTask: makeFakeRunTask({ outcomes: { A: 'success', B: 'failed' } }) })
    );
    trackTempDir(results);
    expect(results[0].pass).toBe(false);
    expect(results[0].failures.some((f) => f.includes('>= 2 successful lane(s)'))).toBe(true);
  });

  it('a merge that lands no commit fails verification', async () => {
    const results = await runEval([COMPETE], makeDeps({ mergeLane: async () => {} }));
    trackTempDir(results);
    expect(results[0].pass).toBe(false);
    expect(results[0].failures.some((f) => f.includes('merge commit for lane A not found'))).toBe(true);
  });

  it('picking an empty-diff lane accepts the git no-op merge (no commit required)', async () => {
    const results = await runEval(
      [COMPETE],
      makeDeps({
        runTask: makeFakeRunTask({ outcomes: { A: 'success', B: 'success' }, emptyDiffs: true }),
        mergeLane: async () => {}, // real git: "Already up to date", nothing to commit
      })
    );
    trackTempDir(results);
    expect(results[0].pass).toBe(true);
    const { stdout } = await execFileAsync('git', ['log', '--format=%s'], { cwd: results[0].workDir });
    expect(stdout.trim()).toBe('seed');
  });

  it('brainstorm: synthesis expectation is checked', async () => {
    const ok = await runEval([BRAINSTORM], makeDeps());
    trackTempDir(ok);
    expect(ok[0].pass).toBe(true);
    expect(ok[0].eventCount).toBe(3); // 2 workers + synthesizer

    const missing = await runEval(
      [BRAINSTORM],
      makeDeps({ runBrainstorm: makeFakeRunBrainstorm({ outcomes: { A: 'success', B: 'success' }, synthesis: null }) })
    );
    trackTempDir(missing);
    expect(missing[0].pass).toBe(false);
    expect(missing[0].failures[0]).toContain('synthesis');
  });

  it('cascade happy path: level-1 winner is auto-picked, merged, and verified', async () => {
    const results = await runEval([CASCADE], makeDeps());
    trackTempDir(results);

    const r = results[0];
    expect(r.pass).toBe(true);
    expect(r.pick).toBe('cascade-1');
    expect(r.eventCount).toBe(2); // 1 worker + gate
    expect(r.laneOutcomes).toEqual({ 'cascade-1': 'success' });

    const { stdout } = await execFileAsync('git', ['log', '--format=%s'], { cwd: r.workDir });
    expect(stdout).toContain('user pick: lane cascade-1 (task-fake)');
    const events = await readEvents(r.eventsFile!);
    expect(events.find((e) => e.role === 'gate')?.verifier).toBe('human:cascade-1');
  });

  it('cascade: expectation violations on winner level and attempt count fail readably', async () => {
    const results = await runEval(
      [CASCADE],
      makeDeps({
        runCascade: makeFakeRunCascade({
          attempts: [
            { cli: 'cheap', outcome: 'failed' },
            { cli: 'strong', outcome: 'success' },
          ],
          winnerLevel: 2,
        }),
      })
    );
    trackTempDir(results);
    expect(results[0].pass).toBe(false);
    expect(results[0].failures.some((f) => f.includes('winner at level 1'))).toBe(true);
    expect(results[0].failures.some((f) => f.includes('1 attempt(s)'))).toBe(true);
  });

  it('cascade chain exhausted: pick neither, no merge commit lands', async () => {
    const scenario: EvalScenario = { ...CASCADE, expect: { expectAttempts: 2 } };
    const results = await runEval(
      [scenario],
      makeDeps({
        runCascade: makeFakeRunCascade({
          attempts: [
            { cli: 'cheap', outcome: 'failed' },
            { cli: 'strong', outcome: 'failed' },
          ],
          winnerLevel: null,
        }),
      })
    );
    trackTempDir(results);

    expect(results[0].pass).toBe(true);
    expect(results[0].pick).toBe('neither');
    const { stdout } = await execFileAsync('git', ['log', '--format=%s'], { cwd: results[0].workDir });
    expect(stdout.trim()).toBe('seed');
  });

  it('scenario lanes override: the declared lanes reach runTask instead of EVAL_LANES', async () => {
    const threeLanes = [
      { lane: 'A', cli: 'kimi' },
      { lane: 'B', cli: 'qwen' },
      { lane: 'C', cli: 'kimi' },
    ];
    const scenario: EvalScenario = { ...COMPETE, lanes: threeLanes, expect: { minLaneSuccess: 2, expectReview: true } };
    let seenLanes: unknown;
    const results = await runEval(
      [scenario],
      makeDeps({
        runTask: async (options) => {
          seenLanes = options.lanes;
          return makeFakeRunTask({ outcomes: { A: 'success', B: 'success', C: 'success' } })(options);
        },
      })
    );
    trackTempDir(results);

    expect(seenLanes).toEqual(threeLanes);
    expect(results[0].pass).toBe(true);
  });

  it('a throwing scenario fails without stopping later scenarios', async () => {
    const results = await runEval(
      [COMPETE, BRAINSTORM],
      makeDeps({
        runTask: async () => {
          throw new Error('engine exploded');
        },
      })
    );
    trackTempDir(results);
    expect(results).toHaveLength(2);
    expect(results[0].pass).toBe(false);
    expect(results[0].failures[0]).toContain('engine exploded');
    expect(results[1].pass).toBe(true);
  });

  it('auto: an executional prompt is routed to cascade and gated like a cascade run', async () => {
    const results = await runEval([AUTO], makeDeps());
    trackTempDir(results);

    const r = results[0];
    expect(r.pass).toBe(true);
    expect(r.resolvedMode).toBe('cascade');
    expect(r.pick).toBe('cascade-1');
    expect(r.eventCount).toBe(2); // 1 worker + gate

    const { stdout } = await execFileAsync('git', ['log', '--format=%s'], { cwd: r.workDir });
    expect(stdout).toContain('user pick: lane cascade-1 (task-fake)');
  });

  it('auto: an expectMode mismatch fails with a readable reason', async () => {
    const scenario: EvalScenario = { ...AUTO, expect: { expectMode: 'brainstorm' } };
    const results = await runEval([scenario], makeDeps());
    trackTempDir(results);
    expect(results[0].pass).toBe(false);
    expect(results[0].failures.some((f) => f.includes('brainstorm') && f.includes('cascade'))).toBe(true);
  });

  it('roundtable happy path: rounds, synthesis, and worker/reviewer/synthesizer roles', async () => {
    const results = await runEval([ROUNDTABLE], makeDeps());
    trackTempDir(results);

    const r = results[0];
    expect(r.pass).toBe(true);
    expect(r.eventCount).toBe(6); // 2 workers r1 + reviewer + 2 workers r2 + synthesizer
    expect(r.laneOutcomes).toEqual({ 'r1:kimi': 'success', 'r1:qwen': 'success', 'r2:kimi': 'success', 'r2:qwen': 'success' });
  });

  it('roundtable: missing synthesis or missing roles fail readably', async () => {
    const noSynthesis = await runEval(
      [ROUNDTABLE],
      makeDeps({ runRoundtable: makeFakeRunRoundtable({ consensus: true, synthesis: null }) })
    );
    trackTempDir(noSynthesis);
    expect(noSynthesis[0].pass).toBe(false);
    expect(noSynthesis[0].failures.some((f) => f.includes('synthesis'))).toBe(true);
    expect(noSynthesis[0].failures.some((f) => f.includes('"synthesizer" role'))).toBe(true);
  });
});

describe('checkExpectations: roundtable (minRounds / expectRoles)', () => {
  it('passes when rounds and roles are present', () => {
    const obs = {
      laneSuccesses: 2,
      hasReview: true,
      hasSynthesis: true,
      roundCount: 2,
      roles: ['worker', 'reviewer', 'synthesizer'],
    };
    expect(checkExpectations(ROUNDTABLE, obs)).toEqual([]);
  });

  it('fails below minRounds and on a missing role', () => {
    const obs = { laneSuccesses: 2, hasReview: false, hasSynthesis: true, roundCount: 0, roles: ['worker'] };
    const failures = checkExpectations(ROUNDTABLE, obs);
    expect(failures.some((f) => f.includes('>= 1 round(s)'))).toBe(true);
    expect(failures.some((f) => f.includes('"reviewer" role'))).toBe(true);
    expect(failures.some((f) => f.includes('"synthesizer" role'))).toBe(true);
  });
});

describe('checkExpectations: expectWinner', () => {
  // A cascade scenario that only demands proper termination: a winner at some level,
  // or the chain fully exhausted. Never asserts which level won.
  const scenario: EvalScenario = {
    ...CASCADE,
    expect: { expectWinner: true },
  };

  it('passes with a winner at any level', () => {
    const obs = { laneSuccesses: 1, hasReview: false, hasSynthesis: null, winnerLevel: 1, attemptCount: 1 };
    expect(checkExpectations(scenario, obs)).toEqual([]);
    expect(checkExpectations(scenario, { ...obs, winnerLevel: 2, attemptCount: 2 })).toEqual([]);
  });

  it('passes when the chain is fully exhausted without a winner', () => {
    const obs = { laneSuccesses: 0, hasReview: false, hasSynthesis: null, winnerLevel: null, attemptCount: 2 };
    expect(checkExpectations(scenario, obs)).toEqual([]);
  });

  it('fails when the chain stops early with no winner', () => {
    const obs = { laneSuccesses: 0, hasReview: false, hasSynthesis: null, winnerLevel: null, attemptCount: 1 };
    const failures = checkExpectations(scenario, obs);
    expect(failures.some((f) => f.includes('winner') && f.includes('exhaust'))).toBe(true);
  });

  it('expectWinner false fails when a winner exists', () => {
    const noWinner = { ...CASCADE, expect: { expectWinner: false } };
    const obs = { laneSuccesses: 1, hasReview: false, hasSynthesis: null, winnerLevel: 1, attemptCount: 1 };
    expect(checkExpectations(noWinner, obs).some((f) => f.includes('no winner'))).toBe(true);
    expect(checkExpectations(noWinner, { ...obs, winnerLevel: null, attemptCount: 2 })).toEqual([]);
  });
});

describe('selectScenarios (tier filtering)', () => {
  const extendedId = EVAL_SCENARIOS.find((s) => s.tier === 'extended')!.id;

  it('defaults to core scenarios only', () => {
    const selected = selectScenarios(EVAL_SCENARIOS);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((s) => s.tier === 'core')).toBe(true);
  });

  it('--all returns every scenario', () => {
    expect(selectScenarios(EVAL_SCENARIOS, { all: true })).toHaveLength(EVAL_SCENARIOS.length);
  });

  it('explicit ids ignore tier', () => {
    const selected = selectScenarios(EVAL_SCENARIOS, { ids: [extendedId] });
    expect(selected.map((s) => s.id)).toEqual([extendedId]);
  });

  it('unknown ids select nothing', () => {
    expect(selectScenarios(EVAL_SCENARIOS, { ids: ['nope'] })).toEqual([]);
  });
});

describe('EVAL_SCENARIOS definitions', () => {
  it('ids are unique', () => {
    const ids = EVAL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every scenario has a valid tier, mode, non-empty prompt and at least one expectation', () => {
    for (const s of EVAL_SCENARIOS) {
      expect(['core', 'extended']).toContain(s.tier);
      expect(['compete', 'brainstorm', 'cascade', 'auto', 'roundtable']).toContain(s.mode);
      expect(s.prompt.trim().length).toBeGreaterThan(0);
      expect(Object.keys(s.expect).length).toBeGreaterThan(0);
    }
  });

  it('the original seven scenarios are all core; the suite has >= 21 scenarios with >= 14 extended', () => {
    const original = [
      'simple-create',
      'modify-existing',
      'impossible-task',
      'review-disagree',
      'three-lane',
      'brainstorm-basic',
      'cascade-basic',
    ];
    for (const id of original) {
      expect(EVAL_SCENARIOS.find((s) => s.id === id)?.tier).toBe('core');
    }
    expect(EVAL_SCENARIOS.length).toBeGreaterThanOrEqual(21);
    expect(EVAL_SCENARIOS.filter((s) => s.tier === 'extended').length).toBeGreaterThanOrEqual(14);
  });
});

describe('runEval event retention', () => {
  it('copies the scenario event log into eventsDir and records eventsSnapshot', async () => {
    const eventsDir = await mkdtemp(path.join(os.tmpdir(), 'modes-eval-snapshots-'));
    tempDirs.push(eventsDir);
    const results = await runEval([COMPETE], makeDeps(), { eventsDir });
    trackTempDir(results);

    const snapshot = results[0].eventsSnapshot;
    expect(snapshot).toBeTruthy();
    expect(path.dirname(snapshot!)).toBe(eventsDir);
    expect(path.basename(snapshot!)).toMatch(/^fake-compete-.+-task-fake\.jsonl$/);
    // the snapshot is a faithful copy of the (about-to-evaporate) temp-repo log
    expect(await readEvents(snapshot!)).toEqual(await readEvents(results[0].eventsFile!));
  });

  it('a failed copy only warns — the scenario result still stands', async () => {
    const blockerDir = await mkdtemp(path.join(os.tmpdir(), 'modes-eval-blocked-'));
    tempDirs.push(blockerDir);
    const blocker = path.join(blockerDir, 'blocker');
    await writeFile(blocker, 'x', 'utf8'); // a file where mkdir needs a directory
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const results = await runEval([COMPETE], makeDeps(), { eventsDir: path.join(blocker, 'sub') });
      trackTempDir(results);
      expect(results[0].pass).toBe(true);
      expect(results[0].eventsSnapshot).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('without eventsDir nothing is snapshotted', async () => {
    const results = await runEval([COMPETE], makeDeps());
    trackTempDir(results);
    expect(results[0].eventsSnapshot).toBeUndefined();
  });

  it('records the reviewer quality pick on compete results', async () => {
    const results = await runEval(
      [COMPETE],
      makeDeps({
        runTask: makeFakeRunTask({
          outcomes: { A: 'success', B: 'success' },
          review: { verdict: 'agreed', pick: 'B', rationale: 'r' },
        }),
      })
    );
    trackTempDir(results);
    expect(results[0].reviewPick).toBe('B');
  });

  it('reviewPick is null when the reviewer gave no usable pick', async () => {
    const results = await runEval([COMPETE], makeDeps());
    trackTempDir(results);
    expect(results[0].reviewPick).toBeNull();
  });
});
