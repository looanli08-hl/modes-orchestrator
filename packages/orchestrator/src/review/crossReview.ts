/**
 * Cross-review — spec-mvp §3 / A3: two lanes' outputs are reviewed, producing an
 * agreed/disagreed verdict plus rationale. A reviewer's verdict is accepted only via
 * an explicit final marker; anything else is "failed" — consensus is never fabricated.
 */

export interface ReviewLaneInput {
  lane: string;
  summary: string;
  diff: string;
}

export interface ReviewPromptInput {
  task: string;
  lanes: ReviewLaneInput[];
}

export interface ReviewVerdict {
  verdict: 'agreed' | 'disagreed' | 'failed';
  rationale: string;
}

const VERDICT_PATTERN = /VERDICT:\s*(AGREE|DISAGREE)\s*$/im;

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const sections = input.lanes
    .map(
      (l) => `=== LANE ${l.lane} ===
Summary: ${l.summary || '(no output)'}

Diff:
${l.diff || '(no changes)'}`
    )
    .join('\n\n');

  return `You are reviewing two independent solutions to the same task. Judge whether both
correctly solve the task; if they disagree in correctness or only one is acceptable, that
is a disagreement.

=== TASK ===
${input.task}

${sections}

=== YOUR VERDICT ===
Explain your reasoning briefly, then end your response with exactly one final line:
VERDICT: AGREE    (both solutions are acceptable)
VERDICT: DISAGREE (solutions differ in correctness or acceptability)`;
}

export function parseReviewVerdict(text: string): ReviewVerdict {
  const match = VERDICT_PATTERN.exec(text);
  if (!match) {
    return { verdict: 'failed', rationale: text.trim() };
  }
  return {
    verdict: match[1].toUpperCase() === 'AGREE' ? 'agreed' : 'disagreed',
    rationale: text.slice(0, match.index).trim(),
  };
}
