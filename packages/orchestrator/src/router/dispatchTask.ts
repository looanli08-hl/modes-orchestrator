/**
 * dispatchTask — the AI dispatcher behind auto mode (spec-mvp §2.5 auto row,
 * upgraded from rule routing to AI dispatch). A non-interactive kimi call reads
 * the task and answers with a ROUTE marker over the five modes; the LAST valid
 * marker wins (same convention as the A/B judge — a dispatcher that quotes the
 * format instructions while reasoning gets its final decision used, not its
 * echo). A missing/malformed/unknown marker — or a failed dispatch spawn — falls
 * back to the rule router classifyTask, marked dispatchSource: 'rules-fallback'.
 * The fallback is the honest path: a routing decision is never fabricated from
 * a sloppy dispatcher.
 *
 * Deps are injectable so tests (and the eval harness) never spawn a real CLI.
 */

import type { SpawnedProcessResult } from '../fanout/fanOut';
import { makeRealDeps } from '../fanout/realDeps';
import { parseWorkerOutput } from '../parse/workerOutput';
import { buildWorkerArgs } from '../spawn/cliAdapters';
import { classifyTask, type RoutedMode, type TaskClassification } from './classifyTask';

export const DISPATCH_MODES: readonly RoutedMode[] = ['single', 'cascade', 'compete', 'brainstorm', 'roundtable'];

export interface DispatchOptions {
  prompt: string;
  /** cwd for the dispatcher process */
  workDir: string;
  /** CLI that dispatches (default kimi) */
  dispatcherCli?: string;
  timeoutMs?: number;
}

export interface DispatchDeps {
  spawnProcess: (cli: string, args: string[], opts: { cwd: string }) => Promise<SpawnedProcessResult>;
  /** rule router used on fallback; injectable so tests can assert it fired */
  classify: (prompt: string) => TaskClassification;
}

export function buildDispatchPrompt(prompt: string): string {
  return `You are the dispatcher of a multi-mode AI orchestrator. Read the user's task and
decide which execution mode should run it.

=== MODES ===
- single: one model answers directly, one shot, no fallback. Best for simple atomic
  tasks — a quick question, a tiny edit, a one-liner. Cheapest.
- cascade: a cheap model tries first; a stronger model steps in only on failure or
  empty output. Best for generative tasks (write/implement/fix/translate) that want
  a quality safety net.
- compete: two models implement independently, then get compared. Best for code tasks
  where correctness matters most. Expensive — double implementation cost.
- brainstorm: several models give independent takes in parallel, a synthesizer combines
  them. Best for open-ended creative or opinion questions.
- roundtable: several models debate across rounds, seeing and critiquing each other.
  Best for contested decisions that deserve a real argument. Most expensive.

Cost awareness: prefer the cheapest mode that genuinely fits the task. Never spend
compete or roundtable money on a task single or cascade can handle.

=== TASK ===
${prompt}

=== YOUR DECISION ===
Answer with exactly two lines:
ROUTE: single | cascade | compete | brainstorm | roundtable
REASON: <one sentence, in the user's language, why this mode fits>`;
}

const ROUTE_PATTERN = /\bROUTE:\s*(single|cascade|compete|brainstorm|roundtable)\b/gim;
const REASON_PATTERN = /^\s*REASON:\s*(.+?)\s*$/gim;

export interface ParsedRoute {
  mode: RoutedMode;
  /** '' when the dispatcher gave no REASON line — the route still counts */
  reason: string;
}

/**
 * The LAST valid ROUTE marker wins; an unknown mode or a missing marker is null
 * (malformed), never guessed. Same for REASON: the last line wins.
 */
export function parseDispatchOutput(text: string): ParsedRoute | null {
  const routes = [...text.matchAll(ROUTE_PATTERN)];
  if (routes.length === 0) return null;
  const mode = routes[routes.length - 1][1].toLowerCase() as RoutedMode;
  const reasons = [...text.matchAll(REASON_PATTERN)];
  const reason = reasons.length > 0 ? reasons[reasons.length - 1][1] : '';
  return { mode, reason };
}

export async function dispatchTask(options: DispatchOptions, deps?: DispatchDeps): Promise<TaskClassification> {
  const cli = options.dispatcherCli ?? 'kimi';
  const spawn =
    deps?.spawnProcess ?? makeRealDeps(options.workDir, { taskId: 'dispatch', timeoutMs: options.timeoutMs }).spawnProcess;
  const classify = deps?.classify ?? classifyTask;

  let parsed: ParsedRoute | null = null;
  try {
    const raw = await spawn(cli, buildWorkerArgs(cli, buildDispatchPrompt(options.prompt)), { cwd: options.workDir });
    if (parseWorkerOutput(raw).outcome === 'success') {
      parsed = parseDispatchOutput(raw.stdout);
    }
  } catch {
    // spawn itself failed (ENOENT, …) — the rule fallback below reports honestly
  }

  if (parsed) {
    return {
      mode: parsed.mode,
      confidence: 'high',
      reason: parsed.reason || `AI dispatch → ${parsed.mode}`,
      dispatchSource: 'ai',
    };
  }
  return { ...classify(options.prompt), dispatchSource: 'rules-fallback' };
}
