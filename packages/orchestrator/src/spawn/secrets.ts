/**
 * secrets — API keys for lanes backed by OpenAI-compatible providers (deepseek today).
 * Resolution order: the provider's env var first, then the gitignored
 * packages/orchestrator/.modes-secrets.json ({"deepseek":{"apiKey":"sk-..."}}).
 * The key never lives in source: it reaches the CLI via argv at spawn time
 * (cliAdapters.ts), the same channel the prompt already travels.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** gitignored; lives next to .modes-console-token */
export const SECRETS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.modes-secrets.json');

interface ModesSecrets {
  deepseek?: { apiKey?: string };
}

export interface SecretsOptions {
  /** defaults to process.env */
  env?: NodeJS.ProcessEnv;
  /** defaults to SECRETS_PATH */
  secretsPath?: string;
}

function readSecretsFile(secretsPath: string): ModesSecrets | null {
  try {
    return JSON.parse(readFileSync(secretsPath, 'utf8')) as ModesSecrets;
  } catch {
    // missing or malformed file — treated as "no secrets", never fatal
    return null;
  }
}

/** env DEEPSEEK_API_KEY wins; the gitignored secrets file is the fallback; null when neither exists */
export function getDeepseekApiKey(opts?: SecretsOptions): string | null {
  const fromEnv = (opts?.env ?? process.env).DEEPSEEK_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = readSecretsFile(opts?.secretsPath ?? SECRETS_PATH)?.deepseek?.apiKey?.trim();
  return fromFile || null;
}
