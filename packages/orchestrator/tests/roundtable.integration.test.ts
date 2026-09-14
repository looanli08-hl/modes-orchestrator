/**
 * Integration test: roundtable mode (spec-mvp §2.5 — 多 CLI 多轮交叉可见的真协作)
 * Round 1: all CLIs answer in parallel with scratch-dir isolation (no git, like
 * brainstorm). A reviewer lane then judges substantive consensus via a CONSENSUS:
 * YES|NO marker — a missing/malformed marker is NO (consensus is never fabricated).
 * Non-consensus → round 2: each surviving lane sees its own and its peers' answers
 * and revises. Synthesis runs over the last round's survivors, falling back to the
 * round-1 answers when the final round wiped out (手里有货就不浪费); all of round 1
 * failed → no review, no synthesis (hermes 全失败跳过合成).
 */

import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseConsensus, runRoundtable } from '../src/patterns/roundtable';
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

async function makeWorkDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-roundtable-'));
  tempDirs.push(dir);
  return dir;
}

/** worker that answers in round 1 but dies when given the revision prompt */
const dieOnRevision = (tag: string) => `case "$*" in
  *"YOUR REVISED ANSWER"*) exit 1 ;;
  *) echo "answer-${tag}" ;;
esac`;

/** worker that answers "answer-<tag>" in round 1 and "revised-<tag>" when given the revision prompt */
const workerScript = (tag: string) => `case "$*" in
  *"YOUR REVISED ANSWER"*) echo "revised-${tag}" ;;
  *) echo "answer-${tag}" ;;
esac`;

/** reviewer+synthesizer: consensus verdict from a script variable, synthesis echoes what it synthesized */
const reviewerScript = (consensus: 'YES' | 'NO' | 'MISSING') => {
  const verdict =
    consensus === 'MISSING' ? 'echo "hard to say, really"' : `echo "reasoning"; echo "CONSENSUS: ${consensus}"`;
  return `case "$*" in
  *"CONSENSUS:"*) ${verdict} ;;
  *"YOUR SYNTHESIS"*) echo "SYNTH over: $*" ;;
esac`;
};

describe('parseConsensus', () => {
  it('YES only on an explicit final-line marker; missing/malformed is NO', () => {
    expect(parseConsensus('some reasoning\nCONSENSUS: YES')).toBe(true);
    expect(parseConsensus('CONSENSUS: NO')).toBe(false);
    expect(parseConsensus('no marker at all')).toBe(false);
    expect(parseConsensus('')).toBe(false);
    expect(parseConsensus('CONSENSUS: MAYBE')).toBe(false);
  });
});

describe('runRoundtable', () => {
  it('non-consensus: both rounds run, synthesis over the revised answers, JSONL roles + rounds correct', async () => {
    const dir = await makeWorkDir();
    const cliA = await makeFakeCli('a', workerScript('A'));
    const cliB = await makeFakeCli('b', workerScript('B'));
    const judge = await makeFakeCli('judge', reviewerScript('NO'));

    const result = await runRoundtable({
      prompt: 'tabs or spaces?',
      clis: [cliA, cliB],
      synthesizerCli: judge,
      workDir: dir,
    });

    expect(result.consensus).toBe(false);
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].lanes.map((l) => l.answer)).toEqual(['answer-A', 'answer-B']);
    expect(result.rounds[1].lanes.map((l) => l.answer)).toEqual(['revised-A', 'revised-B']);
    // synthesis input is the revised answers, not the round-1 ones
    expect(result.synthesis).toContain('revised-A');
    expect(result.synthesis).toContain('revised-B');

    const events = await readEvents(result.eventsFile);
    expect(events.map((e) => e.role)).toEqual(['worker', 'worker', 'reviewer', 'worker', 'worker', 'synthesizer']);
    const workers = events.filter((e) => e.role === 'worker');
    expect(workers.filter((e) => e.attempt_id.endsWith('-r1'))).toHaveLength(2);
    expect(workers.filter((e) => e.attempt_id.endsWith('-r2'))).toHaveLength(2);
    expect(events.find((e) => e.role === 'reviewer')?.verifier).toBe(judge);
  });

  it('consensus after round 1: early stop, no second round, synthesis still runs', async () => {
    const dir = await makeWorkDir();
    const cliA = await makeFakeCli('a', workerScript('A'));
    const cliB = await makeFakeCli('b', workerScript('B'));
    const judge = await makeFakeCli('judge', reviewerScript('YES'));

    const result = await runRoundtable({
      prompt: 'is water wet?',
      clis: [cliA, cliB],
      synthesizerCli: judge,
      workDir: dir,
    });

    expect(result.consensus).toBe(true);
    expect(result.rounds).toHaveLength(1);
    expect(result.synthesis).toContain('answer-A');

    const events = await readEvents(result.eventsFile);
    expect(events.map((e) => e.role)).toEqual(['worker', 'worker', 'reviewer', 'synthesizer']);
  });

  it('missing CONSENSUS marker is treated as NO — the debate continues', async () => {
    const dir = await makeWorkDir();
    const cliA = await makeFakeCli('a', workerScript('A'));
    const cliB = await makeFakeCli('b', workerScript('B'));
    const judge = await makeFakeCli('judge', reviewerScript('MISSING'));

    const result = await runRoundtable({
      prompt: 'topic',
      clis: [cliA, cliB],
      synthesizerCli: judge,
      workDir: dir,
    });

    expect(result.consensus).toBe(false);
    expect(result.rounds).toHaveLength(2);
  });

  it('round 1 all failed → no review, no synthesis, nothing fabricated', async () => {
    const dir = await makeWorkDir();
    const cliA = await makeFakeCli('a', 'exit 1');
    const judge = await makeFakeCli('judge', reviewerScript('NO'));

    const result = await runRoundtable({
      prompt: 'topic',
      clis: [cliA, cliA],
      synthesizerCli: judge,
      workDir: dir,
    });

    expect(result.rounds).toHaveLength(1);
    expect(result.consensus).toBe(false);
    expect(result.synthesis).toBeNull();

    const events = await readEvents(result.eventsFile);
    expect(events.some((e) => e.role === 'reviewer')).toBe(false);
    expect(events.some((e) => e.role === 'synthesizer')).toBe(false);
  });

  it('round 2 all failed → synthesis falls back to the round-1 answers', async () => {
    const dir = await makeWorkDir();
    const cliA = await makeFakeCli('a', dieOnRevision('A'));
    const cliB = await makeFakeCli('b', dieOnRevision('B'));
    const judge = await makeFakeCli('judge', reviewerScript('NO'));

    const result = await runRoundtable({
      prompt: 'topic',
      clis: [cliA, cliB],
      synthesizerCli: judge,
      workDir: dir,
    });

    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[1].lanes.every((l) => l.outcome === 'failed')).toBe(true);
    expect(result.synthesis).toContain('answer-A');
    expect(result.synthesis).toContain('answer-B');
  });

  it('one lane fails round 1 → the survivor goes straight to synthesis (no debate with nobody)', async () => {
    const dir = await makeWorkDir();
    const cliA = await makeFakeCli('a', 'exit 1');
    const cliB = await makeFakeCli('b', workerScript('B'));
    const judge = await makeFakeCli('judge', reviewerScript('NO'));

    const result = await runRoundtable({
      prompt: 'topic',
      clis: [cliA, cliB],
      synthesizerCli: judge,
      workDir: dir,
    });

    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].lanes.map((l) => l.outcome)).toEqual(['failed', 'success']);
    expect(result.consensus).toBe(false);
    expect(result.synthesis).toContain('answer-B');

    const events = await readEvents(result.eventsFile);
    expect(events.some((e) => e.role === 'reviewer')).toBe(false);
    expect(events.find((e) => e.lane === cliA)?.outcome).toBe('failed');
  });

  it('lanes think in a scratch dir — a rogue lane never writes into workDir', async () => {
    const dir = await makeWorkDir();
    const rogue = await makeFakeCli('rogue', 'echo "rogue output"; echo data > rogue.txt');
    const judge = await makeFakeCli('judge', reviewerScript('YES'));

    const result = await runRoundtable({
      prompt: 'topic',
      clis: [rogue],
      synthesizerCli: judge,
      workDir: dir,
    });

    expect(result.synthesis).toContain('rogue output');
    expect(await readdir(dir)).toEqual(['.modes']);
  });

  it('maxRounds 1: no consensus check, synthesis straight after round 1', async () => {
    const dir = await makeWorkDir();
    const cliA = await makeFakeCli('a', workerScript('A'));
    const cliB = await makeFakeCli('b', workerScript('B'));
    const judge = await makeFakeCli('judge', reviewerScript('YES'));

    const result = await runRoundtable({
      prompt: 'topic',
      clis: [cliA, cliB],
      synthesizerCli: judge,
      workDir: dir,
      maxRounds: 1,
    });

    expect(result.rounds).toHaveLength(1);
    expect(result.consensus).toBe(false);
    const events = await readEvents(result.eventsFile);
    expect(events.some((e) => e.role === 'reviewer')).toBe(false);
    expect(result.synthesis).toContain('answer-A');
  });
});
