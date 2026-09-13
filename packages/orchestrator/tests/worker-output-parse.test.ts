/**
 * Unit test: worker output parser (spec-mvp A2)
 * Recorded fixture: tests/fixtures/kimi-success.{stdout,stderr} — a real
 * `kimi -p` run (2026-09-13). Asserts the fixed schema comes out and that
 * stderr session noise (resume hints, version banner) never enters the summary.
 * Fixture kimi-exit0-error.stdout covers the kimi quirk where a CLI error is
 * printed yet the process still exits 0.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseWorkerOutput } from '../src/parse/workerOutput';

const fixtures = path.join(import.meta.dirname, 'fixtures');

describe('parseWorkerOutput: CLI output → fixed schema (A2)', () => {
  it('real kimi -p success sample: outcome success, clean summary, no stderr noise', async () => {
    const stdout = await readFile(path.join(fixtures, 'kimi-success.stdout'), 'utf8');
    const stderr = await readFile(path.join(fixtures, 'kimi-success.stderr'), 'utf8');

    const result = parseWorkerOutput({ exitCode: 0, stdout, stderr });

    expect(result.outcome).toBe('success');
    expect(result.summary).toContain('OK');
    expect(result.summary).not.toContain('resume');
    expect(result.summary).not.toContain('version');
  });

  it('non-zero exit → failed, summary still carries whatever stdout exists', () => {
    const result = parseWorkerOutput({ exitCode: 1, stdout: 'partial work\n', stderr: 'boom' });
    expect(result.outcome).toBe('failed');
    expect(result.summary).toBe('partial work');
  });

  it('killed by the timeout timer → timeout regardless of exit code', () => {
    const result = parseWorkerOutput({ exitCode: 0, stdout: 'done', stderr: '', timedOut: true });
    expect(result.outcome).toBe('timeout');
  });

  it.each([
    'Error: 429 Too Many Requests',
    'rate limit reached for this hour',
    'insufficient_quota: your plan is exhausted',
    'quota exceeded, try again later',
    '当前账号额度已用完',
  ])('quota signature %j → quota_exhausted (not a generic failure)', (stderr) => {
    const result = parseWorkerOutput({ exitCode: 1, stdout: '', stderr });
    expect(result.outcome).toBe('quota_exhausted');
  });

  it('quota pattern wins over exit code — even exit 0 with a quota line is quota_exhausted', () => {
    const result = parseWorkerOutput({ exitCode: 0, stdout: 'rate limit hit, stopped early', stderr: '' });
    expect(result.outcome).toBe('quota_exhausted');
  });

  it('real kimi exit-0 error sample: outcome failed, NOT success (kimi quirk defense)', async () => {
    const stdout = await readFile(path.join(fixtures, 'kimi-exit0-error.stdout'), 'utf8');
    const result = parseWorkerOutput({ exitCode: 0, stdout, stderr: '' });
    expect(result.outcome).toBe('failed');
    expect(result.summary).toContain('Cannot combine');
  });

  it.each([
    { stdout: 'Error: something went wrong', stderr: '' },
    { stdout: '', stderr: '  error: bad flag\n' },
    { stdout: '\n\nERROR: crashed', stderr: '' },
  ])('exit 0 with leading error line %j → failed (case-insensitive, leading whitespace ok)', ({ stdout, stderr }) => {
    const result = parseWorkerOutput({ exitCode: 0, stdout, stderr });
    expect(result.outcome).toBe('failed');
  });

  it('exit 0 with "error:" only mid-output → still success (only the output head counts)', () => {
    const result = parseWorkerOutput({
      exitCode: 0,
      stdout: 'Fixed the bug.\nThe log line "error: x" no longer appears.',
      stderr: '',
    });
    expect(result.outcome).toBe('success');
  });

  it.each(['qwen-auth-missing.stderr', 'iflow-auth-missing.stderr'])(
    'real auth-missing output %s → failed, NOT quota_exhausted (auth failure ≠ quota)',
    async (fixture) => {
      const stderr = await readFile(path.join(fixtures, fixture), 'utf8');
      const result = parseWorkerOutput({ exitCode: 1, stdout: '', stderr });
      expect(result.outcome).toBe('failed');
    }
  );
});
