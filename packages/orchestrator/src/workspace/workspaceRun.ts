/**
 * workspaceRun — one prompt run inside a persistent workspace.
 *
 * The workspace IS the session's home: spawn always happens with
 * cwd = worktreePath, so the cwd-binding pitfall (feasibility §二 坑 1 —
 * Claude keys sessions by project dir, Codex --last only searches cwd) is
 * immune by construction, never by discipline.
 *
 * Resume: a stored kimi session is continued with `-r <sessionId> -p <prompt>`
 * (verified combination, feasibility §二 坑 4). Other CLIs have no verified
 * resume in this stack and always spawn fresh. After the run, sessionHealth
 * decides which id the model stores and whether the CLI silently renewed the
 * session (kimi opens a fresh session for unknown ids without any error).
 *
 * The run lands in the repo's JSONL event log as one lifecycle record
 * (task_type 'workspace-run', role 'worker') — stdout chunks stay in the lane
 * stream, same separation as everywhere else.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { FanOutDeps } from '../fanout/fanOut';
import { makeRealDeps } from '../fanout/realDeps';
import { EVENT_LOG_SCHEMA_VERSION } from '../schema/eventLog';
import { buildWorkerArgs } from '../spawn/cliAdapters';
import type { LaneStream } from '../spawn/laneStream';
import { resolveModelId } from '../spawn/modelResolution';
import { appendEvent } from '../store/eventLogStore';
import { assessSessionHealth, supportsResume } from './sessionHealth';

/** LaneStreamHub key + JSONL task_id for a workspace's runs */
export function workspaceStreamKey(workspaceId: string): string {
  return `ws-${workspaceId}`;
}

export interface WorkspaceRunOptions {
  /** registry workspace id — stream key and JSONL task_id are derived from it */
  workspaceId: string;
  repoPath: string;
  /** the workspace's worktree — the run ALWAYS happens inside it */
  worktreePath: string;
  cli: string;
  prompt: string;
  /** the workspace's stored session at spawn time (null = fresh session) */
  sessionId: string | null;
  /** stream label: run-1, run-2… */
  laneLabel: string;
  eventsFile: string;
  stream?: LaneStream;
}

export interface WorkspaceRunDeps {
  spawnProcess: FanOutDeps['spawnProcess'];
}

export interface WorkspaceRunResult {
  outcome: string;
  /** session id to store on the workspace (parsed from output, or the old one kept) */
  sessionId: string | null;
  /** true when a resume came back under a different id — the session silently died and was renewed */
  sessionRenewed: boolean;
}

export async function runWorkspacePrompt(options: WorkspaceRunOptions, deps?: WorkspaceRunDeps): Promise<WorkspaceRunResult> {
  const d = deps ?? makeRealDeps(options.repoPath, { taskId: workspaceStreamKey(options.workspaceId), stream: options.stream });
  const started = Date.now();
  // only kimi's -r is verified (sessionHealth.supportsResume); a stored session
  // from an older cli choice is ignored rather than passed to a CLI that
  // would choke on it
  const resumeId = supportsResume(options.cli) ? options.sessionId : null;
  const args = resumeId ? ['-r', resumeId, '-p', options.prompt] : buildWorkerArgs(options.cli, options.prompt);
  const raw = await d.spawnProcess(options.cli, args, { cwd: options.worktreePath, lane: options.laneLabel });

  const outcome = raw.exitCode === 0 && !raw.timedOut ? 'success' : 'failed';
  const assessment = assessSessionHealth(resumeId, raw.stdout + raw.stderr);
  await mkdir(path.dirname(options.eventsFile), { recursive: true });
  await appendEvent(options.eventsFile, {
    schema_version: EVENT_LOG_SCHEMA_VERSION,
    task_id: workspaceStreamKey(options.workspaceId),
    lane: options.laneLabel,
    attempt_id: `${workspaceStreamKey(options.workspaceId)}-${options.laneLabel}`,
    task_type: 'workspace-run',
    model: resolveModelId(options.cli),
    provider: options.cli,
    role: 'worker',
    outcome,
    score: null,
    cost: null,
    latency: Date.now() - started,
    verifier: 'process',
    ts: new Date().toISOString(),
  });
  return { outcome, sessionId: assessment.sessionId, sessionRenewed: assessment.sessionRenewed };
}
