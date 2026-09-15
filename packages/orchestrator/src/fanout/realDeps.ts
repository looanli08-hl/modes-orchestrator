/**
 * Real fan-out deps — the production implementations of FanOutDeps (seams.md §5).
 * createWorktree: `git worktree add` + per-lane branch (spec-mvp §3: never parallel-write
 * one workspace). spawnProcess: child_process spawn with output capture and a kill timer
 * (SIGTERM → SIGKILL) — port-spec §1B worker-stop row: only ever kills processes it spawned,
 * never touches the worktree.
 */

import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { LaneStream } from '../spawn/laneStream';
import type { FanOutDeps, SpawnedProcessResult } from './fanOut';

const execFileAsync = promisify(execFile);

export interface RealDepsOptions {
  taskId: string;
  /** kill the lane after this many ms (default 10 min) */
  timeoutMs?: number;
  /**
   * optional per-task lane output sink: stdout/stderr chunks are mirrored into
   * it as they arrive (live streaming to the console). Purely observational —
   * the spawn result and the kill timer are unaffected.
   */
  stream?: LaneStream;
}

export function makeRealDeps(repoPath: string, options: RealDepsOptions): FanOutDeps {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  return {
    async createWorktree(lane) {
      const worktreePath = path.join(repoPath, '.modes-worktrees', `${options.taskId}-${lane}`);
      const branch = `modes/${options.taskId}-${lane}`;
      await execFileAsync('git', ['worktree', 'add', worktreePath, '-b', branch], { cwd: repoPath });
      return worktreePath;
    },

    spawnProcess(cli, args, opts) {
      return new Promise<SpawnedProcessResult>((resolve, reject) => {
        // detached: the child gets its own process group so the kill timer can
        // take down the WHOLE group. Launcher CLIs (qwen's bin is a script that
        // spawns the real CLI as a grandchild) survive a plain child.kill: the
        // grandchild keeps running and holds the stdio pipes, so 'close' never
        // fires and the lane hangs forever (observed 2026-09-14, qwen 429 storm).
        const child = spawn(cli, args, { cwd: opts.cwd, detached: process.platform !== 'win32' });
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const killGroup = (signal: NodeJS.Signals): void => {
          // negative pid = the process group (POSIX); Windows has no groups → direct kill
          if (process.platform !== 'win32' && child.pid !== undefined) {
            try {
              process.kill(-child.pid, signal);
              return;
            } catch {
              // group already gone — fall through to the direct kill
            }
          }
          try {
            child.kill(signal);
          } catch {
            // already dead
          }
        };

        const killTimer = setTimeout(() => {
          timedOut = true;
          killGroup('SIGTERM');
          setTimeout(() => killGroup('SIGKILL'), 5000).unref();
        }, timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          stdout += text;
          options.stream?.write(opts.lane ?? cli, text);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          stderr += text;
          options.stream?.write(opts.lane ?? cli, text);
        });
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(killTimer);
          resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
        });
      });
    },
  };
}

/** Current diff of a lane's worktree vs HEAD (spec-mvp A2: diff comes from git, not CLI
 *  output). Readonly per the effect-classification contract: staging happens against a
 *  throwaway GIT_INDEX_FILE so untracked files show up without mutating the real index. */
export async function diffWorktree(worktreePath: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'modes-diff-index-'));
  const tempIndex = path.join(tempDir, 'index');
  try {
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    await execFileAsync('git', ['read-tree', 'HEAD'], { cwd: worktreePath, env });
    await execFileAsync('git', ['add', '-A'], { cwd: worktreePath, env });
    const { stdout } = await execFileAsync('git', ['diff', '--cached', 'HEAD'], { cwd: worktreePath, env });
    return stdout;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
