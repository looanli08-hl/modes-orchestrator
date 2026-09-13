/**
 * Eval harness unit tests — runEval with injected fake deps (no real CLIs).
 * Covers: expectation checking (min/max lane success, review, synthesis), the
 * auto-pick policy (follow recommendation / first successful lane / neither),
 * merge verification on the temp git repo, and suite resilience (a throwing
 * scenario fails without stopping the rest). The temp git repos are real —
 * only the CLI runners are faked.
 */

import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { checkExpectations, decidePick, runEval, type EvalDeps, type ScenarioResult } from '../src/eval/runEval';
import type { EvalScenario } from '../src/eval/scenarios';
import { recordUserPick } from '../src/gate/recordUserPick';
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
    recordPick: recordUserPick,
    mergeLane: fakeMergeLane,
    ...overrides,
  };
}

const COMPETE: EvalScenario = {
  id: 'fake-compete',
  mode: 'compete',
  prompt: 'do something',
  expect: { minLaneSuccess: 2, expectReview: true },
};

const BRAINSTORM: EvalScenario = {
  id: 'fake-brainstorm',
  mode: 'brainstorm',
  prompt: 'think about something',
  expect: { minLaneSuccess: 2, expectSynthesis: true },
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
});
