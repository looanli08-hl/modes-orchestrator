/**
 * Contract test: spawn-refusal (port-spec.md §4 row 2)
 * Orca counterpart: src/shared/orchestration-dispatch-refusal-contract.test.ts
 *   (pre-flight refusal receipts: code/message/data.nextSteps are published strings; zero side effects)
 * Pinned contract: spawnWorker refuses BEFORE any side effect when (a) the repo is invalid,
 *   (b) the CLI binary does not exist, (c) the prompt exceeds the size limit. Each refusal carries
 *   a stable error.code plus actionable nextSteps, and leaves no worktree and no child process behind.
 * Spec references: docs/port-spec.md §4 row 2, §7 item 4 (prompt limit = ARG_MAX-derived, value set by impl)
 * Red mode: ../src/spawn/spawnWorker does not exist yet — the import failure IS the red state.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { PROMPT_MAX_BYTES, spawnWorker } from '../src/spawn/spawnWorker';

const execFileAsync = promisify(execFile);

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-spawn-refusal-'));
  tempDirs.push(dir);
  return dir;
}

async function makeGitRepo(): Promise<string> {
  const dir = await makeTempDir();
  await execFileAsync('git', ['init'], { cwd: dir });
  return dir;
}

async function worktreeEntries(repoPath: string): Promise<string[]> {
  try {
    return await readdir(path.join(repoPath, '.git', 'worktrees'));
  } catch {
    return [];
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

describe('spawn-refusal: pre-flight refusals are stable and side-effect free', () => {
  it('invalid repo → error.code "invalid_repo" with nextSteps, no worktree created', async () => {
    const notARepo = await makeTempDir();
    const result = await spawnWorker({ repoPath: notARepo, cli: 'true', prompt: 'do something' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error.code).toBe('invalid_repo');
    expect(result.error.message).toBeTruthy();
    expect(result.error.nextSteps.length).toBeGreaterThan(0);
    // Zero side effects: no worktree metadata, no process handle handed out.
    expect(await worktreeEntries(notARepo)).toEqual([]);
    expect(result.error).not.toHaveProperty('pid');
  });

  it('missing CLI binary → error.code "cli_not_found", no worktree created', async () => {
    const repo = await makeGitRepo();
    const result = await spawnWorker({
      repoPath: repo,
      cli: 'modes-definitely-not-a-real-cli-xyz',
      prompt: 'do something',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error.code).toBe('cli_not_found');
    expect(result.error.nextSteps.length).toBeGreaterThan(0);
    expect(await worktreeEntries(repo)).toEqual([]);
  });

  it('oversized prompt → error.code "prompt_too_large", refused before any worktree exists', async () => {
    const repo = await makeGitRepo();
    const prompt = 'x'.repeat(PROMPT_MAX_BYTES + 1);
    const result = await spawnWorker({ repoPath: repo, cli: 'true', prompt });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error.code).toBe('prompt_too_large');
    expect(await worktreeEntries(repo)).toEqual([]);
  });
});
