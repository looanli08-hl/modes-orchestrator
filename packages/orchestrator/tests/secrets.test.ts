/**
 * Unit test: secrets resolution + deepseek availability gating.
 * Pinning: env DEEPSEEK_API_KEY beats the gitignored .modes-secrets.json file;
 * with neither, getDeepseekApiKey is null and /api/clis reports deepseek
 * available=false even when the qwen binary it rides is on PATH.
 * Tests always pass explicit env/secretsPath so the developer's real key file
 * can never leak into a result.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectClis, KNOWN_CLIS } from '../src/spawn/detectClis';
import { getDeepseekApiKey } from '../src/spawn/secrets';

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

async function secretsFileWith(key: string): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'modes-secrets-test-'));
  const secretsPath = path.join(tempDir, '.modes-secrets.json');
  await writeFile(secretsPath, JSON.stringify({ deepseek: { apiKey: key } }));
  return secretsPath;
}

const NO_KEY = { env: {} as NodeJS.ProcessEnv, secretsPath: '/nonexistent/.modes-secrets.json' };

describe('secrets: getDeepseekApiKey', () => {
  it('env DEEPSEEK_API_KEY wins over the file', async () => {
    const secretsPath = await secretsFileWith('sk-from-file');
    expect(getDeepseekApiKey({ env: { DEEPSEEK_API_KEY: 'sk-from-env' }, secretsPath })).toBe('sk-from-env');
  });

  it('falls back to the secrets file when env is unset', async () => {
    const secretsPath = await secretsFileWith('sk-from-file');
    expect(getDeepseekApiKey({ env: {}, secretsPath })).toBe('sk-from-file');
  });

  it('blank env falls through to the file', async () => {
    const secretsPath = await secretsFileWith('sk-from-file');
    expect(getDeepseekApiKey({ env: { DEEPSEEK_API_KEY: '  ' }, secretsPath })).toBe('sk-from-file');
  });

  it('null when neither env nor file provides a key', () => {
    expect(getDeepseekApiKey(NO_KEY)).toBeNull();
  });

  it('a malformed secrets file is "no key", never a crash', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'modes-secrets-test-'));
    const secretsPath = path.join(tempDir, '.modes-secrets.json');
    await writeFile(secretsPath, 'not json{');
    expect(getDeepseekApiKey({ env: {}, secretsPath })).toBeNull();
  });
});

describe('detectClis: deepseek availability', () => {
  it('deepseek is one of the known chips', () => {
    expect(KNOWN_CLIS).toContain('deepseek');
  });

  it('no key → deepseek unavailable even though its binary (qwen) may be on PATH', async () => {
    const clis = await detectClis(['deepseek'], { hasCredentials: () => false });
    expect(clis).toEqual([{ name: 'deepseek', available: false }]);
  });

  it('key configured → availability reduces to the qwen binary lookup', async () => {
    const [deepseek, qwen] = await detectClis(['deepseek', 'qwen'], { hasCredentials: () => true });
    expect(deepseek.available).toBe(qwen.available);
  });
});
