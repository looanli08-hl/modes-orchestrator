/**
 * spawnWorker — the MVP form of Orca's `worker-start` (port-spec §1B).
 * Pre-flight refusals (port-spec §4 row 2) happen BEFORE any side effect:
 * invalid repo / missing CLI binary / oversized prompt each return a stable
 * error.code with actionable nextSteps, leaving no worktree and no process behind.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveCliBinary } from './cliAdapters';

const execFileAsync = promisify(execFile);

// port-spec §7 item 4: the prompt travels via argv, so the limit derives from the OS
// ARG_MAX (macOS: 1 MiB shared by argv+env). 128 KiB leaves ample headroom.
export const PROMPT_MAX_BYTES = 128 * 1024;

export interface SpawnWorkerOptions {
  repoPath: string;
  cli: string;
  prompt: string;
}

export interface SpawnRefusal {
  code: 'invalid_repo' | 'cli_not_found' | 'prompt_too_large';
  message: string;
  nextSteps: string[];
}

export type SpawnWorkerResult =
  | { ok: true; worktreePath: string; process: ChildProcess }
  | { ok: false; error: SpawnRefusal };

async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

async function binaryExists(bin: string): Promise<boolean> {
  const checks = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map(async (dir) => {
      try {
        await access(path.join(dir, bin), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  return (await Promise.all(checks)).some(Boolean);
}

export async function spawnWorker(options: SpawnWorkerOptions): Promise<SpawnWorkerResult> {
  const promptBytes = Buffer.byteLength(options.prompt, 'utf8');
  if (promptBytes > PROMPT_MAX_BYTES) {
    return {
      ok: false,
      error: {
        code: 'prompt_too_large',
        message: `prompt is ${promptBytes} bytes, limit is ${PROMPT_MAX_BYTES} (argv/ARG_MAX bound)`,
        nextSteps: ['Split the task into smaller prompts', 'Move large context into files the agent can read'],
      },
    };
  }

  if (!(await isGitRepo(options.repoPath))) {
    return {
      ok: false,
      error: {
        code: 'invalid_repo',
        message: `"${options.repoPath}" is not a git repository`,
        nextSteps: ['Run `git init` in the target directory', 'Pass the path of an existing git repository'],
      },
    };
  }

  if (!(await binaryExists(resolveCliBinary(options.cli)))) {
    return {
      ok: false,
      error: {
        code: 'cli_not_found',
        message: `CLI binary "${resolveCliBinary(options.cli)}" was not found on PATH`,
        nextSteps: [`Install "${options.cli}" and re-run its login flow`, 'Pick another CLI lane'],
      },
    };
  }

  const worktreePath = path.join(options.repoPath, '.modes-worktrees', `wt-${Date.now()}`);
  await execFileAsync('git', ['worktree', 'add', worktreePath, '-b', `modes/${path.basename(worktreePath)}`], {
    cwd: options.repoPath,
  });

  const child = spawn(resolveCliBinary(options.cli), ['-p', options.prompt], { cwd: worktreePath });
  return { ok: true, worktreePath, process: child };
}
