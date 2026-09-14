/**
 * Unit test: single mode (spec-mvp §2.5 — 一枪: one CLI answers directly, no
 * fallback level). Deps are fully faked (no git, no processes): the spawn result
 * and worktree diff are scripted. Covers: the success path (worktree, spawn,
 * diff, JSONL event) and honest failure reporting (a failed lane is a failed
 * task — no retry, no fabricated diff).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SpawnedProcessResult } from '../src/fanout/fanOut';
import { runSingle, type SingleDeps } from '../src/patterns/single';
import { readEvents } from '../src/store/eventLogStore';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-single-test-'));
  tempDirs.push(dir);
  return dir;
}

function makeFakeDeps(script: { raw: SpawnedProcessResult; diff: string }) {
  const calls = {
    createWorktree: [] as string[],
    spawn: [] as { cli: string; cwd: string }[],
    diffWorktree: [] as string[],
  };
  const deps: SingleDeps = {
    async createWorktree(lane) {
      calls.createWorktree.push(lane);
      return `/fake/worktrees/${lane}`;
    },
    async spawnProcess(cli, _args, opts) {
      calls.spawn.push({ cli, cwd: opts.cwd });
      return script.raw;
    },
    async diffWorktree(worktreePath) {
      calls.diffWorktree.push(worktreePath);
      return script.diff;
    },
  };
  return { deps, calls };
}

const ok = (stdout = 'done'): SpawnedProcessResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (): SpawnedProcessResult => ({ exitCode: 1, stdout: '', stderr: 'boom' });

describe('runSingle: one shot, one lane', () => {
  it('success: runs the one CLI in an isolated worktree and reports the diff', async () => {
    const repoPath = await makeRepo();
    const { deps, calls } = makeFakeDeps({ raw: ok('fixed the typo'), diff: 'diff --git a/README.md b/README.md' });

    const result = await runSingle({ repoPath, prompt: 'fix the typo', cli: 'kimi', taskType: 'auto:single' }, deps);

    expect(calls.createWorktree).toEqual(['single']);
    expect(calls.spawn).toEqual([{ cli: 'kimi', cwd: '/fake/worktrees/single' }]);
    expect(calls.diffWorktree).toEqual(['/fake/worktrees/single']);
    expect(result.lane).toMatchObject({
      cli: 'kimi',
      outcome: 'success',
      summary: 'fixed the typo',
      diff: 'diff --git a/README.md b/README.md',
      worktreePath: '/fake/worktrees/single',
      branch: `modes/${result.taskId}-single`,
    });

    const events = await readEvents(result.eventsFile);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      task_id: result.taskId,
      lane: 'single',
      attempt_id: `${result.taskId}-single-1`,
      task_type: 'auto:single',
      role: 'worker',
      outcome: 'success',
      provider: 'kimi',
      verifier: 'process',
    });
  });

  it('defaults task_type to single', async () => {
    const repoPath = await makeRepo();
    const { deps } = makeFakeDeps({ raw: ok(), diff: 'diff' });
    const result = await runSingle({ repoPath, prompt: 'p', cli: 'qwen' }, deps);
    const events = await readEvents(result.eventsFile);
    expect(events[0].task_type).toBe('single');
    expect(events[0].provider).toBe('qwen');
  });

  it('lane failure is reported honestly: outcome failed, no diff read, nothing retried', async () => {
    const repoPath = await makeRepo();
    const { deps, calls } = makeFakeDeps({ raw: fail(), diff: 'should-never-be-read' });

    const result = await runSingle({ repoPath, prompt: 'p', cli: 'kimi' }, deps);

    expect(result.lane.outcome).toBe('failed');
    expect(result.lane.diff).toBe('');
    // a failed lane's worktree state is meaningless — the diff is never read
    expect(calls.diffWorktree).toEqual([]);
    // one shot: exactly one spawn, no escalation
    expect(calls.spawn).toHaveLength(1);

    const events = await readEvents(result.eventsFile);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failed');
  });
});
