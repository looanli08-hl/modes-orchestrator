/**
 * Cross-review — spec-mvp §3 / A3: two lanes' outputs are reviewed, producing a
 * correctness verdict (agreed/disagreed/failed) plus a quality recommendation
 * (pick: A/B/tie). Both are marker-driven; a missing/malformed VERDICT is "failed"
 * and a missing/malformed PICK is null — consensus and recommendations are never
 * fabricated. (PICK added 2026-09-13 after the parrot-bike case proved that
 * "both correct" says nothing about which is better.)
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
  /** quality recommendation; null when the reviewer gave no usable PICK marker */
  pick: 'A' | 'B' | 'tie' | null;
  rationale: string;
}

const VERDICT_PATTERN = /VERDICT:\s*(AGREE|DISAGREE)\s*$/im;
const PICK_PATTERN = /PICK:\s*(A|B|TIE)\s*$/im;

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const sections = input.lanes
    .map(
      (l) => `=== LANE ${l.lane} ===
Summary: ${l.summary || '(no output)'}

Diff:
${l.diff || '(no changes)'}`
    )
    .join('\n\n');

  return `You are reviewing two independent solutions to the same task. Judge on two axes:
1. Correctness: do both solve the task? If they disagree in correctness or only one is
   acceptable, that is a disagreement.
2. Quality: which solution is better overall (completeness, craft, robustness)?

=== TASK ===
${input.task}

${sections}

=== YOUR VERDICT ===
Explain your reasoning briefly, then end your response with exactly these two final lines:
VERDICT: AGREE    (both solutions are acceptable)  |  VERDICT: DISAGREE (they differ in correctness)
PICK: A  |  PICK: B  |  PICK: TIE   (which is better quality; TIE only if genuinely indistinguishable)`;
}

export function parseReviewVerdict(text: string): ReviewVerdict {
  const verdictMatch = VERDICT_PATTERN.exec(text);
  const pickMatch = PICK_PATTERN.exec(text);
  const rationale = text.slice(0, verdictMatch?.index ?? pickMatch?.index ?? text.length).trim();

  return {
    verdict: !verdictMatch ? 'failed' : verdictMatch[1].toUpperCase() === 'AGREE' ? 'agreed' : 'disagreed',
    pick: !pickMatch ? null : pickMatch[1].toUpperCase() === 'TIE' ? 'tie' : (pickMatch[1].toUpperCase() as 'A' | 'B'),
    rationale,
  };
}
