/**
 * Integration test: brainstorm mode (spec-mvp §2.5 — 思考型任务)
 * N lanes answer in parallel WITHOUT worktrees or merging (thinking, not writing code);
 * a synthesizer lane then combines the diversity. No gate, no pick — the human reads,
 * doesn't decide. All lanes failed → synthesis skipped honestly (hermes rule).
 */

import { mkdtemp, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runBrainstorm } from '../src/patterns/brainstorm';
import { readEvents } from '../src/store/eventLogStore';

let tempDirs: string[] = [];

async function makeFakeCli(name: string, script: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-fake-cli-'));
  tempDirs.push(dir);
  const bin = path.join(dir, name);
  await writeFile(bin, `#!/bin/sh\n${script}\n`);
  await chmod(bin, 0o755);
  return bin;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

const lanes = (a: string, b: string, c: string) => [
  { lane: 'A', cli: a },
  { lane: 'B', cli: b },
  { lane: 'C', cli: c },
];

describe('runBrainstorm: N lanes think, synthesizer combines, no gate', () => {
  it('3 lanes fan out without worktrees; synthesis produced; JSONL complete', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-brainstorm-'));
    tempDirs.push(dir);
    const cliA = await makeFakeCli('a', 'echo "idea from A"');
    const cliB = await makeFakeCli('b', 'echo "idea from B"');
    const cliC = await makeFakeCli('c', 'echo "idea from C"');
    const synth = await makeFakeCli('synth', 'echo "SYNTHESIZED: all ideas combined"');

    const result = await runBrainstorm({
      prompt: 'ways to make standup meetings shorter',
      lanes: lanes(cliA, cliB, cliC),
      synthesizerCli: synth,
      workDir: dir,
    });

    // no worktrees, no merging — thinking tasks don't touch git
    await expect(readdir(path.join(dir, '.modes-worktrees'))).rejects.toThrow();

    expect(result.lanes.map((l) => l.outcome)).toEqual(['success', 'success', 'success']);
    expect(result.synthesis).toContain('SYNTHESIZED');

    const events = await readEvents(result.eventsFile);
    expect(events.map((e) => e.role).toSorted()).toEqual(['synthesizer', 'worker', 'worker', 'worker']);
  });

  it('one lane fails → synthesis still runs over the survivors (degrade, not crash)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-brainstorm-'));
    tempDirs.push(dir);
    const cliA = await makeFakeCli('a', 'exit 1');
    const cliB = await makeFakeCli('b', 'echo "idea from B"');
    const cliC = await makeFakeCli('c', 'echo "idea from C"');
    const synth = await makeFakeCli('synth', 'echo "SYNTHESIZED"');

    const result = await runBrainstorm({
      prompt: 'topic',
      lanes: lanes(cliA, cliB, cliC),
      synthesizerCli: synth,
      workDir: dir,
    });

    expect(result.lanes.map((l) => l.outcome)).toEqual(['failed', 'success', 'success']);
    expect(result.synthesis).toContain('SYNTHESIZED');
    const events = await readEvents(result.eventsFile);
    expect(events.find((e) => e.lane === 'A')?.outcome).toBe('failed');
  });

  it('all lanes failed → synthesis skipped, not fabricated', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-brainstorm-'));
    tempDirs.push(dir);
    const cliA = await makeFakeCli('a', 'exit 1');
    const synth = await makeFakeCli('synth', 'echo "SHOULD NOT RUN"');

    const result = await runBrainstorm({
      prompt: 'topic',
      lanes: lanes(cliA, cliA, cliA),
      synthesizerCli: synth,
      workDir: dir,
    });

    expect(result.synthesis).toBeNull();
    const events = await readEvents(result.eventsFile);
    expect(events.some((e) => e.role === 'synthesizer')).toBe(false);
  });
});
