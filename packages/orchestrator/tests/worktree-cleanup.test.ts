/**
 * Unit test: cleanTaskWorktrees (server/worktreeCleanup.ts) against real git
 * repositories. A task's `.modes-worktrees/<taskId>-*` dirs and
 * `modes/<taskId>-*` branches are removed; other tasks' workspaces are
 * untouched; a removal that fails (e.g. an unwritable directory) is reported
 * per target and left on disk.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanTaskWorktrees } from '../src/server/worktreeCleanup';

const execFileAsync = promisify(execFile);

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (d) => {
      // the failure-path test makes the worktrees dir read-only; restore before rm
      await chmod(path.join(d, '.modes-worktrees'), 0o755).catch(() => {});
      await rm(d, { recursive: true, force: true });
    })
  );
  tempDirs = [];
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-wt-clean-'));
  tempDirs.push(dir);
  await execFileAsync('git', ['init'], { cwd: dir });
  await writeFile(path.join(dir, 'README.md'), 'seed\n');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['-c', 'user.email=t@m', '-c', 'user.name=t', 'commit', '-m', 'seed'], { cwd: dir });
  // git reports realpaths (macOS /var → /private/var); keep every comparison on one side
  return realpath(dir);
}

/** mirror of makeRealDeps.createWorktree's naming: .modes-worktrees/<taskId>-<lane> + modes/<taskId>-<lane> */
async function addTaskLane(repo: string, taskId: string, lane: string): Promise<string> {
  const worktreePath = path.join(repo, '.modes-worktrees', `${taskId}-${lane}`);
  await execFileAsync('git', ['worktree', 'add', worktreePath, '-b', `modes/${taskId}-${lane}`], { cwd: repo });
  return worktreePath;
}

async function worktreePaths(repo: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repo });
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

async function branchNames(repo: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['branch', '--format=%(refname:short)'], { cwd: repo });
  return stdout.split('\n').filter(Boolean);
}

describe('cleanTaskWorktrees', () => {
  it('removes the task’s worktrees and branches, leaving other tasks untouched', async () => {
    const repo = await makeRepo();
    const a = await addTaskLane(repo, 'task-1', 'A');
    const b = await addTaskLane(repo, 'task-1', 'B');
    const other = await addTaskLane(repo, 'task-2', 'A');

    const result = await cleanTaskWorktrees({ repoPath: repo, engineTaskId: 'task-1' });

    expect(result.failed).toEqual([]);
    expect(result.removed.toSorted()).toEqual([a, b].toSorted());
    expect(result.branches.toSorted()).toEqual(['modes/task-1-A', 'modes/task-1-B'].toSorted());

    // disk and git agree: task-1 workspaces are gone, task-2's survive
    await expect(readdir(path.join(repo, '.modes-worktrees'))).resolves.toEqual(['task-2-A']);
    expect(await worktreePaths(repo)).not.toContain(a);
    expect(await worktreePaths(repo)).toContain(other);
    expect(await branchNames(repo)).toEqual(expect.arrayContaining(['modes/task-2-A']));
    expect((await branchNames(repo)).filter((br) => br.includes('task-1'))).toEqual([]);
  });

  it('is a clean no-op when the task has no workspaces', async () => {
    const repo = await makeRepo();
    const result = await cleanTaskWorktrees({ repoPath: repo, engineTaskId: 'task-nope' });
    expect(result).toEqual({ removed: [], branches: [], failed: [] });
  });

  it('reports failures per target and leaves the workspace on disk', async () => {
    const repo = await makeRepo();
    const worktreePath = await addTaskLane(repo, 'task-1', 'A');
    // removing a dir entry needs write on the parent — read-only parent = EPERM.
    // Note: git unregisters the worktree metadata even when the dir deletion
    // fails, so the branch delete below SUCCEEDS and the dir is left orphaned —
    // the honest report is "worktree failed, branch removed".
    await chmod(path.join(repo, '.modes-worktrees'), 0o555);

    const result = await cleanTaskWorktrees({ repoPath: repo, engineTaskId: 'task-1' });

    expect(result.removed).toEqual([]);
    expect(result.failed.map((f) => f.target)).toEqual([worktreePath]);
    expect(result.branches).toEqual(['modes/task-1-A']);
    // nothing was swept under the rug: the orphaned worktree dir is still on disk
    await expect(readdir(path.join(repo, '.modes-worktrees'))).resolves.toEqual(['task-1-A']);
  });

  it('refuses task ids that could widen the git branch glob', async () => {
    const repo = await makeRepo();
    await expect(cleanTaskWorktrees({ repoPath: repo, engineTaskId: 'task-*' })).rejects.toThrow('invalid engine task id');
  });
});
