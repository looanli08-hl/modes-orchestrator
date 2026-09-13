/**
 * runTask — the walking skeleton (spec-mvp §1): one prompt → fan-out to 2 CLI lanes
 * in isolated worktrees → cross-review → await the human's pick. Every step lands in
 * the JSONL event log (spec-mvp §5); failures degrade and are recorded, never retried
 * (A6); when both lanes fail the review is skipped and the double failure is presented
 * honestly (port-spec §2B).
 */

import path from 'node:path';
import { mkdir } from 'node:fs/promises';

import { fanOut, type FanOutLane } from '../fanout/fanOut';
import { diffWorktree, makeRealDeps } from '../fanout/realDeps';
import { createTaskLifecycle, type TaskState } from '../gate/userGate';
import { parseWorkerOutput } from '../parse/workerOutput';
import { buildReviewPrompt, parseReviewVerdict, type ReviewVerdict } from '../review/crossReview';
import { buildWorkerArgs } from '../spawn/cliAdapters';
import { EVENT_LOG_SCHEMA_VERSION, type EventLogOutcome } from '../schema/eventLog';
import { createResultStore } from '../settlement/settleResult';
import { appendEvent } from '../store/eventLogStore';

export interface RunTaskOptions {
  repoPath: string;
  prompt: string;
  lanes: FanOutLane[];
  /** CLI used for the cross-review; defaults to the second lane's CLI */
  reviewerCli?: string;
  taskType?: string;
  timeoutMs?: number;
}

export interface RunTaskLaneResult {
  lane: string;
  outcome: EventLogOutcome;
  summary: string;
  diff: string;
  worktreePath: string;
  branch: string;
}

export interface RunTaskResult {
  taskId: string;
  state: TaskState;
  lanes: RunTaskLaneResult[];
  review: ReviewVerdict | null;
  eventsFile: string;
}

export async function runTask(options: RunTaskOptions): Promise<RunTaskResult> {
  const taskId = `task-${Date.now().toString(36)}`;
  const eventsFile = path.join(options.repoPath, '.modes', 'events.jsonl');
  await mkdir(path.dirname(eventsFile), { recursive: true });
  const lifecycle = createTaskLifecycle(taskId);
  const store = createResultStore();
  const deps = makeRealDeps(options.repoPath, { taskId, timeoutMs: options.timeoutMs });

  lifecycle.advance('begin_fanout');
  const fan = await fanOut({ repoPath: options.repoPath, prompt: options.prompt, lanes: options.lanes }, deps);

  const diffs = await Promise.all(
    fan.lanes.map((laneResult) =>
      laneResult.exitCode === 0
        ? diffWorktree(path.join(options.repoPath, '.modes-worktrees', `${taskId}-${laneResult.lane}`))
        : Promise.resolve('')
    )
  );

  const lanes: RunTaskLaneResult[] = [];
  for (const [i, laneResult] of fan.lanes.entries()) {
    const parsed = parseWorkerOutput(laneResult);
    const worktreePath = path.join(options.repoPath, '.modes-worktrees', `${taskId}-${laneResult.lane}`);
    const diff = diffs[i];

    const record = {
      task_id: taskId,
      lane: laneResult.lane,
      attempt_id: `${taskId}-${laneResult.lane}-1`,
      attempt_seq: 1,
      outcome: parsed.outcome,
      model: 'unknown',
      provider: options.lanes.find((l) => l.lane === laneResult.lane)?.cli ?? 'unknown',
      latency: laneResult.latency,
      ts: new Date().toISOString(),
    };
    store.settle(record);
    // oxlint-disable-next-line no-await-in-loop -- append-only log: writes must stay ordered
    await appendEvent(eventsFile, {
      schema_version: EVENT_LOG_SCHEMA_VERSION,
      task_id: record.task_id,
      lane: record.lane,
      attempt_id: record.attempt_id,
      task_type: options.taskType ?? 'unknown',
      model: record.model,
      provider: record.provider,
      role: 'worker',
      outcome: parsed.outcome,
      score: null,
      cost: null,
      latency: record.latency,
      verifier: 'process',
      ts: record.ts,
    });

    lanes.push({
      lane: laneResult.lane,
      outcome: parsed.outcome,
      summary: parsed.summary,
      diff,
      worktreePath,
      branch: `modes/${taskId}-${laneResult.lane}`,
    });
  }

  const anySucceeded = lanes.some((l) => l.outcome === 'success');
  let review: ReviewVerdict | null = null;

  if (anySucceeded) {
    lifecycle.advance('fanout_done');
    const reviewerCli = options.reviewerCli ?? options.lanes[1]?.cli ?? options.lanes[0].cli;
    const reviewPrompt = buildReviewPrompt({
      task: options.prompt,
      lanes: lanes.map((l) => ({ lane: l.lane, summary: l.summary, diff: l.diff })),
    });
    const started = Date.now();
    const raw = await deps.spawnProcess(reviewerCli, buildWorkerArgs(reviewerCli, reviewPrompt), {
      cwd: options.repoPath,
    });
    const parsed = parseWorkerOutput(raw);
    review = parsed.outcome === 'success' ? parseReviewVerdict(parsed.summary) : { verdict: 'failed', rationale: parsed.summary };

    await appendEvent(eventsFile, {
      schema_version: EVENT_LOG_SCHEMA_VERSION,
      task_id: taskId,
      lane: 'review',
      attempt_id: `${taskId}-review-1`,
      task_type: options.taskType ?? 'unknown',
      model: 'unknown',
      provider: reviewerCli,
      role: 'reviewer',
      outcome: parsed.outcome,
      score: null,
      cost: null,
      latency: Date.now() - started,
      verifier: reviewerCli,
      ts: new Date().toISOString(),
    });
    lifecycle.advance('review_done');
  } else {
    lifecycle.advance('fanout_all_failed');
  }

  return { taskId, state: lifecycle.state, lanes, review, eventsFile };
}
