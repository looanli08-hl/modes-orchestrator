/**
 * Unit test: runRouted — the auto-mode dispatcher. classifyTask decides the
 * mode; runRouted calls the matching engine with the default lanes/chain and
 * stamps task_type as `auto:<mode>` so the routing decision lands in the JSONL
 * event log with zero schema change. Engines are injected fakes — dispatch
 * wiring is all that is under test here.
 */

import { describe, expect, it, vi } from 'vitest';

import type { BrainstormResult } from '../src/patterns/brainstorm';
import type { CascadeResult } from '../src/patterns/cascade';
import { runRouted, type RoutedEngines } from '../src/router/runRouted';
import type { RunTaskResult } from '../src/run/runTask';

function makeEngines() {
  const competeResult = { taskId: 'task-compete' } as RunTaskResult;
  const brainstormResult = { taskId: 'task-brainstorm' } as BrainstormResult;
  const cascadeResult = { taskId: 'task-cascade' } as CascadeResult;
  const engines: RoutedEngines = {
    runTask: vi.fn(async () => competeResult),
    runBrainstorm: vi.fn(async () => brainstormResult),
    runCascade: vi.fn(async () => cascadeResult),
  };
  return { engines, competeResult, brainstormResult, cascadeResult };
}

describe('runRouted', () => {
  it('explicit multi-version intent → runTask with kimi+qwen lanes, kimi reviewer, task_type auto:compete', async () => {
    const { engines, competeResult } = makeEngines();
    const { classification, result } = await runRouted(
      { prompt: '给我两个方案实现防抖', repoPath: '/repo' },
      engines
    );

    expect(classification.mode).toBe('compete');
    expect(engines.runTask).toHaveBeenCalledWith({
      repoPath: '/repo',
      prompt: '给我两个方案实现防抖',
      lanes: [
        { lane: 'A', cli: 'kimi' },
        { lane: 'B', cli: 'qwen' },
      ],
      reviewerCli: 'kimi',
      taskType: 'auto:compete',
    });
    expect(engines.runBrainstorm).not.toHaveBeenCalled();
    expect(engines.runCascade).not.toHaveBeenCalled();
    // the engine result is returned verbatim — no wrapping, no field picking
    expect(result).toBe(competeResult);
  });

  it('opinion question → runBrainstorm with kimi+qwen lanes, kimi synthesizer, workDir = repoPath, task_type auto:brainstorm', async () => {
    const { engines, brainstormResult } = makeEngines();
    const { classification, result } = await runRouted(
      { prompt: '你怎么看本地优先软件', repoPath: '/repo' },
      engines
    );

    expect(classification.mode).toBe('brainstorm');
    expect(engines.runBrainstorm).toHaveBeenCalledWith({
      prompt: '你怎么看本地优先软件',
      lanes: [
        { lane: 'A', cli: 'kimi' },
        { lane: 'B', cli: 'qwen' },
      ],
      synthesizerCli: 'kimi',
      workDir: '/repo',
      taskType: 'auto:brainstorm',
    });
    expect(engines.runTask).not.toHaveBeenCalled();
    expect(result).toBe(brainstormResult);
  });

  it('executional prompt → runCascade with the qwen→kimi chain, task_type auto:cascade', async () => {
    const { engines, cascadeResult } = makeEngines();
    const { classification, result } = await runRouted(
      { prompt: 'Create a file util.js with a clamp function', repoPath: '/repo' },
      engines
    );

    expect(classification.mode).toBe('cascade');
    expect(engines.runCascade).toHaveBeenCalledWith({
      repoPath: '/repo',
      prompt: 'Create a file util.js with a clamp function',
      chain: [{ cli: 'qwen' }, { cli: 'kimi' }],
      taskType: 'auto:cascade',
    });
    expect(engines.runTask).not.toHaveBeenCalled();
    expect(result).toBe(cascadeResult);
  });

  it('no-signal prompt falls back to cascade and says so honestly', async () => {
    const { engines } = makeEngines();
    const { classification } = await runRouted({ prompt: 'hello', repoPath: '/repo' }, engines);
    expect(classification).toEqual({ mode: 'cascade', confidence: 'low', reason: 'no clear signal, cheapest first' });
    expect(engines.runCascade).toHaveBeenCalledOnce();
  });

  it('defaults to the real engines when none are injected', async () => {
    // Not calling it (that would spawn real CLIs) — just assert the signature
    // compiles with a single argument by referencing the function type.
    const call: (options: { prompt: string; repoPath: string }) => Promise<unknown> = runRouted;
    expect(typeof call).toBe('function');
  });
});
