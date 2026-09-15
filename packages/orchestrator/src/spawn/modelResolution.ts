/**
 * Model identity resolution (spec-mvp §5 — JSONL events are the orchestration data asset).
 * The event log must record the real model behind each CLI lane, not 'unknown', because
 * routing memory is only as good as the model names it learned from.
 *
 * Per-CLI sources (verified 2026-09-13):
 *   - kimi: ~/.kimi-code/config.toml → `default_model = "..."` (minimal hand-parse; no TOML dep)
 *   - qwen: ~/.qwen/.env → `OPENAI_MODEL=...`
 * Unknown CLIs, missing files, or missing fields resolve to 'unknown' — never throw:
 * model identity is metadata and must not break the run that produced it.
 *
 * Results are cached per (cli, homedir) for the process lifetime: config files do not
 * change mid-session, and lanes resolve the same CLI repeatedly.
 */

import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { DEEPSEEK_MODEL } from './cliAdapters';

/** lanes whose model is fixed by our adapter flags, not a user config file */
const STATIC_MODELS: Record<string, string> = { deepseek: DEEPSEEK_MODEL };

interface ModelSource {
  configPath: (homedir: string) => string;
  extract: (content: string) => string | null;
}

const MODEL_SOURCES: Record<string, ModelSource> = {
  kimi: {
    configPath: (homedir) => path.join(homedir, '.kimi-code', 'config.toml'),
    extract: (content) => /^\s*default_model\s*=\s*"([^"]+)"/m.exec(content)?.[1] ?? null,
  },
  qwen: {
    configPath: (homedir) => path.join(homedir, '.qwen', '.env'),
    extract: (content) => /^\s*OPENAI_MODEL\s*=\s*"?([^"\n]+?)"?\s*$/m.exec(content)?.[1] ?? null,
  },
};

const cache = new Map<string, string>();

export function resolveModelId(cli: string, opts?: { homedir?: string }): string {
  const homedir = opts?.homedir ?? os.homedir();
  const cacheKey = `${cli}@${homedir}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;

  let model = STATIC_MODELS[cli] ?? 'unknown';
  const source = MODEL_SOURCES[cli];
  if (!STATIC_MODELS[cli] && source) {
    try {
      model = source.extract(readFileSync(source.configPath(homedir), 'utf8')) ?? 'unknown';
    } catch {
      // missing or unreadable config → 'unknown'
    }
  }

  cache.set(cacheKey, model);
  return model;
}
