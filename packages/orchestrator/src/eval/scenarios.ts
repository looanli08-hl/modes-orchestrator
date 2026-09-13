/**
 * Eval scenarios — the real-CLI end-to-end regression set (and the data source for
 * routing memory). Each scenario runs the full engine pipeline unattended:
 * fan-out → cross-review → auto-pick → merge, against a throwaway git repo.
 *
 * Expectations must describe what the engine actually does, not what we wish it did.
 * When a scenario surfaces an engine bug, fix the engine (separate commit) and then
 * tighten the expectation — never loosen an expectation just to go green.
 *
 * Scenario "brainstorm-degrade" (N lanes injected with failures) is intentionally NOT
 * here: with real CLIs we cannot force a lane to fail deterministically, and faking a
 * failure would test nothing real. Degradation semantics are covered by the
 * integration tests (tests/run-task.integration.test.ts, tests/brainstorm.integration.test.ts).
 */

export interface EvalExpectation {
  /** at least this many lanes must end with outcome "success" */
  minLaneSuccess?: number;
  /** at most this many lanes may end with outcome "success" */
  maxLaneSuccess?: number;
  /** compete: a cross-review verdict must exist (requires >= 1 successful lane) */
  expectReview?: boolean;
  /** brainstorm: a synthesis must exist (requires >= 1 successful lane) */
  expectSynthesis?: boolean;
}

export interface EvalScenario {
  id: string;
  mode: 'compete' | 'brainstorm';
  prompt: string;
  /** files to seed into the temp git repo before running (compete) */
  seedFiles?: Record<string, string>;
  expect: EvalExpectation;
}

export const EVAL_SCENARIOS: EvalScenario[] = [
  {
    id: 'simple-create',
    mode: 'compete',
    prompt: 'Create a file named hello.txt containing exactly one line of text.',
    expect: { minLaneSuccess: 2, maxLaneSuccess: 2, expectReview: true },
  },
  {
    id: 'modify-existing',
    mode: 'compete',
    seedFiles: {
      'index.html': '<!DOCTYPE html>\n<html>\n<head><title>eval</title></head>\n<body>\n<h1>Hello</h1>\n</body>\n</html>\n',
    },
    prompt: 'Add a <footer> element at the end of the <body> in index.html with the text "modes eval".',
    expect: { minLaneSuccess: 2, maxLaneSuccess: 2, expectReview: true },
  },
  {
    id: 'impossible-task',
    mode: 'compete',
    // The service host is an .invalid TLD (RFC 2606): unresolvable by construction,
    // so no lane can fetch it. The instruction "make no changes" targets an empty diff.
    prompt:
      'Fetch the JSON health status from http://metrics.corp.invalid/api/health and save it to health.json. ' +
      'If the service is unreachable, make no changes to any file — just report that it is unreachable.',
    // Calibrated from the 2026-09-13 real run (evals/eval-runs.jsonl): both lanes exit 0
    // with an "unreachable" explanation and write nothing — the engine records them as
    // successful (outcome is process-based, not diff-based) and reviews two empty diffs.
    // The auto-picked lane's merge is then a git no-op, which runEval asserts accordingly.
    expect: { minLaneSuccess: 2, maxLaneSuccess: 2, expectReview: true },
  },
  {
    id: 'review-disagree',
    mode: 'compete',
    // Open-ended enough that two lanes plausibly diverge in quality; we only assert
    // that a review verdict was recorded, never the verdict/pick value itself.
    prompt: 'Write a debounce function in utils.js with JSDoc and a leading-edge option.',
    expect: { expectReview: true },
  },
  {
    id: 'brainstorm-basic',
    mode: 'brainstorm',
    prompt:
      'Propose three names for a CLI tool that orchestrates parallel AI coding agents, ' +
      'with a one-line rationale for each.',
    expect: { minLaneSuccess: 2, expectSynthesis: true },
  },
];
