/**
 * mergeLane — the "user picked lane X" effect: commit the lane's worktree changes onto
 * its branch, then merge that branch into the repo's current branch (spec-mvp §1:
 * 汇总 diff 给用户挑选合并). Only ever invoked after an explicit human pick —
 * the gate (userGate.ts) is what keeps this from ever being programmatic.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { OrchestratorError } from '../errors';

const execFileAsync = promisify(execFile);

export interface MergeLaneOptions {
  repoPath: string;
  worktreePath: string;
  branch: string;
  taskId: string;
  pick: string;
}

export async function mergeLane(options: MergeLaneOptions): Promise<void> {
  const { repoPath, worktreePath, branch, taskId, pick } = options;

  const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreePath });
  if (status.trim()) {
    await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
    await execFileAsync(
      'git',
      ['-c', 'user.email=modes@local', '-c', 'user.name=modes', 'commit', '-m', `lane ${pick} output (${taskId})`],
      { cwd: worktreePath }
    );
  }

  try {
    await execFileAsync(
      'git',
      ['-c', 'user.email=modes@local', '-c', 'user.name=modes', 'merge', '--no-ff', branch, '-m', `user pick: lane ${pick} (${taskId})`],
      { cwd: repoPath }
    );
  } catch (err) {
    // Safe failure (port-spec: refusal receipts are side-effect free): a failed merge
    // must not leave the repo mid-merge — abort back to the pre-merge state.
    await execFileAsync('git', ['merge', '--abort'], { cwd: repoPath }).catch(() => {});
    throw new OrchestratorError(
      'merge_conflict',
      `merging ${branch} into the current branch failed — resolve manually in ${repoPath}: ${String(err)}`
    );
  }
}
