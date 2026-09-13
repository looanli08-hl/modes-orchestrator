/**
 * Unit tests: cascade mode (spec-mvp §2.5 — 省钱优先 serial degradation chain).
 * Deps are fully faked (no git, no processes): each level's spawn result and
 * worktree diff are scripted. Covers: early stop on level-1 success, escalation
 * on process failure, escalation on success-with-empty-diff (zero output is a
 * substantive failure), and chain exhaustion (winner null, honestly reported).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SpawnedProcessResult } from '../src/fanout/fanOut';
import { runCascade, type CascadeDeps } from '../src/patterns/cascade';
import { readEvents } from '../src/store/eventLogStore';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

interface ScriptedLevel {
  raw: SpawnedProcessResult;
  diff: string;
}

function makeFakeDeps(levels: ScriptedLevel[]) {
  const calls = {
    createWorktree: [] as string[],
    spawn: [] as { cli: string; cwd: string }[],
    diffWorktree: [] as string[],
  };
  let currentLevel = -1;
  const deps: CascadeDeps = {
    async createWorktree(lane) {
      calls.createWorktree.push(lane);
      return `/fake/worktrees/${lane}`;
    },
    async spawnProcess(cli, _args, opts) {
      calls.spawn.push({ cli, cwd: opts.cwd });
      currentLevel = calls.spawn.length - 1;
      const scripted = levels[currentLevel];
      if (!scripted) throw new Error(`unexpected spawn #${calls.spawn.length}`);
      return scripted.raw;
    },
    async diffWorktree(worktreePath) {
      calls.diffWorktree.push(worktreePath);
      return levels[currentLevel].diff;
    },
  };
  return { deps, calls };
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-cascade-test-'));
  tempDirs.push(dir);
  return dir;
}

const ok = (stdout = 'done'): SpawnedProcessResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (): SpawnedProcessResult => ({ exitCode: 1, stdout: '', stderr: 'boom' });

describe('runCascade: serial degradation chain', () => {
  it('level-1 success with a non-empty diff stops the chain early', async () => {
    const repoPath = await makeRepo();
    const { deps, calls } = makeFakeDeps([
      { raw: ok(), diff: 'diff --git a/hello.txt b/hello.txt' },
      { raw: ok(), diff: 'diff --git a/other.txt b/other.txt' },
    ]);

    const result = await runCascade(
      { repoPath, prompt: 'create hello.txt', chain: [{ cli: 'cheap' }, { cli: 'strong' }] },
      deps
    );

    expect(result.winner?.level).toBe(1);
    expect(result.winner?.cli).toBe('cheap');
    expect(result.winner?.worktreePath).toBe('/fake/worktrees/cascade-1');
    expect(result.winner?.branch).toBe('modes/test-placeholder-cascade-1'.replace('test-placeholder', result.taskId));
    expect(result.attempts).toEqual([{ level: 1, cli: 'cheap', outcome: 'success', latency: expect.any(Number) }]);
    // early stop: the expensive level never spawned
    expect(calls.spawn.map((s) => s.cli)).toEqual(['cheap']);
    expect(calls.createWorktree).toEqual(['cascade-1']);

    const events = await readEvents(result.eventsFile);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      task_id: result.taskId,
      lane: 'cascade',
      attempt_id: `${result.taskId}-cascade-1`,
      role: 'worker',
      outcome: 'success',
      provider: 'cheap',
      model: 'unknown',
      verifier: 'process',
    });
  });

  it('process failure escalates to the next level', async () => {
    const repoPath = await makeRepo();
    const { deps, calls } = makeFakeDeps([
      { raw: fail(), diff: '' },
      { raw: ok('strong did it'), diff: 'diff --git a/hello.txt b/hello.txt' },
    ]);

    const result = await runCascade(
      { repoPath, prompt: 'p', chain: [{ cli: 'cheap' }, { cli: 'strong' }] },
      deps
    );

    expect(result.winner?.level).toBe(2);
    expect(result.winner?.cli).toBe('strong');
    expect(result.winner?.summary).toBe('strong did it');
    expect(result.attempts.map((a) => a.outcome)).toEqual(['failed', 'success']);
    expect(calls.spawn.map((s) => s.cli)).toEqual(['cheap', 'strong']);
    // a failed process never gets diffed
    expect(calls.diffWorktree).toEqual(['/fake/worktrees/cascade-2']);

    const events = await readEvents(result.eventsFile);
    expect(events.map((e) => e.attempt_id)).toEqual([
      `${result.taskId}-cascade-1`,
      `${result.taskId}-cascade-2`,
    ]);
    expect(events.map((e) => e.outcome)).toEqual(['failed', 'success']);
  });

  it('success with an empty diff is a substantive failure and escalates', async () => {
    const repoPath = await makeRepo();
    const { deps } = makeFakeDeps([
      { raw: ok('all done, nothing to change'), diff: '' },
      { raw: ok(), diff: 'diff --git a/hello.txt b/hello.txt' },
    ]);

    const result = await runCascade(
      { repoPath, prompt: 'p', chain: [{ cli: 'cheap' }, { cli: 'strong' }] },
      deps
    );

    expect(result.winner?.level).toBe(2);
    expect(result.attempts).toHaveLength(2);
    const events = await readEvents(result.eventsFile);
    // the process-level outcome stays honest (success) even though it escalated
    expect(events[0].outcome).toBe('success');
    expect(events[1].outcome).toBe('success');
  });

  it('chain exhausted → winner null, every level attempted, nothing fabricated', async () => {
    const repoPath = await makeRepo();
    const { deps, calls } = makeFakeDeps([
      { raw: fail(), diff: '' },
      { raw: ok(), diff: '' },
      { raw: fail(), diff: '' },
    ]);

    const result = await runCascade(
      { repoPath, prompt: 'p', chain: [{ cli: 'a' }, { cli: 'b' }, { cli: 'c' }] },
      deps
    );

    expect(result.winner).toBeNull();
    expect(result.attempts).toHaveLength(3);
    expect(calls.spawn.map((s) => s.cli)).toEqual(['a', 'b', 'c']);
    const events = await readEvents(result.eventsFile);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.lane)).toEqual(['cascade', 'cascade', 'cascade']);
  });
});
