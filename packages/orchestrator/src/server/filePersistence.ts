/**
 * filePersistence — JSON-file TaskPersistence for the modes console.
 *
 * One file (packages/orchestrator/.modes-console-tasks.json, gitignored) holds
 * the full ConsoleTask records as a JSON array. Writes are atomic (tmp file +
 * rename) so a crash mid-write keeps the previous file intact; reads treat a
 * missing or corrupted file as empty history rather than failing the console.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TaskPersistence } from './taskRegistry';

/** packages/orchestrator/.modes-console-tasks.json (gitignored). */
export const CONSOLE_TASKS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.modes-console-tasks.json'
);

export function createFilePersistence(filePath: string = CONSOLE_TASKS_PATH): TaskPersistence {
  return {
    async save(tasks) {
      const tmpPath = `${filePath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(tasks, null, 2) + '\n', 'utf8');
      await rename(tmpPath, filePath);
    },
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
  };
}
