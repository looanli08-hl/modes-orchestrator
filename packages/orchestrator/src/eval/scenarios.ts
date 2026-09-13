/**
 * Eval scenarios — the real-CLI end-to-end regression set (and the data source for
 * routing memory). Each scenario runs the full engine pipeline unattended:
 * fan-out → cross-review → auto-pick → merge, against a throwaway git repo.
 *
 * Expectations must describe what the engine actually does, not what we wish it did.
 * When a scenario surfaces an engine bug, fix the engine (separate commit) and then
 * tighten the expectation — never loosen an expectation just to go green.
 *
 * Tiers: "core" is the fast default gate (the original seven); "extended" widens
 * task-type coverage (bug-fix, docs, refactor, N-lane, …) and is run via --all.
 * Naming a scenario id on the CLI always runs it regardless of tier.
 *
 * Scenario "brainstorm-degrade" (N lanes injected with failures) is intentionally NOT
 * here: with real CLIs we cannot force a lane to fail deterministically, and faking a
 * failure would test nothing real. Failure-injection scenarios in general belong to
 * the fake-CLI tests, not this file. Degradation semantics are covered by the
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
  /** cascade: the winner must come from exactly this chain level */
  expectWinnerLevel?: number;
  /** cascade: the chain must stop after exactly this many attempts (early stop = no wasted quota) */
  expectAttempts?: number;
  /**
   * cascade: the run must terminate properly — a winner at any level, or the chain
   * fully exhausted. Fails only when the chain stops early with no winner (engine
   * bug territory). Never asserts which level won.
   */
  expectWinner?: boolean;
}

export interface EvalScenario {
  id: string;
  mode: 'compete' | 'brainstorm' | 'cascade';
  tier: 'core' | 'extended';
  prompt: string;
  /** files to seed into the temp git repo before running (compete, cascade) */
  seedFiles?: Record<string, string>;
  /** compete lane override; defaults to EVAL_LANES (kimi A / qwen B) in runEval */
  lanes?: { lane: string; cli: string }[];
  /** cascade chain override (cheapest first); defaults to EVAL_CHAIN (qwen → kimi) in runEval */
  chain?: { cli: string; timeoutMs?: number }[];
  expect: EvalExpectation;
}

/**
 * Tier-aware scenario selection for the CLI layer. Explicit ids always win and ignore
 * tier; --all returns everything; the default is the core tier (the fast gate).
 */
export function selectScenarios(
  scenarios: EvalScenario[],
  selection: { ids?: string[]; all?: boolean } = {}
): EvalScenario[] {
  const { ids = [], all = false } = selection;
  if (ids.length > 0) return scenarios.filter((s) => ids.includes(s.id));
  if (all) return [...scenarios];
  return scenarios.filter((s) => s.tier === 'core');
}

export const EVAL_SCENARIOS: EvalScenario[] = [
  // ── core tier: the original seven, the fast default gate ──
  {
    id: 'simple-create',
    mode: 'compete',
    tier: 'core',
    prompt: 'Create a file named hello.txt containing exactly one line of text.',
    expect: { minLaneSuccess: 2, maxLaneSuccess: 2, expectReview: true },
  },
  {
    id: 'modify-existing',
    mode: 'compete',
    tier: 'core',
    seedFiles: {
      'index.html': '<!DOCTYPE html>\n<html>\n<head><title>eval</title></head>\n<body>\n<h1>Hello</h1>\n</body>\n</html>\n',
    },
    prompt: 'Add a <footer> element at the end of the <body> in index.html with the text "modes eval".',
    expect: { minLaneSuccess: 2, maxLaneSuccess: 2, expectReview: true },
  },
  {
    id: 'impossible-task',
    mode: 'compete',
    tier: 'core',
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
    tier: 'core',
    // Open-ended enough that two lanes plausibly diverge in quality; we only assert
    // that a review verdict was recorded, never the verdict/pick value itself.
    prompt: 'Write a debounce function in utils.js with JSDoc and a leading-edge option.',
    expect: { expectReview: true },
  },
  {
    id: 'three-lane',
    mode: 'compete',
    tier: 'core',
    // N-lane compete: lane C is kimi's second independent attempt — this validates the
    // N-lane mechanism (fan-out, review pick, gate) with the CLIs we have today; swap
    // in a third vendor's CLI once one joins the pool.
    lanes: [
      { lane: 'A', cli: 'kimi' },
      { lane: 'B', cli: 'qwen' },
      { lane: 'C', cli: 'kimi' },
    ],
    // Open-ended enough that lanes plausibly take different approaches; we only assert
    // the pipeline ran, never which lane wins. The subject deliberately mentions rate
    // limits — it doubles as a regression for the quota-detector false positive fixed
    // on 2026-09-13 (exit-0 lanes with substantial output are no longer misjudged).
    prompt: 'Implement a rate limiter in limiter.js: a sliding-window limiter with configurable capacity and refill interval, exposing a simple allow(key) API.',
    expect: { minLaneSuccess: 2, expectReview: true },
  },
  {
    id: 'brainstorm-basic',
    mode: 'brainstorm',
    tier: 'core',
    prompt:
      'Propose three names for a CLI tool that orchestrates parallel AI coding agents, ' +
      'with a one-line rationale for each.',
    expect: { minLaneSuccess: 2, expectSynthesis: true },
  },
  {
    id: 'cascade-basic',
    mode: 'cascade',
    tier: 'core',
    // Simple enough that the cheap level (qwen) should succeed with a real diff on the
    // first try: the chain must stop at level 1 without spending kimi quota.
    prompt: 'Create a file named hello.txt containing exactly one line of text.',
    expect: { expectWinnerLevel: 1, expectAttempts: 1 },
  },

  // ── extended tier: task-type diversity. Expectations are pipeline assertions
  // (minLaneSuccess / expectReview / expectSynthesis), never a specific lane win and
  // never a specific verdict. Calibrated against the 2026-09-14 real --all run. ──

  {
    id: 'bug-fix',
    mode: 'compete',
    tier: 'extended',
    // Off-by-one by construction: `<= n` yields n+1 entries.
    seedFiles: {
      'fib.js':
        '// Returns the first n Fibonacci numbers: 0, 1, 1, 2, 3, ...\n' +
        'function fibonacci(n) {\n' +
        '  const seq = [];\n' +
        '  let a = 0;\n' +
        '  let b = 1;\n' +
        '  for (let i = 0; i <= n; i++) {\n' +
        '    seq.push(a);\n' +
        '    [a, b] = [b, a + b];\n' +
        '  }\n' +
        '  return seq;\n' +
        '}\n' +
        'module.exports = { fibonacci };\n',
    },
    prompt:
      'fib.js has an off-by-one bug: fibonacci(n) currently returns n+1 numbers. ' +
      'Fix it so fibonacci(n) returns exactly the first n Fibonacci numbers.',
    expect: { minLaneSuccess: 1, expectReview: true },
  },
  {
    id: 'add-tests',
    mode: 'compete',
    tier: 'extended',
    seedFiles: {
      'stringUtils.js':
        'function capitalize(s) {\n' +
        '  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);\n' +
        '}\n' +
        'function reverse(s) {\n' +
        '  return [...s].reverse().join("");\n' +
        '}\n' +
        'function clamp(n, lo, hi) {\n' +
        '  return Math.min(hi, Math.max(lo, n));\n' +
        '}\n' +
        'module.exports = { capitalize, reverse, clamp };\n',
    },
    prompt:
      'Write tests for stringUtils.js in a new file stringUtils.test.js using node:test and node:assert. ' +
      'Cover each exported function with at least two cases.',
    expect: { minLaneSuccess: 1, expectReview: true },
  },
  {
    id: 'refactor-pure',
    mode: 'compete',
    tier: 'extended',
    // IO (readFileSync) and parsing/summing logic are fused in one function.
    seedFiles: {
      'sum.js':
        'const fs = require("node:fs");\n' +
        '// Reads a file of one-number-per-line and returns the total.\n' +
        'function totalFromFile(filePath) {\n' +
        '  const text = fs.readFileSync(filePath, "utf8");\n' +
        '  let sum = 0;\n' +
        '  for (const line of text.split("\\n")) {\n' +
        '    const value = Number(line.trim());\n' +
        '    if (line.trim() !== "" && !Number.isNaN(value)) sum += value;\n' +
        '  }\n' +
        '  return sum;\n' +
        '}\n' +
        'module.exports = { totalFromFile };\n',
    },
    prompt:
      'Refactor sum.js: extract the parsing-and-summing logic into a pure exported function sumNumbers(text), ' +
      'and keep totalFromFile as a thin IO wrapper that calls it.',
    expect: { minLaneSuccess: 1, expectReview: true },
  },
  {
    id: 'write-docs',
    mode: 'compete',
    tier: 'extended',
    seedFiles: {
      'cache.js':
        '// Tiny memoize helper: caches fn results by its first argument.\n' +
        'function memoize(fn) {\n' +
        '  const cache = new Map();\n' +
        '  return (key) => {\n' +
        '    if (!cache.has(key)) cache.set(key, fn(key));\n' +
        '    return cache.get(key);\n' +
        '  };\n' +
        '}\n' +
        'module.exports = { memoize };\n',
    },
    prompt:
      'Write a README.md for this repo documenting the memoize helper in cache.js: ' +
      'what it does, a usage example, and its limitations.',
    expect: { minLaneSuccess: 1, expectReview: true },
  },
  {
    id: 'dark-theme-css',
    mode: 'compete',
    tier: 'extended',
    seedFiles: {
      'index.html':
        '<!DOCTYPE html>\n<html>\n<head><title>notes</title></head>\n' +
        '<body>\n<h1>Notes</h1>\n<ul><li>first</li><li>second</li></ul>\n</body>\n</html>\n',
    },
    prompt:
      'Add a dark theme: create styles.css with dark background and light text styles for the elements in ' +
      'index.html, and link the stylesheet from the <head> of index.html.',
    expect: { minLaneSuccess: 1, expectReview: true },
  },
  {
    id: 'add-config',
    mode: 'compete',
    tier: 'extended',
    seedFiles: {
      'package.json': '{\n  "name": "eval-pkg",\n  "version": "0.1.0",\n  "main": "index.js"\n}\n',
      'index.js': 'console.log("hi");\n',
    },
    prompt:
      'Add a "lint" script to package.json that runs "node --check index.js", ' +
      'and add a .editorconfig file with 2-space indentation settings.',
    expect: { minLaneSuccess: 1, expectReview: true },
  },
  {
    id: 'multi-file',
    mode: 'compete',
    tier: 'extended',
    prompt:
      'Create two files: math.js exporting add(a, b) and subtract(a, b), and main.js that imports both ' +
      'from math.js and prints add(2, 3).',
    expect: { minLaneSuccess: 1, expectReview: true },
  },
  {
    id: 'error-handling',
    mode: 'compete',
    tier: 'extended',
    // No error handling at all: missing file, bad JSON, and non-object payloads all crash.
    seedFiles: {
      'readJson.js':
        'const fs = require("node:fs");\n' +
        'function readJson(filePath) {\n' +
        '  return JSON.parse(fs.readFileSync(filePath, "utf8"));\n' +
        '}\n' +
        'module.exports = { readJson };\n',
    },
    prompt:
      'Harden readJson.js: return null with a console.error message when the file is missing or contains ' +
      'invalid JSON, instead of throwing.',
    expect: { minLaneSuccess: 1, expectReview: true },
  },
  {
    id: 'py-to-js',
    mode: 'compete',
    tier: 'extended',
    seedFiles: {
      'wc.py':
        '"""Count word frequencies on stdin, print top 5."""\n' +
        'import sys\n' +
        'from collections import Counter\n' +
        '\n' +
        'def top_words(text, n=5):\n' +
        '    words = text.lower().split()\n' +
        '    return Counter(words).most_common(n)\n' +
        '\n' +
        'if __name__ == "__main__":\n' +
        '    for word, count in top_words(sys.stdin.read()):\n' +
        '        print(f"{word} {count}")\n',
    },
    prompt: 'Translate wc.py into an equivalent Node.js script wc.js that reads stdin and prints the same output.',
    expect: { minLaneSuccess: 1, expectReview: true },
  },
  {
    id: 'cli-arg-parse',
    mode: 'compete',
    tier: 'extended',
    prompt:
      'Create args.js: a small utility that parses process.argv-style "--key=value" flags into an object ' +
      'and prints it as JSON. Flags without "=" map to true.',
    expect: { minLaneSuccess: 1, expectReview: true },
  },
  {
    id: 'four-lane',
    mode: 'compete',
    tier: 'extended',
    // 4-lane fan-out with the two CLIs we have (each runs twice independently).
    // Open-ended prompt; we assert the pipeline, never which lane wins.
    // minLaneSuccess 3 tolerates one flaky lane out of four.
    lanes: [
      { lane: 'A', cli: 'kimi' },
      { lane: 'B', cli: 'qwen' },
      { lane: 'C', cli: 'kimi' },
      { lane: 'D', cli: 'qwen' },
    ],
    prompt: 'Implement an LRU cache in lru.js with get(key) and set(key, value) and a fixed capacity.',
    expect: { minLaneSuccess: 3, expectReview: true },
  },
  {
    id: 'brainstorm-tech-choice',
    mode: 'brainstorm',
    tier: 'extended',
    // Technology trade-off question.
    prompt:
      'A small team is building a local-first note-taking desktop app. Compare SQLite versus plain Markdown ' +
      'files as the primary store: list the top trade-offs of each and give a recommendation with its conditions.',
    expect: { minLaneSuccess: 1, expectSynthesis: true },
  },
  {
    id: 'brainstorm-positioning',
    mode: 'brainstorm',
    tier: 'extended',
    // Product positioning question.
    prompt:
      'A new terminal emulator wants to stand out against iTerm2, Warp, and Ghostty. Propose three distinct ' +
      'positioning angles, naming the target user for each.',
    expect: { minLaneSuccess: 1, expectSynthesis: true },
  },
  {
    id: 'brainstorm-arch-review',
    mode: 'brainstorm',
    tier: 'extended',
    // Architecture review question (about this very system's shape).
    prompt:
      'Review this architecture: an Electron shell spawns per-task git worktrees where AI CLI workers edit ' +
      'code in parallel, then a reviewer lane cross-reviews their diffs and a human merges the winner. ' +
      'Identify the three biggest risks and one mitigation for each.',
    expect: { minLaneSuccess: 1, expectSynthesis: true },
  },
  {
    id: 'cascade-harder',
    mode: 'cascade',
    tier: 'extended',
    // Harder than cascade-basic; we do NOT assume qwen fails or succeeds — the only
    // honest assertion is proper termination: a winner at some level, or the chain
    // fully exhausted (expectWinner). Which level wins is never asserted.
    prompt:
      'Create utils.js with a deepEqual(a, b) function that compares nested plain objects and arrays by ' +
      'value, ignoring key order.',
    expect: { expectWinner: true },
  },
];
