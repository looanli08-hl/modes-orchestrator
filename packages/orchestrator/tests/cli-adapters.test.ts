/**
 * Unit test: CLI adapters (spec-mvp §3 — 官方非交互模式, unattended by construction)
 * Pinned behavior: a fan-out lane has no human to approve prompts, so known CLIs get
 * their auto-approve flag; unknown CLIs fall back to plain `-p` (recorded 2026-09-13:
 * qwen without --yolo "succeeds" but writes nothing — the empty-diff failure mode).
 * deepseek (2026-09-15): no deepseek binary exists — the lane rides the qwen binary
 * with DeepSeek's OpenAI-compatible endpoint flags; the API key comes from
 * DEEPSEEK_API_KEY / .modes-secrets.json at spawn time, never from source.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildWorkerArgs, CLI_ADAPTERS, resolveCliBinary } from '../src/spawn/cliAdapters';

describe('cliAdapters: unattended worker args per CLI', () => {
  // deterministic key for every adapter build (deepseek reads it at args-build time)
  beforeEach(() => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test');
  });

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

describe('cliAdapters: deepseek (qwen binary + OpenAI-compatible endpoint)', () => {
  it('rides the qwen binary', () => {
    expect(resolveCliBinary('deepseek')).toBe('qwen');
    expect(resolveCliBinary('kimi')).toBe('kimi');
  });

  it('builds --yolo + base-url + key + model flags, prompt last', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test');
    expect(buildWorkerArgs('deepseek', 'do X')).toEqual([
      '--yolo',
      '--openai-base-url',
      'https://api.deepseek.com',
      '--openai-api-key',
      'sk-test',
      '-m',
      'deepseek-flash',
      '-p',
      'do X',
    ]);
  });

  it('refuses to build args with no key anywhere (never spawns keyless)', () => {
    expect(() =>
      buildWorkerArgs('deepseek', 'do X', { env: {}, secretsPath: '/nonexistent/.modes-secrets.json' })
    ).toThrowError(/missing_api_key|DEEPSEEK_API_KEY/);
  });
});
