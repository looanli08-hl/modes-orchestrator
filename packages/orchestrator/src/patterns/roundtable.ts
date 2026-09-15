/**
 * Roundtable pattern (spec-mvp §2.5) — 多 CLI 多轮交叉可见的真协作, brainstorm 的多轮进化.
 * Round 1: every CLI answers in parallel with brainstorm's scratch-dir isolation
 * (thinking produces text, not commits — no worktrees, no merge). A reviewer lane
 * then judges substantive consensus over the round-1 answers via a CONSENSUS: YES|NO
 * marker — a missing/malformed marker is NO (consensus is never fabricated, the
 * debate continues). Consensus → early stop. Otherwise round 2: each surviving lane
 * sees its own answer and its peers', critiques them, and revises. Synthesis combines
 * the last round's survivors, falling back to the round-1 answers when the final
 * round wiped out (手里有货就不浪费). All of round 1 failed → no review, no synthesis
 * (hermes 全失败跳过合成). A single round-1 survivor skips the debate — there is
 * nobody to cross-see — and goes straight to synthesis.
 */

import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

import { makeRealDeps } from '../fanout/realDeps';
import { parseWorkerOutput } from '../parse/workerOutput';
import { EVENT_LOG_SCHEMA_VERSION, type EventLogOutcome } from '../schema/eventLog';
import { buildWorkerArgs } from '../spawn/cliAdapters';
import type { LaneStream } from '../spawn/laneStream';
import { resolveModelId } from '../spawn/modelResolution';
import { appendEvent } from '../store/eventLogStore';

export interface RoundtableOptions {
  prompt: string;
  /** the "employees" at the table — one lane per CLI */
  clis: string[];
  /** cwd for the lane processes (no repo required) */
  workDir: string;
  /** total rounds including round 1 (default 2); the debate stops earlier on consensus */
  maxRounds?: number;
  /** CLI that judges consensus and synthesizes; defaults to the first cli */
  synthesizerCli?: string;
  timeoutMs?: number;
  taskType?: string;
  /** optional per-task lane output sink — lanes' stdout/stderr stream into it live */
  stream?: LaneStream;
}

export interface RoundtableLaneResult {
  cli: string;
  outcome: EventLogOutcome;
  answer: string;
}

export interface RoundtableRound {
  round: number;
  lanes: RoundtableLaneResult[];
}

export interface RoundtableResult {
  taskId: string;
  rounds: RoundtableRound[];
  /** the reviewer judged the round-1 answers substantively identical → early stop */
  consensus: boolean;
  /** null when every round-1 lane failed — synthesis is never fabricated */
  synthesis: string | null;
  eventsFile: string;
}

const CONSENSUS_PATTERN = /CONSENSUS:\s*(YES|NO)\s*$/im;

/** true only on an explicit final-line YES; a missing/malformed marker is NO — consensus is never fabricated */
export function parseConsensus(text: string): boolean {
  return CONSENSUS_PATTERN.exec(text)?.[1].toUpperCase() === 'YES';
}

function buildConsensusPrompt(prompt: string, answers: RoundtableLaneResult[]): string {
  return `${answers.length} participants answered the same question independently. Judge whether they
have reached SUBSTANTIVE consensus: same core position and same key conclusions, even if
wording and emphasis differ. Different recommendations or contradictory reasoning is NO.

=== QUESTION ===
${prompt}

${answers.map((l) => `=== ANSWER (${l.cli}) ===\n${l.answer}`).join('\n\n')}

=== YOUR VERDICT ===
Explain your reasoning briefly, then end your response with exactly one final line:
CONSENSUS: YES  (substantively the same position)  |  CONSENSUS: NO  (real differences remain)`;
}

function buildRevisionPrompt(
  prompt: string,
  own: RoundtableLaneResult,
  peers: RoundtableLaneResult[]
): string {
  return `You are at a roundtable. This was your previous answer, followed by your peers' answers
to the same question. Point out the problems in the others' answers, absorb their strengths,
and give your revised answer.

=== QUESTION ===
${prompt}

=== YOUR PREVIOUS ANSWER ===
${own.answer}

${peers.map((l) => `=== PEER ANSWER (${l.cli}) ===\n${l.answer}`).join('\n\n')}

=== YOUR REVISED ANSWER ===`;
}

function buildSynthesisPrompt(prompt: string, rounds: number, answers: RoundtableLaneResult[]): string {
  const discussed =
    rounds > 1
      ? ` These are their revised positions after ${rounds} rounds of discussion, where they saw and critiqued each other's answers.`
      : '';
  return `Below are ${answers.length} answers to the same question.${discussed}
Synthesize them: keep the diversity (what only one answer saw), resolve conflicts explicitly,
and produce a combined answer better than any single one.

=== QUESTION ===
${prompt}

${answers.map((l) => `=== ANSWER (${l.cli}) ===\n${l.answer}`).join('\n\n')}

=== YOUR SYNTHESIS ===`;
}

export async function runRoundtable(options: RoundtableOptions): Promise<RoundtableResult> {
  const taskId = `task-${Date.now().toString(36)}`;
  const eventsFile = path.join(options.workDir, '.modes', 'events.jsonl');
  await mkdir(path.dirname(eventsFile), { recursive: true });
  const deps = makeRealDeps(options.workDir, { taskId, timeoutMs: options.timeoutMs, stream: options.stream });
  // Physical isolation: lanes think in a scratch dir so a rogue worker can never write
  // into the user's workDir (same lesson as brainstorm)
  const scratchDir = await mkdtemp(path.join(os.tmpdir(), 'modes-roundtable-lanes-'));

  const maxRounds = Math.max(1, options.maxRounds ?? 2);
  const synthesizerCli = options.synthesizerCli ?? options.clis[0];
  const taskType = options.taskType ?? 'roundtable';

  const logEvent = async (
    lane: string,
    attemptId: string,
    cli: string,
    role: 'worker' | 'reviewer' | 'synthesizer',
    outcome: EventLogOutcome,
    started: number
  ): Promise<void> => {
    await appendEvent(eventsFile, {
      schema_version: EVENT_LOG_SCHEMA_VERSION,
      task_id: taskId,
      lane,
      attempt_id: attemptId,
      task_type: taskType,
      model: resolveModelId(cli),
      provider: cli,
      role,
      outcome,
      score: null,
      cost: null,
      latency: Date.now() - started,
      verifier: role === 'worker' ? 'process' : cli,
      ts: new Date().toISOString(),
    });
  };

  /** one parallel round; the round number is encoded in attempt_id (JSONL has no attempt_seq field) */
  const runRound = async (
    round: number,
    participants: RoundtableLaneResult[],
    promptFor: (cli: string) => string
  ): Promise<RoundtableRound> => {
    const lanes = await Promise.all(
      participants.map(async ({ cli }): Promise<RoundtableLaneResult> => {
        const started = Date.now();
        const raw = await deps.spawnProcess(cli, buildWorkerArgs(cli, promptFor(cli)), { cwd: scratchDir, lane: cli });
        const parsed = parseWorkerOutput(raw);
        // oxlint-disable-next-line no-await-in-loop -- append-only log: writes must stay ordered
        await logEvent(cli, `${taskId}-${cli}-r${round}`, cli, 'worker', parsed.outcome, started);
        return { cli, outcome: parsed.outcome, answer: parsed.summary };
      })
    );
    return { round, lanes };
  };

  try {
    const rounds: RoundtableRound[] = [];
    let consensus = false;
    let survivors = options.clis.map((cli) => ({ cli, outcome: 'success' as EventLogOutcome, answer: '' }));

    for (let round = 1; round <= maxRounds; round++) {
      const previous = rounds[rounds.length - 1];
      // oxlint-disable-next-line no-await-in-loop -- serial rounds: each round is built from the previous one
      const current = await runRound(round, survivors, (cli) => {
        if (round === 1) return options.prompt;
        const own = previous.lanes.find((l) => l.cli === cli)!;
        const peers = previous.lanes.filter((l) => l.cli !== cli && l.outcome === 'success');
        return buildRevisionPrompt(options.prompt, own, peers);
      });
      rounds.push(current);
      survivors = current.lanes.filter((l) => l.outcome === 'success');

      // Consensus review: only while another round remains and there is a debate to
      // settle (a single survivor has nobody to cross-see; zero survivors is hermes
      // territory — no review, no synthesis).
      if (round === maxRounds || survivors.length < 2) break;
      const started = Date.now();
      // oxlint-disable-next-line no-await-in-loop -- serial: the verdict decides whether the next round runs
      const raw = await deps.spawnProcess(
        synthesizerCli,
        buildWorkerArgs(synthesizerCli, buildConsensusPrompt(options.prompt, survivors)),
        { cwd: scratchDir, lane: `consensus-r${round}` }
      );
      const parsed = parseWorkerOutput(raw);
      // oxlint-disable-next-line no-await-in-loop -- append-only log: writes must stay ordered
      await logEvent(synthesizerCli, `${taskId}-consensus-r${round}`, synthesizerCli, 'reviewer', parsed.outcome, started);
      if (parsed.outcome === 'success' && parseConsensus(parsed.summary)) {
        consensus = true;
        break;
      }
    }

    // Synthesis input: the last round's survivors, falling back to the round-1 answers
    // when the final round wiped out (手里有货就不浪费).
    const lastRound = rounds[rounds.length - 1];
    let finalAnswers = lastRound.lanes.filter((l) => l.outcome === 'success');
    if (finalAnswers.length === 0 && rounds.length > 1) {
      finalAnswers = rounds[0].lanes.filter((l) => l.outcome === 'success');
    }

    let synthesis: string | null = null;
    if (finalAnswers.length > 0) {
      const started = Date.now();
      const raw = await deps.spawnProcess(
        synthesizerCli,
        buildWorkerArgs(synthesizerCli, buildSynthesisPrompt(options.prompt, rounds.length, finalAnswers)),
        { cwd: scratchDir, lane: 'synthesis' }
      );
      const parsed = parseWorkerOutput(raw);
      if (parsed.outcome === 'success') {
        synthesis = parsed.summary;
      }
      await logEvent('synthesis', `${taskId}-synthesis-1`, synthesizerCli, 'synthesizer', parsed.outcome, started);
    }

    return { taskId, rounds, consensus, synthesis, eventsFile };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
