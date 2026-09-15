/**
 * createWorkspace — materialize a workspace: a named, persistent git worktree.
 *
 * Steps: validate the repo (same probe as the repos endpoint) → record the
 * current HEAD as baseRef (the detail diff's anchor) →
 * `git worktree add .modes-workspaces/<name> -b modes-ws/<name>` → environment
 * provisioning (feasibility §五 修正 #2: env governance is built in, never the
 * user's problem): a `.env` at the repo root is blind-copied into the worktree
 * (cp -n semantics — the code never reads its contents, and an existing file
 * is never overwritten; no `.env` → skipped silently).
 */

import { execFile } from 'node:child_process';
import { constants, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { diffWorktree } from '../fanout/realDeps';

const execFileAsync = promisify(execFile);

export interface CreatedWorktree {
  worktreePath: string;
  branch: string;
  /** HEAD of the repo at creation time — the diff anchor for the workspace */
  baseRef: string;
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

export async function createWorkspaceWorktree(options: {
  repoPath: string;
  name: string;
}): Promise<CreatedWorktree> {
  const { repoPath, name } = options;
  const resolved = path.resolve(repoPath);
  if (!(await isGitRepo(resolved))) {
    throw new Error(`"${resolved}" is not a git repository`);
  }
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: resolved });
  const baseRef = head.trim();
  const worktreePath = path.join(resolved, '.modes-workspaces', name);
  const branch = `modes-ws/${name}`;
  await execFileAsync('git', ['worktree', 'add', worktreePath, '-b', branch], { cwd: resolved });

  // blind copy: cp -n — never read the contents, never overwrite
  try {
    await copyFile(path.join(resolved, '.env'), path.join(worktreePath, '.env'), constants.COPYFILE_EXCL);
  } catch {
    // no .env at the repo root (the common case) or already present — both fine
  }

  return { worktreePath, branch, baseRef };
}

export interface WorkspaceDiff {
  /** `git diff baseRef...HEAD` — what the workspace's runs committed */
  committed: string;
  /** uncommitted state of the worktree, incl. untracked files (diff vs HEAD) */
  uncommitted: string;
}

/** the workspace's full diff vs its base ref: committed on its branch + still uncommitted */
export async function diffWorkspace(worktreePath: string, baseRef: string): Promise<WorkspaceDiff> {
  const { stdout: committed } = await execFileAsync('git', ['diff', `${baseRef}...HEAD`], { cwd: worktreePath });
  const uncommitted = await diffWorktree(worktreePath);
  return { committed, uncommitted };
}
