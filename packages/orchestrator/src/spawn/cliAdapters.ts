/**
 * CLI adapters — per-CLI argument construction for unattended worker runs.
 * A fan-out lane runs with no human present, so each CLI must act without asking.
 * Verified 2026-09-13 against live CLIs:
 *   - qwen/iflow (gemini-cli forks): plain `-p` stalls on tool approval and produces
 *     the "success but empty diff" failure mode → needs `--yolo`.
 *   - kimi: `-p` mode rejects `--auto` ("Cannot combine --prompt with --auto") and
 *     already runs unattended in plain `-p` → no extra flag.
 * Unknown CLIs fall back to the plain `-p` convention (spec-mvp §3: 官方非交互模式).
 */

export interface CliAdapter {
  workerArgs: (prompt: string) => string[];
}

const YOLO_ADAPTER: CliAdapter = { workerArgs: (prompt) => ['--yolo', '-p', prompt] };

export const CLI_ADAPTERS: Record<string, CliAdapter> = {
  kimi: { workerArgs: (prompt) => ['-p', prompt] },
  qwen: YOLO_ADAPTER,
  iflow: YOLO_ADAPTER,
};

const DEFAULT_ADAPTER: CliAdapter = { workerArgs: (prompt) => ['-p', prompt] };

export function buildWorkerArgs(cli: string, prompt: string): string[] {
  const adapter = CLI_ADAPTERS[cli] ?? DEFAULT_ADAPTER;
  return adapter.workerArgs(prompt);
}
