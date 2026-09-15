/**
 * Unit test: follow-up runs (src/review/followup.ts) — kimi session parsing,
 * resume vs fallback spawn args, worktree diff recompute, and the JSONL
 * lifecycle record. Spawn/diff are faked; the event log is a real temp file.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseKimiSessionId, runFollowup, type FollowupDeps, type FollowupOptions } from '../src/review/followup';

describe('parseKimiSessionId', () => {
  it('returns null when the output has no resumable session', () => {
    expect(parseKimiSessionId('kimi version 0.42.0\nplain output\n')).toBeNull();
  });

  it('parses the resume hint', () => {
    expect(parseKimiSessionId('done\nTo resume this session: kimi -r session_abc-123\n')).toBe('session_abc-123');
  });

  it('takes the LAST session when several appear', () => {
    const text = 'kimi -r session_first\n…\nkimi -r session_second\n';
    expect(parseKimiSessionId(text)).toBe('session_second');
  });
});

const dirs: string[] = [];

function makeOptions(overrides: Partial<FollowupOptions> = {}): FollowupOptions {
  const dir = mkdtempSync(path.join(tmpdir(), 'modes-followup-'));
  dirs.push(dir);
  return {
    engineTaskId: 'eng-1',
    repoPath: '/repo',
    worktreePath: path.join(dir, 'wt'),
    prompt: 'the notes',
    sessionId: null,
    laneLabel: 'followup-1',
    eventsFile: path.join(dir, 'events.jsonl'),
    ...overrides,
  };
}

function makeDeps(exitCode = 0): FollowupDeps & { spawn: ReturnType<typeof vi.fn> } {
  const spawn = vi.fn(async () => ({ exitCode, stdout: 'follow-up done', stderr: '' }));
  return { spawn, spawnProcess: spawn, diffWorktree: vi.fn(async () => 'new diff') };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runFollowup', () => {
  it('resumes the kimi session when one was parsed', async () => {
    const deps = makeDeps();
    const result = await runFollowup(makeOptions({ sessionId: 'session_abc' }), deps);
    expect(deps.spawn).toHaveBeenCalledWith('kimi', ['-r', 'session_abc', '-p', 'the notes'], {
      cwd: expect.stringContaining('wt'),
      lane: 'followup-1',
    });
    expect(result).toEqual({ outcome: 'success', summary: 'follow-up done', diff: 'new diff' });
  });

  it('falls back to a fresh kimi -p without a session', async () => {
    const deps = makeDeps();
    await runFollowup(makeOptions({ sessionId: null }), deps);
    expect(deps.spawn).toHaveBeenCalledWith('kimi', ['-p', 'the notes'], expect.objectContaining({ lane: 'followup-1' }));
  });

  it('writes a worker record to the JSONL event log', async () => {
    const options = makeOptions({ sessionId: 'session_abc' });
    await runFollowup(options, makeDeps());
    const lines = readFileSync(options.eventsFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(record).toMatchObject({
      task_id: 'eng-1',
      lane: 'followup-1',
      attempt_id: 'eng-1-followup-1',
      task_type: 'followup',
      provider: 'kimi',
      role: 'worker',
      outcome: 'success',
      verifier: 'process',
    });
  });

  it('a failed follow-up reports honestly and recomputes no diff', async () => {
    const deps = makeDeps(1);
    const result = await runFollowup(makeOptions(), deps);
    expect(result.outcome).toBe('failed');
    expect(result.diff).toBe('');
    expect(deps.diffWorktree).not.toHaveBeenCalled();
  });
});
