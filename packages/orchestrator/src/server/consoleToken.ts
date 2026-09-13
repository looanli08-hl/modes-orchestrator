/**
 * consoleToken — shared bearer token for the modes console server.
 *
 * The token gates every /api/* route when set (see consoleServer.ts). It lives
 * in a stable file so the two processes that need it — the console server
 * (scripts/modes-console.ts) and the AionUi extension's activate.js (which
 * injects it into the embedded panel copy) — always agree, whichever starts
 * first. activate.js carries its own CJS copy of this read-or-create logic
 * (it runs under plain Node and cannot import TS); keep the two in sync.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** packages/orchestrator/.modes-console-token (gitignored). */
export const CONSOLE_TOKEN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.modes-console-token');

/** Read the shared token, creating the file (0600) on first call. */
export function ensureConsoleToken(tokenPath: string = CONSOLE_TOKEN_PATH): string {
  try {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* missing or unreadable — create below */
  }
  const token = randomUUID();
  writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
  return token;
}

/** Read the token if it exists, without creating it (extension proxy path). */
export function readConsoleToken(tokenPath: string = CONSOLE_TOKEN_PATH): string | null {
  try {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    return existing || null;
  } catch {
    return null;
  }
}
