/**
 * followup — continue a finished lane with the human's diff annotations.
 *
 * kimi's stdout ends with `To resume this session: kimi -r session_<id>`, so a
 * follow-up on a kimi lane resumes the SAME agent session (`kimi -r <id> -p
 * <notes>`) in the lane's worktree — the agent still has its own context.
 * Lanes without a resumable session (qwen, or an unparsable stream) fall back
 * to a fresh `kimi -p` whose prompt carries the original task, the lane's
 * current diff, and the formatted notes. The run streams under a
 * `followup-N` lane label, the worktree diff is recomputed from git (never
 * from CLI output), and the run lands in the JSONL event log as a worker
 * record — a lifecycle event, not a chunk.
 */

import { diffWorktree, makeRealDeps } from '../fanout/realDeps';
import type { FanOutDeps } from '../fanout/fanOut';
import { parseWorkerOutput } from '../parse/workerOutput';
import { EVENT_LOG_SCHEMA_VERSION } from '../schema/eventLog';
import type { LaneStream } from '../spawn/laneStream';
import { resolveModelId } from '../spawn/modelResolution';
import { appendEvent } from '../store/eventLogStore';

/** the last `kimi -r session_<id>` in a lane's output — the resumable session */
export function parseKimiSessionId(output: string): string | null {
  let last: string | null = null;
  for (const match of output.matchAll(/kimi -r (session_[\w-]+)/g)) last = match[1];
  return last;
}

export interface FollowupOptions {
  /** engine task id (worktree/branch prefix and JSONL task_id) */
  engineTaskId: string;
  repoPath: string;
  /** the lane's worktree — the follow-up runs inside it */
  worktreePath: string;
  /** final agent prompt (resume: notes only; fallback: task + diff + notes) */
  prompt: string;
  /** resumable kimi session, or null for the fresh-spawn fallback */
  sessionId: string | null;
  /** stream label for live output: followup-1, followup-2… */
  laneLabel: string;
  eventsFile: string;
  stream?: LaneStream;
}

export interface FollowupDeps {
  spawnProcess: FanOutDeps['spawnProcess'];
  diffWorktree: (worktreePath: string) => Promise<string>;
}

export interface FollowupResult {
  outcome: string;
  summary: string;
  /** worktree diff vs HEAD after the follow-up; '' on failure */
  diff: string;
}

export async function runFollowup(options: FollowupOptions, deps?: FollowupDeps): Promise<FollowupResult> {
  const d = deps ?? {
    ...makeRealDeps(options.repoPath, { taskId: options.engineTaskId, stream: options.stream }),
    diffWorktree,
  };
  const started = Date.now();
  const args = options.sessionId ? ['-r', options.sessionId, '-p', options.prompt] : ['-p', options.prompt];
  const raw = await d.spawnProcess('kimi', args, { cwd: options.worktreePath, lane: options.laneLabel });
  const parsed = parseWorkerOutput(raw);
  const diff = parsed.outcome === 'success' ? await d.diffWorktree(options.worktreePath) : '';
  await appendEvent(options.eventsFile, {
    schema_version: EVENT_LOG_SCHEMA_VERSION,
    task_id: options.engineTaskId,
    lane: options.laneLabel,
    attempt_id: `${options.engineTaskId}-${options.laneLabel}`,
    task_type: 'followup',
    model: resolveModelId('kimi'),
    provider: 'kimi',
    role: 'worker',
    outcome: parsed.outcome,
    score: null,
    cost: null,
    latency: Date.now() - started,
    verifier: 'process',
    ts: new Date().toISOString(),
  });
  return { outcome: parsed.outcome, summary: parsed.summary, diff };
}
