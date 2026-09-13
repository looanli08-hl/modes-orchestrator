/**
 * Worker output parser — spec-mvp A2: every lane's final output is collected in a
 * structured form (conclusion + outcome); TUI/session noise never reaches downstream.
 *
 * The worker→coordinator signal is synthesized from "process exit code + stdout parse"
 * (port-spec §1A worker_done row). Quota exhaustion is detected from output patterns
 * because non-interactive CLIs exit non-zero on quota errors just like any failure —
 * the distinction matters for future quota-aware routing (vision: 额度池化).
 */

export interface RawWorkerOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** set by the spawner's kill timer — a killed process gets no reliable exit code */
  timedOut?: boolean;
}

export interface ParsedWorkerResult {
  outcome: 'success' | 'failed' | 'timeout' | 'quota_exhausted';
  /** trimmed final stdout; empty when the lane produced no usable output */
  summary: string;
}

const QUOTA_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /\b429\b/,
  /quota.{0,20}(exceeded|exhausted|depleted)/i,
  /insufficient[_ ]quota/i,
  /usage.?limit/i,
  /额度/,
  /配额/,
];

/** kimi quirk: CLI errors print `error: ...` yet the process still exits 0 */
const LEADING_ERROR_PATTERN = /^\s*error:/i;

/** below this length an exit-0 quota message is an apology, not a deliverable */
const SHORT_QUOTA_ONLY_MAX_CHARS = 300;

export function parseWorkerOutput(raw: RawWorkerOutput): ParsedWorkerResult {
  const summary = raw.stdout.trim();

  if (raw.timedOut) {
    return { outcome: 'timeout', summary };
  }

  const haystack = `${raw.stdout}\n${raw.stderr}`;

  if (raw.exitCode === 0) {
    // Only the head of each stream counts — "error:" mid-output is normal prose.
    if (LEADING_ERROR_PATTERN.test(raw.stdout) || LEADING_ERROR_PATTERN.test(raw.stderr)) {
      return { outcome: 'failed', summary };
    }
    // Exit 0 + quota signature: only believe it when the whole output is a short
    // apology with no deliverable. Substantial output means work happened and the
    // quota mention is topical (three-lane eval: "write a rate limiter" was
    // misjudged as quota_exhausted while the lane had succeeded).
    if (QUOTA_PATTERNS.some((p) => p.test(haystack)) && summary.length < SHORT_QUOTA_ONLY_MAX_CHARS) {
      return { outcome: 'quota_exhausted', summary };
    }
    return { outcome: 'success', summary };
  }

  if (QUOTA_PATTERNS.some((p) => p.test(haystack))) {
    return { outcome: 'quota_exhausted', summary };
  }
  return { outcome: 'failed', summary };
}
