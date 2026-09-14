/**
 * Unit test: dispatchTask — the AI dispatcher behind auto mode. A non-interactive
 * kimi call answers with a ROUTE marker over the five modes; the LAST valid marker
 * wins; a missing/malformed/unknown marker — or a failed dispatch spawn — falls
 * back to the rule router, marked dispatchSource: 'rules-fallback'. Deps are faked
 * (no real CLI spawns); only the prompt construction, marker parsing, and the
 * fallback path are under test.
 */

import { describe, expect, it, vi } from 'vitest';

import type { SpawnedProcessResult } from '../src/fanout/fanOut';
import { classifyTask } from '../src/router/classifyTask';
import { buildDispatchPrompt, dispatchTask, parseDispatchOutput, type DispatchDeps } from '../src/router/dispatchTask';

const ok = (stdout: string): SpawnedProcessResult => ({ exitCode: 0, stdout, stderr: '' });

function makeDeps(stdout: string): DispatchDeps & { spawnProcess: ReturnType<typeof vi.fn> } {
  return {
    spawnProcess: vi.fn(async () => ok(stdout)),
    classify: vi.fn(classifyTask),
  };
}

describe('parseDispatchOutput', () => {
  it('parses each of the five legal modes', () => {
    for (const mode of ['single', 'cascade', 'compete', 'brainstorm', 'roundtable']) {
      expect(parseDispatchOutput(`reasoning\nROUTE: ${mode}\nREASON: because`)?.mode).toBe(mode);
    }
  });

  it('is case-insensitive and tolerates surrounding prose', () => {
    expect(parseDispatchOutput('Let me think…\nRoute: SINGLE\nreason: tiny task')?.mode).toBe('single');
    expect(parseDispatchOutput('ROUTE:   Roundtable.\nREASON: x')?.mode).toBe('roundtable');
  });

  it('the LAST valid marker wins (format-instruction echoes lose)', () => {
    const text = 'The format is ROUTE: compete …\nAfter thinking: ROUTE: single\nREASON: final answer';
    expect(parseDispatchOutput(text)?.mode).toBe('single');
  });

  it('missing marker → null', () => {
    expect(parseDispatchOutput('I think cascade would be nice')).toBeNull();
    expect(parseDispatchOutput('')).toBeNull();
  });

  it('unknown mode → null (never guessed)', () => {
    expect(parseDispatchOutput('ROUTE: turbo')).toBeNull();
    expect(parseDispatchOutput('ROUTE: singleX')).toBeNull();
  });

  it('extracts the REASON line; the last one wins; missing → empty string', () => {
    expect(parseDispatchOutput('ROUTE: single\nREASON: 这是个原子小任务')?.reason).toBe('这是个原子小任务');
    expect(parseDispatchOutput('REASON: draft\nROUTE: cascade\nREASON: final reason')?.reason).toBe('final reason');
    expect(parseDispatchOutput('ROUTE: cascade')?.reason).toBe('');
  });
});

describe('buildDispatchPrompt', () => {
  it('names all five modes and the output contract, and embeds the task', () => {
    const prompt = buildDispatchPrompt('修复登录页报错');
    for (const mode of ['single', 'cascade', 'compete', 'brainstorm', 'roundtable']) {
      expect(prompt).toContain(`- ${mode}:`);
    }
    expect(prompt).toContain('ROUTE:');
    expect(prompt).toContain('REASON:');
    expect(prompt).toContain('修复登录页报错');
    expect(prompt).toContain('Cost awareness');
  });
});

describe('dispatchTask', () => {
  it('AI dispatch: a valid marker resolves the mode with dispatchSource ai', async () => {
    const deps = makeDeps('thinking out loud\nROUTE: single\nREASON: 原子小任务，一路就够');
    const decision = await dispatchTask({ prompt: 'fix the typo in README', workDir: '/repo' }, deps);

    expect(decision).toEqual({
      mode: 'single',
      confidence: 'high',
      reason: '原子小任务，一路就够',
      dispatchSource: 'ai',
    });
    // the dispatcher spawns kimi non-interactively, in the task's workDir
    expect(deps.spawnProcess).toHaveBeenCalledWith('kimi', ['-p', expect.stringContaining('fix the typo in README')], {
      cwd: '/repo',
    });
    expect(deps.classify).not.toHaveBeenCalled();
  });

  it('a missing REASON still counts — the route is what matters', async () => {
    const deps = makeDeps('ROUTE: roundtable');
    const decision = await dispatchTask({ prompt: 'x', workDir: '/repo' }, deps);
    expect(decision.mode).toBe('roundtable');
    expect(decision.dispatchSource).toBe('ai');
    expect(decision.reason.length).toBeGreaterThan(0); // honest placeholder, never ''
  });

  it('malformed dispatcher output falls back to the rule router, marked rules-fallback', async () => {
    const deps = makeDeps('hmm, hard to say');
    const decision = await dispatchTask({ prompt: '你怎么看本地优先软件', workDir: '/repo' }, deps);

    expect(deps.classify).toHaveBeenCalledWith('你怎么看本地优先软件');
    expect(decision.mode).toBe('brainstorm'); // the rule router's verdict
    expect(decision.dispatchSource).toBe('rules-fallback');
  });

  it('a failed dispatch process (non-zero exit) falls back to rules', async () => {
    const deps: DispatchDeps = {
      spawnProcess: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'boom' })),
      classify: vi.fn(classifyTask),
    };
    const decision = await dispatchTask({ prompt: 'Create a file util.js', workDir: '/repo' }, deps);
    expect(decision.mode).toBe('cascade');
    expect(decision.dispatchSource).toBe('rules-fallback');
  });

  it('a spawn that throws (CLI missing) falls back to rules instead of crashing', async () => {
    const deps: DispatchDeps = {
      spawnProcess: vi.fn(async () => {
        throw new Error('spawn kimi ENOENT');
      }),
      classify: vi.fn(classifyTask),
    };
    const decision = await dispatchTask({ prompt: '给我两个方案实现防抖', workDir: '/repo' }, deps);
    expect(decision.mode).toBe('compete');
    expect(decision.dispatchSource).toBe('rules-fallback');
  });

  it('honors a dispatcherCli override', async () => {
    const deps = makeDeps('ROUTE: single');
    await dispatchTask({ prompt: 'x', workDir: '/repo', dispatcherCli: 'qwen' }, deps);
    expect(deps.spawnProcess).toHaveBeenCalledWith('qwen', expect.any(Array), { cwd: '/repo' });
  });
});
