/**
 * Unit test: runRouted — the auto-mode dispatcher. The dispatcher (injectable;
 * tests use the deterministic rulesDispatcher or hand-written decisions) resolves
 * one of the five modes; runRouted calls the matching engine with the default
 * lanes/chain/cli and stamps task_type as `auto:<mode>` so the routing decision
 * lands in the JSONL event log with zero schema change. Engines are injected
 * fakes — dispatch wiring is all that is under test here.
 */

import { describe, expect, it, vi } from 'vitest';

import type { BrainstormResult } from '../src/patterns/brainstorm';
import type { CascadeResult } from '../src/patterns/cascade';
import type { RoundtableResult } from '../src/patterns/roundtable';
import type { SingleResult } from '../src/patterns/single';
import { rulesDispatcher, runRouted, type RoutedDispatcher, type RoutedEngines } from '../src/router/runRouted';
import type { RunTaskResult } from '../src/run/runTask';
import { preferredSecondCli } from '../src/spawn/cliAdapters';

/** lane B of every default topology: deepseek when keyed, else qwen (mirrors production wiring) */
const SECOND = preferredSecondCli();

function makeEngines() {
  const competeResult = { taskId: 'task-compete' } as RunTaskResult;
  const brainstormResult = { taskId: 'task-brainstorm' } as BrainstormResult;
  const cascadeResult = { taskId: 'task-cascade' } as CascadeResult;
  const singleResult = { taskId: 'task-single' } as SingleResult;
  const roundtableResult = { taskId: 'task-roundtable' } as RoundtableResult;
  const engines: RoutedEngines = {
    runTask: vi.fn(async () => competeResult),
    runBrainstorm: vi.fn(async () => brainstormResult),
    runCascade: vi.fn(async () => cascadeResult),
    runSingle: vi.fn(async () => singleResult),
    runRoundtable: vi.fn(async () => roundtableResult),
  };
  return { engines, competeResult, brainstormResult, cascadeResult, singleResult, roundtableResult };
}

/** a hand-written AI decision, as dispatchTask would return it */
const aiDecision = (mode: 'single' | 'roundtable'): RoutedDispatcher =>
  async () => ({ mode, confidence: 'high', reason: `AI picked ${mode}`, dispatchSource: 'ai' });

describe('runRouted (rules dispatcher)', () => {
  it('explicit multi-version intent → runTask with kimi + second-cli lanes, kimi reviewer, task_type auto:compete', async () => {
    const { engines, competeResult } = makeEngines();
    const { classification, result } = await runRouted(
      { prompt: '给我两个方案实现防抖', repoPath: '/repo' },
      engines,
      rulesDispatcher
    );

    expect(classification.mode).toBe('compete');
    expect(engines.runTask).toHaveBeenCalledWith({
      repoPath: '/repo',
      prompt: '给我两个方案实现防抖',
      lanes: [
        { lane: 'A', cli: 'kimi' },
        { lane: 'B', cli: SECOND },
      ],
      reviewerCli: 'kimi',
      taskType: 'auto:compete',
    });
    expect(engines.runBrainstorm).not.toHaveBeenCalled();
    expect(engines.runCascade).not.toHaveBeenCalled();
    // the engine result is returned verbatim — no wrapping, no field picking
    expect(result).toBe(competeResult);
  });

  it('opinion question → runBrainstorm with kimi + second-cli lanes, kimi synthesizer, workDir = repoPath, task_type auto:brainstorm', async () => {
    const { engines, brainstormResult } = makeEngines();
    const { classification, result } = await runRouted(
      { prompt: '你怎么看本地优先软件', repoPath: '/repo' },
      engines,
      rulesDispatcher
    );

    expect(classification.mode).toBe('brainstorm');
    expect(engines.runBrainstorm).toHaveBeenCalledWith({
      prompt: '你怎么看本地优先软件',
      lanes: [
        { lane: 'A', cli: 'kimi' },
        { lane: 'B', cli: SECOND },
      ],
      synthesizerCli: 'kimi',
      workDir: '/repo',
      taskType: 'auto:brainstorm',
    });
    expect(engines.runTask).not.toHaveBeenCalled();
    expect(result).toBe(brainstormResult);
  });

  it('executional prompt → runCascade with the second-cli → kimi chain, task_type auto:cascade', async () => {
    const { engines, cascadeResult } = makeEngines();
    const { classification, result } = await runRouted(
      { prompt: 'Create a file util.js with a clamp function', repoPath: '/repo' },
      engines,
      rulesDispatcher
    );

    expect(classification.mode).toBe('cascade');
    expect(engines.runCascade).toHaveBeenCalledWith({
      repoPath: '/repo',
      prompt: 'Create a file util.js with a clamp function',
      chain: [{ cli: SECOND }, { cli: 'kimi' }],
      taskType: 'auto:cascade',
    });
    expect(engines.runTask).not.toHaveBeenCalled();
    expect(result).toBe(cascadeResult);
  });

  it('no-signal prompt falls back to cascade and says so honestly', async () => {
    const { engines } = makeEngines();
    const { classification } = await runRouted({ prompt: 'hello', repoPath: '/repo' }, engines, rulesDispatcher);
    expect(classification).toEqual({ mode: 'cascade', confidence: 'low', reason: 'no clear signal, cheapest first' });
    expect(engines.runCascade).toHaveBeenCalledOnce();
  });
});

describe('runRouted (AI dispatcher decisions)', () => {
  it('AI dispatch → single: runSingle with kimi, one shot, task_type auto:single', async () => {
    const { engines, singleResult } = makeEngines();
    const { classification, result } = await runRouted(
      { prompt: 'fix the typo in README', repoPath: '/repo' },
      engines,
      aiDecision('single')
    );

    expect(classification).toEqual({ mode: 'single', confidence: 'high', reason: 'AI picked single', dispatchSource: 'ai' });
    expect(engines.runSingle).toHaveBeenCalledWith({
      repoPath: '/repo',
      prompt: 'fix the typo in README',
      cli: 'kimi',
      taskType: 'auto:single',
    });
    expect(engines.runCascade).not.toHaveBeenCalled();
    expect(result).toBe(singleResult);
  });

  it('AI dispatch → roundtable: kimi + second-cli at the table, kimi synthesizer, task_type auto:roundtable', async () => {
    const { engines, roundtableResult } = makeEngines();
    const { classification, result } = await runRouted(
      { prompt: 'should we rewrite or refactor?', repoPath: '/repo' },
      engines,
      aiDecision('roundtable')
    );

    expect(classification.mode).toBe('roundtable');
    expect(engines.runRoundtable).toHaveBeenCalledWith({
      prompt: 'should we rewrite or refactor?',
      clis: ['kimi', SECOND],
      synthesizerCli: 'kimi',
      workDir: '/repo',
      taskType: 'auto:roundtable',
    });
    expect(engines.runBrainstorm).not.toHaveBeenCalled();
    expect(result).toBe(roundtableResult);
  });

  it('the dispatcher receives the prompt and repoPath', async () => {
    const { engines } = makeEngines();
    const dispatcher = vi.fn(aiDecision('single'));
    await runRouted({ prompt: 'p', repoPath: '/repo' }, engines, dispatcher);
    expect(dispatcher).toHaveBeenCalledWith('p', '/repo');
  });
});
