/**
 * runRouted — the auto-mode dispatcher (spec-mvp §2.5 auto row). The dispatcher
 * (default: the AI dispatcher dispatchTask, falling back internally to the rule
 * router classifyTask) resolves one of the five modes, then the matching engine
 * runs with the default topology (single: kimi one shot; compete: lanes kimi +
 * preferredSecondCli(), reviewer kimi; brainstorm: same lanes, synthesizer kimi;
 * cascade: preferredSecondCli() → kimi, cheapest first; roundtable: kimi +
 * preferredSecondCli() at the table, kimi synthesizer). preferredSecondCli() is
 * deepseek when a key is configured, else qwen (cliAdapters.ts). The
 * routing decision lands in the JSONL event log as task_type = `auto:<mode>` —
 * every engine already writes task_type, so the decision is recorded with zero
 * schema change. Engines and the dispatcher are injectable so tests (and the eval
 * harness) drive fakes and stay deterministic.
 */

import { runBrainstorm, type BrainstormResult } from '../patterns/brainstorm';
import { runCascade, type CascadeResult } from '../patterns/cascade';
import { runRoundtable, type RoundtableResult } from '../patterns/roundtable';
import { runSingle, type SingleResult } from '../patterns/single';
import { runTask, type RunTaskResult } from '../run/runTask';
import { preferredSecondCli } from '../spawn/cliAdapters';
import { classifyTask, type TaskClassification } from './classifyTask';
import { dispatchTask } from './dispatchTask';

export interface RunRoutedOptions {
  prompt: string;
  repoPath: string;
}

export interface RoutedEngines {
  runTask: typeof runTask;
  runBrainstorm: typeof runBrainstorm;
  runCascade: typeof runCascade;
  runSingle: typeof runSingle;
  runRoundtable: typeof runRoundtable;
}

/** resolves the auto-mode routing decision; default is the AI dispatcher */
export type RoutedDispatcher = (prompt: string, repoPath: string) => Promise<TaskClassification>;

/** the deterministic dispatcher: pure rule routing, no CLI spawn (eval/tests) */
export const rulesDispatcher: RoutedDispatcher = async (prompt) => classifyTask(prompt);

/** the production dispatcher: AI dispatch over kimi, rule fallback built in */
export const aiDispatcher: RoutedDispatcher = (prompt, repoPath) => dispatchTask({ prompt, workDir: repoPath });

export interface RoutedResult {
  classification: TaskClassification;
  /** the invoked engine's return value, verbatim */
  result: RunTaskResult | BrainstormResult | CascadeResult | SingleResult | RoundtableResult;
}

const DEFAULT_ENGINES: RoutedEngines = { runTask, runBrainstorm, runCascade, runSingle, runRoundtable };

export async function runRouted(
  options: RunRoutedOptions,
  engines: RoutedEngines = DEFAULT_ENGINES,
  dispatcher: RoutedDispatcher = aiDispatcher
): Promise<RoutedResult> {
  const classification = await dispatcher(options.prompt, options.repoPath);
  const taskType = `auto:${classification.mode}`;

  if (classification.mode === 'single') {
    const result = await engines.runSingle({
      repoPath: options.repoPath,
      prompt: options.prompt,
      cli: 'kimi',
      taskType,
    });
    return { classification, result };
  }

  if (classification.mode === 'compete') {
    const result = await engines.runTask({
      repoPath: options.repoPath,
      prompt: options.prompt,
      lanes: [
        { lane: 'A', cli: 'kimi' },
        { lane: 'B', cli: preferredSecondCli() },
      ],
      reviewerCli: 'kimi',
      taskType,
    });
    return { classification, result };
  }

  if (classification.mode === 'brainstorm') {
    const result = await engines.runBrainstorm({
      prompt: options.prompt,
      lanes: [
        { lane: 'A', cli: 'kimi' },
        { lane: 'B', cli: preferredSecondCli() },
      ],
      synthesizerCli: 'kimi',
      workDir: options.repoPath,
      taskType,
    });
    return { classification, result };
  }

  if (classification.mode === 'roundtable') {
    const result = await engines.runRoundtable({
      prompt: options.prompt,
      clis: ['kimi', preferredSecondCli()],
      synthesizerCli: 'kimi',
      workDir: options.repoPath,
      taskType,
    });
    return { classification, result };
  }

  const result = await engines.runCascade({
    repoPath: options.repoPath,
    prompt: options.prompt,
    chain: [{ cli: preferredSecondCli() }, { cli: 'kimi' }],
    taskType,
  });
  return { classification, result };
}
