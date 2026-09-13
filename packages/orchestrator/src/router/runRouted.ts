/**
 * runRouted — the auto-mode dispatcher (spec-mvp §2.5 auto row). classifyTask
 * resolves the mode, then the matching engine runs with the default topology
 * (compete: lanes kimi+qwen, reviewer kimi; brainstorm: same lanes, synthesizer
 * kimi; cascade: qwen → kimi, cheapest first). The routing decision lands in
 * the JSONL event log as task_type = `auto:<mode>` — every engine already
 * writes task_type, so the decision is recorded with zero schema change.
 * Engines are injectable so tests (and the eval harness) can drive fakes.
 */

import { runBrainstorm, type BrainstormResult } from '../patterns/brainstorm';
import { runCascade, type CascadeResult } from '../patterns/cascade';
import { runTask, type RunTaskResult } from '../run/runTask';
import { classifyTask, type TaskClassification } from './classifyTask';

export interface RunRoutedOptions {
  prompt: string;
  repoPath: string;
}

export interface RoutedEngines {
  runTask: typeof runTask;
  runBrainstorm: typeof runBrainstorm;
  runCascade: typeof runCascade;
}

export interface RoutedResult {
  classification: TaskClassification;
  /** the invoked engine's return value, verbatim */
  result: RunTaskResult | BrainstormResult | CascadeResult;
}

const DEFAULT_ENGINES: RoutedEngines = { runTask, runBrainstorm, runCascade };

export async function runRouted(options: RunRoutedOptions, engines: RoutedEngines = DEFAULT_ENGINES): Promise<RoutedResult> {
  const classification = classifyTask(options.prompt);
  const taskType = `auto:${classification.mode}`;

  if (classification.mode === 'compete') {
    const result = await engines.runTask({
      repoPath: options.repoPath,
      prompt: options.prompt,
      lanes: [
        { lane: 'A', cli: 'kimi' },
        { lane: 'B', cli: 'qwen' },
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
        { lane: 'B', cli: 'qwen' },
      ],
      synthesizerCli: 'kimi',
      workDir: options.repoPath,
      taskType,
    });
    return { classification, result };
  }

  const result = await engines.runCascade({
    repoPath: options.repoPath,
    prompt: options.prompt,
    chain: [{ cli: 'qwen' }, { cli: 'kimi' }],
    taskType,
  });
  return { classification, result };
}
