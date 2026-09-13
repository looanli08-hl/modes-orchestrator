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

import type { FanOutDeps, SpawnedProcessResult } from './fanOut';

const execFileAsync = promisify(execFile);

export interface RealDepsOptions {
  taskId: string;
  /** kill the lane after this many ms (default 10 min) */
  timeoutMs?: number;
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
        const child = spawn(cli, args, { cwd: opts.cwd });
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const killTimer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        }, timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
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
