/**
 * abQuality unit tests — the blind A/B harness with injected fake deps (no real CLIs).
 * Covers: WINNER marker parsing (X/Y/TIE/missing/malformed/last-marker-wins), X/Y→arm
 * mapping across the swapped order, the two-judgment aggregation (agreeing win /
 * disagreement → unstable / double tie / undecidable never fabricated into a win),
 * arm-failure handling, and summary counting. No test asserts that a particular arm
 * "should" win — the fixtures script the judge, they don't endorse an outcome.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AB_QUESTIONS,
  aggregateJudgments,
  mapPickToArm,
  parseJudgePick,
  runAbQuality,
  summarizeAbResults,
  type AbQualityDeps,
  type AbQuestion,
} from '../src/eval/abQuality';
import type { RoundtableResult } from '../src/patterns/roundtable';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeWorkDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-ab-test-'));
  tempDirs.push(dir);
  return dir;
}

const QUESTION: AbQuestion = { id: 'q1', question: '测试题：选 A 还是选 B？' };

const JUDGE_MARKER = '=== YOUR VERDICT ===';

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

function fail() {
  return { exitCode: 1, stdout: '', stderr: 'boom', timedOut: false };
}

/**
 * fake spawnProcess: judge calls (prompt contains the verdict marker) answer from a
 * scripted queue; the single-arm call returns a fixed answer.
 */
function makeDeps(config: {
  judgeOutputs: string[];
  singleAnswer?: string;
  singleFails?: boolean;
  roundtable?: Partial<RoundtableResult>;
}): { deps: AbQualityDeps; judgePrompts: string[] } {
  const judgePrompts: string[] = [];
  let judgeCall = 0;
  return {
    judgePrompts,
    deps: {
      async spawnProcess(_cli, args) {
        const prompt = args[args.length - 1];
        if (prompt.includes(JUDGE_MARKER)) {
          judgePrompts.push(prompt);
          const output = config.judgeOutputs[judgeCall] ?? 'WINNER: TIE';
          judgeCall += 1;
          return ok(output);
        }
        if (config.singleFails) return fail();
        return ok(config.singleAnswer ?? 'single answer text');
      },
      async runRoundtable(options) {
        return {
          taskId: 'task-fake',
          rounds: [
            {
              round: 1,
              lanes: [
                { cli: 'kimi', outcome: 'success', answer: 'kimi answer' },
                { cli: 'qwen', outcome: 'success', answer: 'qwen answer' },
              ],
            },
          ],
          consensus: false,
          synthesis: 'synthesis text',
          eventsFile: path.join(options.workDir, '.modes', 'events.jsonl'),
          ...config.roundtable,
        };
      },
    },
  };
}

describe('parseJudgePick', () => {
  it('parses X, Y and TIE markers', () => {
    expect(parseJudgePick('some reasoning\nWINNER: X')).toBe('X');
    expect(parseJudgePick('理由略\nWINNER: Y')).toBe('Y');
    expect(parseJudgePick('both fine\nWINNER: TIE')).toBe('TIE');
  });

  it('is case-insensitive about the marker and value', () => {
    expect(parseJudgePick('winner: x')).toBe('X');
    expect(parseJudgePick('Winner: Tie')).toBe('TIE');
  });

  it('returns INVALID on a missing marker', () => {
    expect(parseJudgePick('I think X is better but I forgot the marker')).toBe('INVALID');
  });

  it('returns INVALID on a malformed marker', () => {
    expect(parseJudgePick('WINNER: both are good')).toBe('INVALID');
    expect(parseJudgePick('WINNER:X Y')).toBe('INVALID');
    expect(parseJudgePick('WINNER:')).toBe('INVALID');
  });

  it('takes the last marker when the judge quotes the format while reasoning', () => {
    const text = 'The format is WINNER: X or WINNER: Y.\nAfter thinking: WINNER: Y';
    expect(parseJudgePick(text)).toBe('Y');
  });
});

describe('mapPickToArm', () => {
  const straight = { X: 'single', Y: 'roundtable' } as const;
  const swapped = { X: 'roundtable', Y: 'single' } as const;

  it('maps X/Y through the given mapping', () => {
    expect(mapPickToArm('X', straight)).toBe('single');
    expect(mapPickToArm('Y', straight)).toBe('roundtable');
    expect(mapPickToArm('X', swapped)).toBe('roundtable');
    expect(mapPickToArm('Y', swapped)).toBe('single');
  });

  it('maps TIE and INVALID without touching the mapping', () => {
    expect(mapPickToArm('TIE', swapped)).toBe('tie');
    expect(mapPickToArm('INVALID', swapped)).toBe('undecidable');
  });

  it('a judge that always picks X splits between the arms when the order swaps', () => {
    // positional bias cancels out: X-first means single then roundtable — no fake winner
    expect(mapPickToArm('X', straight)).not.toBe(mapPickToArm('X', swapped));
  });
});

describe('aggregateJudgments', () => {
  it('counts a win only when both judgments name the same arm', () => {
    expect(aggregateJudgments('roundtable', 'roundtable')).toBe('roundtable');
    expect(aggregateJudgments('single', 'single')).toBe('single');
  });

  it('double tie is a tie', () => {
    expect(aggregateJudgments('tie', 'tie')).toBe('tie');
  });

  it('opposite winners are unstable (position bias cancels out)', () => {
    expect(aggregateJudgments('single', 'roundtable')).toBe('unstable');
    expect(aggregateJudgments('roundtable', 'single')).toBe('unstable');
  });

  it('winner vs tie is unstable', () => {
    expect(aggregateJudgments('single', 'tie')).toBe('unstable');
    expect(aggregateJudgments('tie', 'roundtable')).toBe('unstable');
  });

  it('any undecidable judgment makes the question unstable — never a fabricated win', () => {
    expect(aggregateJudgments('single', 'undecidable')).toBe('unstable');
    expect(aggregateJudgments('undecidable', 'roundtable')).toBe('unstable');
    expect(aggregateJudgments('undecidable', 'undecidable')).toBe('unstable');
    expect(aggregateJudgments('tie', 'undecidable')).toBe('unstable');
  });
});

describe('runAbQuality', () => {
  it('a consistent scripted judge produces a win for the mapped arm', async () => {
    // judge says X wins both times; with the order swapped that is a genuine single-arm win
    const { deps, judgePrompts } = makeDeps({ judgeOutputs: ['WINNER: X', 'WINNER: Y'] });
    const results = await runAbQuality([QUESTION], deps, { workDir: await makeWorkDir() });
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.status).toBe('ok');
    expect(r.winner).toBe('single');
    expect(r.judgments.map((j) => j.mapped)).toEqual(['single', 'single']);
    expect(judgePrompts).toHaveLength(2);
  });

  it('swaps the X/Y order between the two judge calls', async () => {
    const { deps } = makeDeps({ judgeOutputs: ['WINNER: X', 'WINNER: X'] });
    const [r] = await runAbQuality([QUESTION], deps, { workDir: await makeWorkDir() });
    expect(r.judgments[0].mapping).toEqual({ X: 'single', Y: 'roundtable' });
    expect(r.judgments[1].mapping).toEqual({ X: 'roundtable', Y: 'single' });
    // same positional pick (X both times) under swapped order = opposite arms = unstable
    expect(r.judgments.map((j) => j.mapped)).toEqual(['single', 'roundtable']);
    expect(r.winner).toBe('unstable');
  });

  it('the judge sees the answers anonymized — arm names never appear in the prompt', async () => {
    const { deps, judgePrompts } = makeDeps({ judgeOutputs: ['WINNER: TIE', 'WINNER: TIE'] });
    await runAbQuality([QUESTION], deps, { workDir: await makeWorkDir() });
    for (const prompt of judgePrompts) {
      expect(prompt).toContain('ANSWER X');
      expect(prompt).toContain('ANSWER Y');
      // the answers themselves appear, but never labeled by arm or CLI name
      expect(prompt).toContain('single answer text');
      expect(prompt).toContain('synthesis text');
      expect(prompt).not.toMatch(/roundtable|kimi|qwen/i);
    }
  });

  it('a malformed marker is recorded as undecidable, not credited to a side', async () => {
    const { deps } = makeDeps({ judgeOutputs: ['WINNER: X', 'I forgot the marker entirely'] });
    const [r] = await runAbQuality([QUESTION], deps, { workDir: await makeWorkDir() });
    expect(r.judgments[1].pick).toBe('INVALID');
    expect(r.judgments[1].mapped).toBe('undecidable');
    expect(r.winner).toBe('unstable');
  });

  it('double TIE judges make a tie', async () => {
    const { deps } = makeDeps({ judgeOutputs: ['WINNER: TIE', 'WINNER: TIE'] });
    const [r] = await runAbQuality([QUESTION], deps, { workDir: await makeWorkDir() });
    expect(r.winner).toBe('tie');
  });

  it('an arm failure skips judging and is recorded honestly', async () => {
    const { deps, judgePrompts } = makeDeps({ judgeOutputs: [], singleFails: true });
    const [r] = await runAbQuality([QUESTION], deps, { workDir: await makeWorkDir() });
    expect(r.status).toBe('arm_failed');
    expect(r.winner).toBeNull();
    expect(r.judgments).toEqual([]);
    expect(judgePrompts).toHaveLength(0);
    expect(r.failures.some((f) => f.includes('single arm'))).toBe(true);
  });

  it('a roundtable without synthesis falls back to the surviving answers', async () => {
    const { deps, judgePrompts } = makeDeps({
      judgeOutputs: ['WINNER: Y', 'WINNER: X'],
      roundtable: { synthesis: null },
    });
    const [r] = await runAbQuality([QUESTION], deps, { workDir: await makeWorkDir() });
    expect(r.status).toBe('ok');
    expect(r.roundtableAnswer).toContain('kimi answer');
    expect(r.roundtableAnswer).toContain('qwen answer');
    expect(judgePrompts[0]).toContain('kimi answer');
  });

  it('a wiped-out roundtable is an arm failure, not an empty-answer judgment', async () => {
    const { deps, judgePrompts } = makeDeps({
      judgeOutputs: [],
      roundtable: {
        synthesis: null,
        rounds: [
          {
            round: 1,
            lanes: [
              { cli: 'kimi', outcome: 'failed', answer: '' },
              { cli: 'qwen', outcome: 'failed', answer: '' },
            ],
          },
        ],
      },
    });
    const [r] = await runAbQuality([QUESTION], deps, { workDir: await makeWorkDir() });
    expect(r.status).toBe('arm_failed');
    expect(judgePrompts).toHaveLength(0);
  });
});

describe('summarizeAbResults', () => {
  it('counts winners, ties, unstable and arm failures', async () => {
    const script: Record<string, { judge: string[]; singleFails?: boolean }> = {
      winR: { judge: ['WINNER: Y', 'WINNER: X'] }, // roundtable both times (order swapped)
      winS: { judge: ['WINNER: X', 'WINNER: Y'] }, // single both times
      tie: { judge: ['WINNER: TIE', 'WINNER: TIE'] },
      unstable: { judge: ['WINNER: X', 'WINNER: X'] }, // positional pick = opposite arms
      broken: { judge: [], singleFails: true },
    };
    // each question embeds its id so the fake spawner can find its script
    const questions: AbQuestion[] = Object.keys(script).map((id) => ({ id, question: `q:${id} 题目` }));
    const base = makeDeps({ judgeOutputs: [] });
    const deps: AbQualityDeps = {
      runRoundtable: base.deps.runRoundtable,
      async spawnProcess(_cli, args) {
        const prompt = args[args.length - 1];
        const id = Object.keys(script).find((k) => prompt.includes(`q:${k}`))!;
        if (prompt.includes(JUDGE_MARKER)) {
          return ok(script[id].judge.shift() ?? 'WINNER: TIE');
        }
        return script[id].singleFails ? fail() : ok('single answer');
      },
    };
    const results = await runAbQuality(questions, deps, { workDir: await makeWorkDir() });
    const totals = summarizeAbResults(results);
    expect(totals).toEqual({ single: 1, roundtable: 1, tie: 1, unstable: 1, armFailed: 1 });
  });
});

describe('AB_QUESTIONS', () => {
  it('ships six decision questions with unique ids', () => {
    expect(AB_QUESTIONS).toHaveLength(6);
    expect(new Set(AB_QUESTIONS.map((q) => q.id)).size).toBe(6);
    for (const q of AB_QUESTIONS) {
      expect(q.question.length).toBeGreaterThan(0);
    }
  });
});
