/**
 * Cross-review — spec-mvp §3 / A3: the lanes' outputs are reviewed, producing a
 * correctness verdict (agreed/disagreed/failed) plus a quality recommendation
 * (pick: a lane letter / tie). Both are marker-driven; a missing/malformed VERDICT
 * is "failed" and a missing/malformed/out-of-lanes PICK is null — consensus and
 * recommendations are never fabricated. (PICK added 2026-09-13 after the parrot-bike
 * case proved that "both correct" says nothing about which is better; generalized
 * from A/B to N lanes the same day.)
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
  /** quality recommendation: an uppercase lane letter or "tie"; null when the reviewer gave no usable PICK marker */
  pick: string | null;
  rationale: string;
}

const VERDICT_PATTERN = /VERDICT:\s*(AGREE|DISAGREE)\s*$/im;
const PICK_PATTERN = /PICK:\s*([A-Z]|TIE)\s*$/im;

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const sections = input.lanes
    .map(
      (l) => `=== LANE ${l.lane} ===
Summary: ${l.summary || '(no output)'}

Diff:
${l.diff || '(no changes)'}`
    )
    .join('\n\n');

  const two = input.lanes.length === 2;
  const laneCount = two ? 'two' : String(input.lanes.length);
  const pickOptions = input.lanes.map((l) => `PICK: ${l.lane}`).join('  |  ');

  return `You are reviewing ${laneCount} independent solutions to the same task. Judge on two axes:
1. Correctness: do ${two ? 'both' : 'all'} solve the task? If they disagree in correctness or only ${two ? 'one is' : 'some are'}
   acceptable, that is a disagreement.
2. Quality: which solution is better overall (completeness, craft, robustness)?

=== TASK ===
${input.task}

${sections}

=== YOUR VERDICT ===
Explain your reasoning briefly, then end your response with exactly these two final lines:
VERDICT: AGREE    (${two ? 'both' : 'all'} solutions are acceptable)  |  VERDICT: DISAGREE (they differ in correctness)
${pickOptions}  |  PICK: TIE   (which is better quality; TIE only if genuinely indistinguishable)`;
}

export function parseReviewVerdict(text: string, knownLanes?: string[]): ReviewVerdict {
  const verdictMatch = VERDICT_PATTERN.exec(text);
  const pickMatch = PICK_PATTERN.exec(text);
  const rationale = text.slice(0, verdictMatch?.index ?? pickMatch?.index ?? text.length).trim();

  let pick: string | null = null;
  if (pickMatch) {
    const raw = pickMatch[1].toUpperCase();
    // a PICK naming a lane that is not in this run is unusable — same treatment as a
    // missing marker: never fabricate a recommendation
    if (raw === 'TIE') pick = 'tie';
    else if (!knownLanes || knownLanes.includes(raw)) pick = raw;
  }

  return {
    verdict: !verdictMatch ? 'failed' : verdictMatch[1].toUpperCase() === 'AGREE' ? 'agreed' : 'disagreed',
    pick,
    rationale,
  };
}
