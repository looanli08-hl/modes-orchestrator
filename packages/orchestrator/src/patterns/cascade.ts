/**
 * Cascade pattern (spec-mvp §2.5) — 省钱优先: a serial degradation chain. The same
 * task goes to the cheapest CLI first; escalation to the next level triggers ONLY on
 * objective signals: outcome ≠ success, or success with an empty worktree diff (zero
 * output is a substantive failure). The chain stops at the first level that produced
 * "success AND a non-empty diff", or when the chain is exhausted — then winner is
 * null and the failure is presented honestly, never fabricated.
 *
 * Quality-based escalation (a reviewer judging a successful diff "not good enough"
 * and upgrading anyway) is intentionally NOT implemented — a deliberate follow-up.
 *
 * Every level lands in the JSONL event log with lane fixed to 'cascade' and
 * attempt_seq increasing from 1 — this is the design use case for the settlement
 * store's stale_attempt guard (settleResult.ts): retries of the same task on the
 * same lane key must never let a late older attempt overwrite a newer one.
 */

import path from 'node:path';
import { mkdir } from 'node:fs/promises';

import { diffWorktree, makeRealDeps } from '../fanout/realDeps';
import type { FanOutDeps, SpawnedProcessResult } from '../fanout/fanOut';
import { parseWorkerOutput } from '../parse/workerOutput';
import { EVENT_LOG_SCHEMA_VERSION, type EventLogOutcome } from '../schema/eventLog';
import { createResultStore } from '../settlement/settleResult';
import { buildWorkerArgs } from '../spawn/cliAdapters';
import { resolveModelId } from '../spawn/modelResolution';
import { appendEvent } from '../store/eventLogStore';

export interface CascadeLevel {
  cli: string;
  /** kill this level's process after this many ms (default 10 min) */
  timeoutMs?: number;
}

export interface CascadeOptions {
  repoPath: string;
  prompt: string;
  /** cheapest first */
  chain: CascadeLevel[];
  taskType?: string;
}

export interface CascadeDeps extends FanOutDeps {
  diffWorktree: (worktreePath: string) => Promise<string>;
}

export interface CascadeAttempt {
  level: number;
  cli: string;
  outcome: EventLogOutcome;
  latency: number;
}

export interface CascadeWinner {
  level: number;
  cli: string;
  summary: string;
  diff: string;
  worktreePath: string;
  branch: string;
}

export interface CascadeResult {
  taskId: string;
  /** null when the chain is exhausted — every level failed */
  winner: CascadeWinner | null;
  attempts: CascadeAttempt[];
  eventsFile: string;
}

export async function runCascade(options: CascadeOptions, deps?: CascadeDeps): Promise<CascadeResult> {
  const taskId = `task-${Date.now().toString(36)}`;
  const eventsFile = path.join(options.repoPath, '.modes', 'events.jsonl');
  await mkdir(path.dirname(eventsFile), { recursive: true });
  const store = createResultStore();

  const attempts: CascadeAttempt[] = [];
  let winner: CascadeWinner | null = null;

  for (const [index, entry] of options.chain.entries()) {
    const level = index + 1;
    // Levels run sequentially in isolated worktrees; the branch mirrors compete's
    // naming so mergeLane works unchanged on the winner.
    const laneKey = `cascade-${level}`;
    // Real deps are built per level so a per-level timeoutMs applies; injected
    // (fake) deps control timing themselves.
    const levelDeps: CascadeDeps =
      deps ?? { ...makeRealDeps(options.repoPath, { taskId, timeoutMs: entry.timeoutMs }), diffWorktree };

    const started = Date.now();
    // oxlint-disable-next-line no-await-in-loop -- serial chain: each level waits for the previous verdict
    const worktreePath = await levelDeps.createWorktree(laneKey);
    // oxlint-disable-next-line no-await-in-loop -- serial chain: each level waits for the previous verdict
    const raw: SpawnedProcessResult = await levelDeps.spawnProcess(entry.cli, buildWorkerArgs(entry.cli, options.prompt), {
      cwd: worktreePath,
    });
    const latency = Date.now() - started;
    const parsed = parseWorkerOutput(raw);

    const record = {
      task_id: taskId,
      lane: 'cascade',
      attempt_id: `${taskId}-${laneKey}`,
      attempt_seq: level,
      outcome: parsed.outcome,
      model: resolveModelId(entry.cli),
      provider: entry.cli,
      latency,
      ts: new Date().toISOString(),
    };
    store.settle(record);
    // oxlint-disable-next-line no-await-in-loop -- serial chain + append-only log: writes must stay ordered
    await appendEvent(eventsFile, {
      schema_version: EVENT_LOG_SCHEMA_VERSION,
      task_id: record.task_id,
      lane: record.lane,
      attempt_id: record.attempt_id,
      task_type: options.taskType ?? 'unknown',
      model: record.model,
      provider: record.provider,
      role: 'worker',
      outcome: record.outcome,
      score: null,
      cost: null,
      latency: record.latency,
      verifier: 'process',
      ts: record.ts,
    });
    attempts.push({ level, cli: entry.cli, outcome: record.outcome, latency });

    if (parsed.outcome === 'success' && raw.exitCode === 0) {
      // oxlint-disable-next-line no-await-in-loop -- serial chain: the diff decides whether the next level runs
      const diff = await levelDeps.diffWorktree(worktreePath);
      if (diff.trim() !== '') {
        winner = {
          level,
          cli: entry.cli,
          summary: parsed.summary,
          diff,
          worktreePath,
          branch: `modes/${taskId}-${laneKey}`,
        };
        break;
      }
      // success but zero output: substantive failure → escalate
    }
  }

  return { taskId, winner, attempts, eventsFile };
}
