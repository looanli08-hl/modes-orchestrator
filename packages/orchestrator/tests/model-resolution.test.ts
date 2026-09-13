/**
 * Unit test: model identity resolution (spec-mvp §5 — real model names in the JSONL asset).
 * Pinned behavior: kimi reads `default_model` from ~/.kimi-code/config.toml (minimal
 * hand-parse, no TOML dep), qwen reads `OPENAI_MODEL` from ~/.qwen/.env; missing file,
 * missing field, or unknown CLI all resolve to 'unknown' without throwing.
 */

import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveModelId } from '../src/spawn/modelResolution';

const tmpDirs: string[] = [];

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-model-resolution-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveModelId', () => {
  it('kimi parses default_model from config.toml', async () => {
    const home = await makeHome();
    await mkdir(path.join(home, '.kimi-code'), { recursive: true });
    await writeFile(
      path.join(home, '.kimi-code', 'config.toml'),
      'theme = "dark"\ndefault_model = "kimi-code/k3"\n',
      'utf8'
    );
    expect(resolveModelId('kimi', { homedir: home })).toBe('kimi-code/k3');
  });

  it('qwen parses OPENAI_MODEL from .env', async () => {
    const home = await makeHome();
    await mkdir(path.join(home, '.qwen'), { recursive: true });
    await writeFile(
      path.join(home, '.qwen', '.env'),
      'OPENAI_API_KEY=sk-redacted\nOPENAI_MODEL=Qwen/Qwen3-Coder-30B-A3B-Instruct\n',
      'utf8'
    );
    expect(resolveModelId('qwen', { homedir: home })).toBe('Qwen/Qwen3-Coder-30B-A3B-Instruct');
  });

  it('missing config file resolves to unknown (no throw)', async () => {
    const home = await makeHome();
    expect(resolveModelId('kimi', { homedir: home })).toBe('unknown');
    expect(resolveModelId('qwen', { homedir: home })).toBe('unknown');
  });

  it('config file without the model field resolves to unknown', async () => {
    const home = await makeHome();
    await mkdir(path.join(home, '.kimi-code'), { recursive: true });
    await writeFile(path.join(home, '.kimi-code', 'config.toml'), 'theme = "dark"\n', 'utf8');
    await mkdir(path.join(home, '.qwen'), { recursive: true });
    await writeFile(path.join(home, '.qwen', '.env'), 'OPENAI_API_KEY=sk-redacted\n', 'utf8');
    expect(resolveModelId('kimi', { homedir: home })).toBe('unknown');
    expect(resolveModelId('qwen', { homedir: home })).toBe('unknown');
  });

  it('unknown CLI resolves to unknown without touching the filesystem', async () => {
    const home = await makeHome();
    expect(resolveModelId('some-future-cli', { homedir: home })).toBe('unknown');
  });

  it('caches per (cli, homedir): a config change after the first resolve is not re-read', async () => {
    const home = await makeHome();
    await mkdir(path.join(home, '.kimi-code'), { recursive: true });
    const configFile = path.join(home, '.kimi-code', 'config.toml');
    await writeFile(configFile, 'default_model = "kimi-code/k3"\n', 'utf8');
    expect(resolveModelId('kimi', { homedir: home })).toBe('kimi-code/k3');
    await writeFile(configFile, 'default_model = "kimi-code/k4"\n', 'utf8');
    expect(resolveModelId('kimi', { homedir: home })).toBe('kimi-code/k3');
  });
});
