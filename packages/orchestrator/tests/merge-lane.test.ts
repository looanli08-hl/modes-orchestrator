/**
 * Unit test: mergeLane (spec-mvp §1 — 汇总 diff 给用户挑选合并)
 * The picked lane's worktree changes land on the repo's current branch as a merge
 * commit; a conflicting merge surfaces code "merge_conflict" instead of corrupting state.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { mergeLane } from '../src/gate/mergeLane';

const execFileAsync = promisify(execFile);

let tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-merge-lane-'));
  tempDirs.push(dir);
  await execFileAsync('git', ['init'], { cwd: dir });
  await writeFile(path.join(dir, 'README.md'), 'seed\n');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['-c', 'user.email=t@m', '-c', 'user.name=t', 'commit', '-m', 'seed'], { cwd: dir });
  return dir;
}

async function makeLaneWorktree(repo: string): Promise<{ worktreePath: string; branch: string }> {
  const worktreePath = path.join(repo, '.modes-worktrees', 'lane-a');
  const branch = 'modes/test-lane-a';
  await execFileAsync('git', ['worktree', 'add', worktreePath, '-b', branch], { cwd: repo });
  return { worktreePath, branch };
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

describe('mergeLane: picked lane lands on the current branch', () => {
  it('commits worktree changes and merges the branch', async () => {
    const repo = await makeRepo();
    const { worktreePath, branch } = await makeLaneWorktree(repo);
    await writeFile(path.join(worktreePath, 'output.txt'), 'lane A output\n');

    await mergeLane({ repoPath: repo, worktreePath, branch, taskId: 'task-1', pick: 'A' });

    expect(await readFile(path.join(repo, 'output.txt'), 'utf8')).toBe('lane A output\n');
    const { stdout: log } = await execFileAsync('git', ['log', '--oneline', '-2'], { cwd: repo });
    expect(log).toContain('user pick: lane A (task-1)');
  });

  it('a conflicting merge throws merge_conflict and leaves the repo state intact', async () => {
    const repo = await makeRepo();
    const { worktreePath, branch } = await makeLaneWorktree(repo);
    await writeFile(path.join(worktreePath, 'README.md'), 'lane version\n');
    await writeFile(path.join(repo, 'README.md'), 'main version\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['-c', 'user.email=t@m', '-c', 'user.name=t', 'commit', '-m', 'main change'], {
      cwd: repo,
    });

    await expect(
      mergeLane({ repoPath: repo, worktreePath, branch, taskId: 'task-1', pick: 'A' })
    ).rejects.toMatchObject({ code: 'merge_conflict' });

    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repo });
    expect(status).not.toContain('UU'); // no half-resolved conflict left behind
  });
});
