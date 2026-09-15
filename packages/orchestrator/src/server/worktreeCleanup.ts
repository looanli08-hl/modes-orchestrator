/**
 * worktreeCleanup — one-click reclaim of a finished task's workspaces.
 *
 * Tasks leave their lane worktrees (`.modes-worktrees/<taskId>-<lane>`) and
 * branches (`modes/<taskId>-<lane>`) behind after a pick — by design, so a
 * "neither" pick stays inspectable. This removes both for one engine task id.
 * Removals are attempted independently and failures are reported per target,
 * never swallowed: a half-cleaned task comes back with a `failed` list.
 */

import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorktreeCleanupFailure {
  /** the worktree path or branch name that could not be removed */
  target: string;
  error: string;
}

export interface WorktreeCleanupResult {
  /** worktree paths that were removed */
  removed: string[];
  /** branches that were deleted */
  branches: string[];
  failed: WorktreeCleanupFailure[];
}

const TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** worktree paths from `git worktree list --porcelain` ("worktree <path>" lines) */
async function listWorktreePaths(repoPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

async function listTaskBranches(repoPath: string, engineTaskId: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['branch', '--list', `modes/${engineTaskId}-*`, '--format=%(refname:short)'],
    { cwd: repoPath }
  );
  return stdout.split('\n').filter(Boolean);
}

export async function cleanTaskWorktrees(options: {
  repoPath: string;
  engineTaskId: string;
}): Promise<WorktreeCleanupResult> {
  const { repoPath, engineTaskId } = options;
  // the id becomes a git glob below — refuse anything that could widen the match
  if (!TASK_ID_PATTERN.test(engineTaskId)) {
    throw new Error(`invalid engine task id "${engineTaskId}"`);
  }

  // git reports realpaths in `worktree list` (e.g. macOS /var → /private/var),
  // so the prefix match must run against the resolved repo path
  const resolvedRepo = await realpath(repoPath);
  const worktreePrefix = path.join(resolvedRepo, '.modes-worktrees', `${engineTaskId}-`);
  const worktrees = (await listWorktreePaths(repoPath)).filter((p) => p.startsWith(worktreePrefix));

  const result: WorktreeCleanupResult = { removed: [], branches: [], failed: [] };

  for (const worktreePath of worktrees) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- independent removals, reported per target
      await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoPath });
      result.removed.push(worktreePath);
    } catch (err) {
      result.failed.push({ target: worktreePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const branch of await listTaskBranches(repoPath, engineTaskId)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a branch whose worktree removal failed errors here, honestly
      await execFileAsync('git', ['branch', '-D', branch], { cwd: repoPath });
      result.branches.push(branch);
    } catch (err) {
      result.failed.push({ target: branch, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
