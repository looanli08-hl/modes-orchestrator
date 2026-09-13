/**
 * fanOut — one prompt to N CLI lanes, each in its own worktree (spec-mvp §1, A1/A6).
 * Exactly-once contract (port-spec §4 row 4): one call spawns exactly one process per
 * lane; a failing lane degrades to a recorded failure and is never auto-retried.
 * The prompt size limit is validated before the first worktree is created.
 */

import { OrchestratorError } from '../errors';
import { buildWorkerArgs } from '../spawn/cliAdapters';
import { PROMPT_MAX_BYTES } from '../spawn/spawnWorker';

export interface FanOutLane {
  lane: string;
  cli: string;
}

export interface FanOutOptions {
  repoPath: string;
  prompt: string;
  lanes: FanOutLane[];
}

export interface SpawnedProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** true when the process was killed by the spawner's timeout, not by exiting */
  timedOut?: boolean;
}

export interface FanOutDeps {
  createWorktree: (lane: string) => Promise<string>;
  spawnProcess: (cli: string, args: string[], opts: { cwd: string }) => Promise<SpawnedProcessResult>;
}

export interface FanOutLaneResult {
  lane: string;
  outcome: 'success' | 'failed';
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** wall-clock ms from worktree creation to process exit */
  latency: number;
}

export interface FanOutResult {
  lanes: FanOutLaneResult[];
}

export async function fanOut(options: FanOutOptions, deps: FanOutDeps): Promise<FanOutResult> {
  const promptBytes = Buffer.byteLength(options.prompt, 'utf8');
  if (promptBytes > PROMPT_MAX_BYTES) {
    throw new OrchestratorError(
      'prompt_too_large',
      `prompt is ${promptBytes} bytes, limit is ${PROMPT_MAX_BYTES} (argv/ARG_MAX bound)`
    );
  }

  const lanes = await Promise.all(
    options.lanes.map(async ({ lane, cli }) => {
      const started = Date.now();
      const cwd = await deps.createWorktree(lane);
      const result = await deps.spawnProcess(cli, buildWorkerArgs(cli, options.prompt), { cwd });
      return {
        lane,
        outcome: result.exitCode === 0 ? ('success' as const) : ('failed' as const),
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        latency: Date.now() - started,
      };
    })
  );

  return { lanes };
}
