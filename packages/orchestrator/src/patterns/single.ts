/**
 * Single pattern (spec-mvp §2.5) — 一枪: one CLI answers directly, no comparison, no
 * escalation. This is NOT cascade's degradation semantics: there is no next level —
 * a failed lane is a failed task, reported honestly, never retried silently. The
 * default CLI follows the availability preference kimi → qwen (the caller picks the
 * first available; runSingle itself just runs the one cli it is handed).
 *
 * Pipeline shape mirrors a one-level cascade: the lane runs in an isolated worktree
 * (branch modes/<taskId>-single so mergeLane works unchanged), the outcome lands in
 * the JSONL event log with lane 'single', and the worktree diff — not CLI output —
 * is the deliverable. Console gate: success with a non-empty diff awaits the human
 * pick; anything else (failure, or success with nothing to merge) is terminal.
 */

import path from 'node:path';
import { mkdir } from 'node:fs/promises';

import { diffWorktree, makeRealDeps } from '../fanout/realDeps';
import type { FanOutDeps, SpawnedProcessResult } from '../fanout/fanOut';
import { parseWorkerOutput } from '../parse/workerOutput';
import { EVENT_LOG_SCHEMA_VERSION, type EventLogOutcome } from '../schema/eventLog';
import { buildWorkerArgs } from '../spawn/cliAdapters';
import type { LaneStream } from '../spawn/laneStream';
import { resolveModelId } from '../spawn/modelResolution';
import { appendEvent } from '../store/eventLogStore';

export interface SingleOptions {
  repoPath: string;
  prompt: string;
  /** the one CLI to run; the kimi → qwen availability preference is resolved by the caller */
  cli: string;
  /** kill the lane after this many ms (default 10 min) */
  timeoutMs?: number;
  taskType?: string;
  /** optional per-task lane output sink — the lane's stdout/stderr streams into it live */
  stream?: LaneStream;
}

export interface SingleDeps extends FanOutDeps {
  diffWorktree: (worktreePath: string) => Promise<string>;
}

export interface SingleLaneResult {
  cli: string;
  outcome: EventLogOutcome;
  latency: number;
  summary: string;
  /** diff of the lane's worktree vs HEAD; '' on failure or a no-change answer */
  diff: string;
  worktreePath: string;
  branch: string;
}

export interface SingleResult {
  taskId: string;
  lane: SingleLaneResult;
  eventsFile: string;
}

export async function runSingle(options: SingleOptions, deps?: SingleDeps): Promise<SingleResult> {
  const taskId = `task-${Date.now().toString(36)}`;
  const eventsFile = path.join(options.repoPath, '.modes', 'events.jsonl');
  await mkdir(path.dirname(eventsFile), { recursive: true });
  const laneDeps: SingleDeps =
    deps ?? { ...makeRealDeps(options.repoPath, { taskId, timeoutMs: options.timeoutMs, stream: options.stream }), diffWorktree };

  const started = Date.now();
  const worktreePath = await laneDeps.createWorktree('single');
  const raw: SpawnedProcessResult = await laneDeps.spawnProcess(options.cli, buildWorkerArgs(options.cli, options.prompt), {
    cwd: worktreePath,
    lane: 'single',
  });
  const latency = Date.now() - started;
  const parsed = parseWorkerOutput(raw);

  await appendEvent(eventsFile, {
    schema_version: EVENT_LOG_SCHEMA_VERSION,
    task_id: taskId,
    lane: 'single',
    attempt_id: `${taskId}-single-1`,
    task_type: options.taskType ?? 'single',
    model: resolveModelId(options.cli),
    provider: options.cli,
    role: 'worker',
    outcome: parsed.outcome,
    score: null,
    cost: null,
    latency,
    verifier: 'process',
    ts: new Date().toISOString(),
  });

  // the diff is only read for a successful process — a failed lane's worktree state is meaningless
  const diff = parsed.outcome === 'success' && raw.exitCode === 0 ? await laneDeps.diffWorktree(worktreePath) : '';

  return {
    taskId,
    lane: {
      cli: options.cli,
      outcome: parsed.outcome,
      latency,
      summary: parsed.summary,
      diff,
      worktreePath,
      branch: `modes/${taskId}-single`,
    },
    eventsFile,
  };
}
