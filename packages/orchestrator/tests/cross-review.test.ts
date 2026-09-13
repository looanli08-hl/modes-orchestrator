/**
 * Unit test: cross-review prompt + verdict parser (spec-mvp A3, port-spec §2B review lane)
 * Pinned behavior: two lanes' outputs go into one review prompt; the reviewer's verdict
 * is parsed into agreed | disagreed | failed. A missing/malformed verdict marker is
 * "failed" — never silently treated as agreement (不伪造共识).
 */

import { describe, expect, it } from 'vitest';

import { buildReviewPrompt, parseReviewVerdict } from '../src/review/crossReview';

const lanes = [
  { lane: 'A', summary: 'implemented parser with regex', diff: 'diff --git a/p.ts ...' },
  { lane: 'B', summary: 'implemented parser with a hand-rolled scanner', diff: 'diff --git a/p.ts ...' },
];

describe('buildReviewPrompt: both lanes presented for judgment', () => {
  it('contains the original task, both lane outputs, and the verdict marker instruction', () => {
    const prompt = buildReviewPrompt({ task: 'implement a JSON parser', lanes });

    expect(prompt).toContain('implement a JSON parser');
    expect(prompt).toContain('implemented parser with regex');
    expect(prompt).toContain('hand-rolled scanner');
    expect(prompt).toContain('VERDICT:');
  });
});

describe('parseReviewVerdict: marker-driven, never fabricates consensus', () => {
  it('VERDICT: AGREE → agreed, rationale preserved', () => {
    const result = parseReviewVerdict('Both solutions parse JSON correctly.\nVERDICT: AGREE');
    expect(result.verdict).toBe('agreed');
    expect(result.rationale).toContain('Both solutions');
  });

  it('VERDICT: DISAGREE → disagreed', () => {
    const result = parseReviewVerdict('Lane B misses nested arrays.\nVERDICT: DISAGREE');
    expect(result.verdict).toBe('disagreed');
  });

  it('marker is case-insensitive and tolerates whitespace', () => {
    expect(parseReviewVerdict('verdict:   agree').verdict).toBe('agreed');
  });

  it.each(['The reviewer gave no marker at all', 'VERDICT: MAYBE', ''])(
    'missing or malformed marker → failed (not agreement): %j',
    (text) => {
      expect(parseReviewVerdict(text).verdict).toBe('failed');
    }
  );
});
