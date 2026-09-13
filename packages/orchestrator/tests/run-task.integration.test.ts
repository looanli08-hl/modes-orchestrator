/**
 * Integration test: runTask end-to-end walking skeleton (spec-mvp §1, A1/A5/A6)
 * Two fake CLI lanes (shell scripts) fan out onto a real temp git repo. Asserts:
 *   A1 — exactly 2 worktrees + 2 branches are created, one per lane
 *   A5 — every step lands in the JSONL event log with all §5 fields present
 *   A6 — a failing lane degrades to a recorded failure without blocking the other lane
 * Review: a fake reviewer CLI emits VERDICT: AGREE; the task must land in
 * awaiting_user_pick (the merge decision stays with the human).
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { runTask } from '../src/run/runTask';
import { readEvents } from '../src/store/eventLogStore';
import { EVENT_LOG_FIELDS } from '../src/schema/eventLog';

const execFileAsync = promisify(execFile);

let tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeGitRepo(): Promise<string> {
  const dir = await makeTempDir('modes-run-task-repo-');
  await execFileAsync('git', ['init'], { cwd: dir });
  await writeFile(path.join(dir, 'README.md'), 'seed\n');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['-c', 'user.email=test@modes', '-c', 'user.name=test', 'commit', '-m', 'seed'], {
    cwd: dir,
  });
  return dir;
}

async function makeFakeCli(name: string, script: string): Promise<string> {
  const dir = await makeTempDir('modes-fake-cli-');
  const bin = path.join(dir, name);
  await writeFile(bin, `#!/bin/sh\n${script}\n`);
  await chmod(bin, 0o755);
  return bin;
}

const GOOD_CLI_SCRIPT = `
echo "change from $(basename "$PWD")" > OUTPUT.txt
echo "fake worker done"
`;

const REVIEWER_CLI_SCRIPT = `
echo "Both lanes look fine."
echo "VERDICT: AGREE"
`;

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

describe('runTask: end-to-end walking skeleton', () => {
  it('fans out to 2 worktrees, reviews, lands in awaiting_user_pick, JSONL complete (A1/A5)', async () => {
    const repo = await makeGitRepo();
    const cliA = await makeFakeCli('fake-a', GOOD_CLI_SCRIPT);
    const cliB = await makeFakeCli('fake-b', GOOD_CLI_SCRIPT);
    const reviewer = await makeFakeCli('fake-reviewer', REVIEWER_CLI_SCRIPT);

    const result = await runTask({
      repoPath: repo,
      prompt: 'add an OUTPUT.txt file',
      lanes: [
        { lane: 'A', cli: cliA },
        { lane: 'B', cli: cliB },
      ],
      reviewerCli: reviewer,
    });

    // A1: two distinct worktrees + branches
    const worktrees = await readdir(path.join(repo, '.modes-worktrees'));
    expect(worktrees).toHaveLength(2);
    const { stdout: branches } = await execFileAsync('git', ['branch', '--list', 'modes/*', '--format=%(refname:short)'], {
      cwd: repo,
    });
    expect(branches.trim().split('\n')).toHaveLength(2);

    // both lanes succeeded and produced diffs
    expect(result.lanes.map((l) => l.outcome)).toEqual(['success', 'success']);
    for (const lane of result.lanes) {
      expect(lane.diff).toContain('OUTPUT.txt');
    }

    // review ran and parsed
    expect(result.review?.verdict).toBe('agreed');

    // task waits on the human
    expect(result.state).toBe('awaiting_user_pick');

    // A5: JSONL has >= 3 records (2 workers + 1 reviewer), all §5 fields present
    const events = await readEvents(result.eventsFile);
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const event of events) {
      for (const field of EVENT_LOG_FIELDS) {
        expect(event, `record missing field ${field.name}`).toHaveProperty(field.name);
      }
    }
    expect(events.map((e) => e.role).toSorted()).toEqual(['reviewer', 'worker', 'worker']);
    expect(events.find((e) => e.role === 'reviewer')?.verifier).toBe(reviewer);
  });

  it('a failing lane degrades without blocking the other lane (A6)', async () => {
    const repo = await makeGitRepo();
    const cliA = await makeFakeCli('fake-fail', 'echo "boom" >&2; exit 1');
    const cliB = await makeFakeCli('fake-b', GOOD_CLI_SCRIPT);
    const reviewer = await makeFakeCli('fake-reviewer', REVIEWER_CLI_SCRIPT);

    const result = await runTask({
      repoPath: repo,
      prompt: 'add an OUTPUT.txt file',
      lanes: [
        { lane: 'A', cli: cliA },
        { lane: 'B', cli: cliB },
      ],
      reviewerCli: reviewer,
    });

    const byLane = Object.fromEntries(result.lanes.map((l) => [l.lane, l.outcome]));
    expect(byLane['A']).toBe('failed');
    expect(byLane['B']).toBe('success');
    expect(result.state).toBe('awaiting_user_pick');

    const events = await readEvents(result.eventsFile);
    expect(events.find((e) => e.lane === 'A')?.outcome).toBe('failed');
  });

  it('both lanes failed → review skipped, double failure presented honestly', async () => {
    const repo = await makeGitRepo();
    const cliA = await makeFakeCli('fake-fail-a', 'exit 1');
    const cliB = await makeFakeCli('fake-fail-b', 'exit 1');

    const result = await runTask({
      repoPath: repo,
      prompt: 'impossible task',
      lanes: [
        { lane: 'A', cli: cliA },
        { lane: 'B', cli: cliB },
      ],
    });

    expect(result.lanes.every((l) => l.outcome === 'failed')).toBe(true);
    expect(result.review).toBeNull();
    expect(result.state).toBe('awaiting_user_pick');
  });
});
