/**
 * Contract test: fanout-exactly-once (port-spec.md §4 row 4)
 * Orca counterpart: src/main/runtime/rpc/methods/orchestration/worker/worker-start-prompt-contract.test.ts
 *   (exactly-one submission; oversized spec refused BEFORE any Task/Dispatch/terminal effect)
 * Pinned contract: one fanOut() call spawns exactly 2 processes in exactly 2 distinct worktrees;
 *   a failing lane is recorded and never auto-retried (A6: degrade, don't crash, don't retry);
 *   the prompt size limit is validated BEFORE the first `git worktree add`.
 * Spec references: docs/port-spec.md §4 row 4, §2B (no auto-retry); docs/spec-mvp.md §1, A1, A6
 * Red mode: ../src/fanout/fanOut does not exist yet — the import failure IS the red state.
 */

import { describe, expect, it, vi } from 'vitest';

import { fanOut } from '../src/fanout/fanOut';
import { PROMPT_MAX_BYTES } from '../src/spawn/spawnWorker';

function makeDeps(overrides: { failLane?: string } = {}) {
  const createWorktree = vi.fn(async (lane: string) => `/tmp/modes-test-wt-${lane}`);
  const spawnProcess = vi.fn(async (cli: string, args: string[], opts: { cwd: string }) => {
    void cli;
    void args;
    if (overrides.failLane && opts.cwd.endsWith(`-${overrides.failLane}`)) {
      return { exitCode: 1, stdout: '', stderr: 'boom' };
    }
    return { exitCode: 0, stdout: 'done', stderr: '' };
  });
  return { createWorktree, spawnProcess };
}

const lanes = [
  { lane: 'A', cli: 'fake-cli-a' },
  { lane: 'B', cli: 'fake-cli-b' },
] as const;

describe('fanout-exactly-once: one fan-out = exactly 2 processes + 2 worktrees', () => {
  it('spawns exactly 2 processes, each in its own distinct worktree', async () => {
    const deps = makeDeps();
    const result = await fanOut({ repoPath: '/tmp/fake-repo', prompt: 'implement X', lanes: [...lanes] }, deps);

    expect(deps.createWorktree).toHaveBeenCalledTimes(2);
    expect(deps.spawnProcess).toHaveBeenCalledTimes(2);

    const cwds = deps.spawnProcess.mock.calls.map(([, , opts]) => opts.cwd);
    expect(new Set(cwds).size).toBe(2);
    expect(result.lanes.map((l: { lane: string }) => l.lane).toSorted()).toEqual(['A', 'B']);
  });

  it('a failing lane degrades to a recorded failure — spawn count stays 2 (no auto-retry)', async () => {
    const deps = makeDeps({ failLane: 'A' });
    const result = await fanOut({ repoPath: '/tmp/fake-repo', prompt: 'implement X', lanes: [...lanes] }, deps);

    expect(deps.spawnProcess).toHaveBeenCalledTimes(2);
    const byLane = Object.fromEntries(result.lanes.map((l: { lane: string; outcome: string }) => [l.lane, l.outcome]));
    expect(byLane['A']).toBe('failed');
    expect(byLane['B']).toBe('success');
  });

  it('oversized prompt is refused before ANY worktree is created', async () => {
    const deps = makeDeps();
    const prompt = 'x'.repeat(PROMPT_MAX_BYTES + 1);

    await expect(fanOut({ repoPath: '/tmp/fake-repo', prompt, lanes: [...lanes] }, deps)).rejects.toMatchObject({
      code: 'prompt_too_large',
    });
    expect(deps.createWorktree).not.toHaveBeenCalled();
    expect(deps.spawnProcess).not.toHaveBeenCalled();
  });
});
