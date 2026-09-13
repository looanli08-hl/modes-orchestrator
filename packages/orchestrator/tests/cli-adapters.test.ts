/**
 * Unit test: CLI adapters (spec-mvp §3 — 官方非交互模式, unattended by construction)
 * Pinned behavior: a fan-out lane has no human to approve prompts, so known CLIs get
 * their auto-approve flag; unknown CLIs fall back to plain `-p` (recorded 2026-09-13:
 * qwen without --yolo "succeeds" but writes nothing — the empty-diff failure mode).
 */

import { describe, expect, it } from 'vitest';

import { buildWorkerArgs, CLI_ADAPTERS } from '../src/spawn/cliAdapters';

describe('cliAdapters: unattended worker args per CLI', () => {
  it('kimi runs plain -p (its prompt mode rejects --auto and already runs unattended)', () => {
    expect(buildWorkerArgs('kimi', 'do X')).toEqual(['-p', 'do X']);
  });

  it('qwen runs with --yolo (auto-approve)', () => {
    expect(buildWorkerArgs('qwen', 'do X')).toEqual(['--yolo', '-p', 'do X']);
  });

  it('iflow runs with --yolo', () => {
    expect(buildWorkerArgs('iflow', 'do X')).toEqual(['--yolo', '-p', 'do X']);
  });

  it('unknown CLI falls back to plain -p', () => {
    expect(buildWorkerArgs('some-future-cli', 'do X')).toEqual(['-p', 'do X']);
  });

  it('every adapter puts the prompt last (argv convention: -p <prompt>)', () => {
    for (const [name, adapter] of Object.entries(CLI_ADAPTERS)) {
      const args = adapter.workerArgs('PROMPT_HERE');
      expect(args.at(-1), name).toBe('PROMPT_HERE');
      expect(args.at(-2), name).toBe('-p');
    }
  });
});
