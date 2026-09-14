/**
 * detectClis — which orchestratable CLIs are installed on this machine. The
 * console panel lights one chip per available CLI ("点亮几个 CLI = 雇几个员工").
 * Detection is a PATH lookup only (same check spawnWorker.ts does before
 * spawning): running `--version` would be slower and risks side effects
 * (login prompts, update checks) from CLIs we do not control.
 */

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

export interface CliAvailability {
  name: string;
  available: boolean;
}

/** CLIs the panel offers as chips, in display order */
export const KNOWN_CLIS = ['kimi', 'qwen', 'iflow', 'claude', 'codex'];

/** true when `bin` resolves to an executable file on PATH */
export async function binaryOnPath(bin: string): Promise<boolean> {
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

export async function detectClis(candidates: string[] = KNOWN_CLIS): Promise<CliAvailability[]> {
  return Promise.all(candidates.map(async (name) => ({ name, available: await binaryOnPath(name) })));
}
