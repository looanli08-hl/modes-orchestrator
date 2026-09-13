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

  it('also asks for a quality PICK marker (A/B/TIE) — 2026-09-13 quality-recommendation amendment', () => {
    const prompt = buildReviewPrompt({ task: 'implement a JSON parser', lanes });
    expect(prompt).toContain('PICK:');
    expect(prompt).toContain('TIE');
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

describe('parseReviewVerdict: PICK marker — quality recommendation, never fabricated', () => {
  it('PICK: A / B parsed from the review', () => {
    expect(parseReviewVerdict('A is more complete.\nVERDICT: AGREE\nPICK: A').pick).toBe('A');
    expect(parseReviewVerdict('B is cleaner.\nVERDICT: DISAGREE\nPICK: B').pick).toBe('B');
  });

  it('PICK: TIE → tie', () => {
    expect(parseReviewVerdict('Identical quality.\nVERDICT: AGREE\nPICK: TIE').pick).toBe('tie');
  });

  it('case-insensitive and whitespace-tolerant', () => {
    expect(parseReviewVerdict('VERDICT: AGREE\npick:  b').pick).toBe('B');
  });

  it.each([
    ['missing PICK', 'VERDICT: AGREE'],
    ['malformed PICK', 'VERDICT: AGREE\nPICK: C'],
    ['empty', ''],
  ])('%s → pick is null (a recommendation is never invented)', (_label, text) => {
    expect(parseReviewVerdict(text).pick).toBeNull();
  });

  it('PICK never rescues a malformed VERDICT — verdict failed stays failed', () => {
    const result = parseReviewVerdict('PICK: A');
    expect(result.verdict).toBe('failed');
    expect(result.pick).toBe('A');
  });
});
