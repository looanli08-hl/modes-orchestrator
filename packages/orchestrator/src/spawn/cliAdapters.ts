/**
 * CLI adapters — per-CLI argument construction for unattended worker runs.
 * A fan-out lane runs with no human present, so each CLI must act without asking.
 * Verified 2026-09-13 against live CLIs:
 *   - qwen/iflow (gemini-cli forks): plain `-p` stalls on tool approval and produces
 *     the "success but empty diff" failure mode → needs `--yolo`.
 *   - kimi: `-p` mode rejects `--auto` ("Cannot combine --prompt with --auto") and
 *     already runs unattended in plain `-p` → no extra flag.
 *   - deepseek (2026-09-15): no deepseek binary exists; the qwen binary drives
 *     DeepSeek's OpenAI-compatible endpoint via --openai-base-url/--openai-api-key.
 *     The key comes from DEEPSEEK_API_KEY or .modes-secrets.json (secrets.ts),
 *     never from source.
 * Unknown CLIs fall back to the plain `-p` convention (spec-mvp §3: 官方非交互模式).
 */

import { OrchestratorError } from '../errors';
import { getDeepseekApiKey, type SecretsOptions } from './secrets';

/** DeepSeek's OpenAI-compatible endpoint + default lane model */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_MODEL = 'deepseek-flash';

export interface CliAdapter {
  workerArgs: (prompt: string, opts?: SecretsOptions) => string[];
}

const YOLO_ADAPTER: CliAdapter = { workerArgs: (prompt) => ['--yolo', '-p', prompt] };

export const CLI_ADAPTERS: Record<string, CliAdapter> = {
  kimi: { workerArgs: (prompt) => ['-p', prompt] },
  qwen: YOLO_ADAPTER,
  iflow: YOLO_ADAPTER,
  deepseek: {
    workerArgs: (prompt, opts) => {
      const apiKey = getDeepseekApiKey(opts);
      if (!apiKey) {
        throw new OrchestratorError(
          'missing_api_key',
          'deepseek lane needs an API key: set DEEPSEEK_API_KEY or add {"deepseek":{"apiKey":"sk-..."}} to packages/orchestrator/.modes-secrets.json'
        );
      }
      return ['--yolo', '--openai-base-url', DEEPSEEK_BASE_URL, '--openai-api-key', apiKey, '-m', DEEPSEEK_MODEL, '-p', prompt];
    },
  },
};

/** cli name → binary on PATH when they differ (deepseek rides the qwen binary) */
const CLI_BINARIES: Record<string, string> = { deepseek: 'qwen' };

export function resolveCliBinary(cli: string): string {
  return CLI_BINARIES[cli] ?? cli;
}

/**
 * The working second lane CLI for every default topology: deepseek when a key
 * is configured (qwen's own account is broken — ModelScope 400, 2026-09), qwen
 * otherwise. qwen stays fully registered; a fixed qwen account makes this
 * return 'qwen' only when no DeepSeek key exists — pin a call site to 'qwen'
 * literally if it must never switch.
 */
export function preferredSecondCli(): string {
  return getDeepseekApiKey() ? 'deepseek' : 'qwen';
}

const DEFAULT_ADAPTER: CliAdapter = { workerArgs: (prompt) => ['-p', prompt] };

export function buildWorkerArgs(cli: string, prompt: string, opts?: SecretsOptions): string[] {
  const adapter = CLI_ADAPTERS[cli] ?? DEFAULT_ADAPTER;
  return adapter.workerArgs(prompt, opts);
}
