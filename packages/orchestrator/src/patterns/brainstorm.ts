/**
 * Brainstorm pattern (spec-mvp §2.5) — 思考型任务: N lanes answer in parallel with no
 * worktrees and no merge (thinking produces text, not commits); a synthesizer lane then
 * combines the diversity. No gate, no pick — the human reads the full set. All lanes
 * failed → synthesis is skipped, never fabricated (hermes "全失败跳过合成").
 */

import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

import { makeRealDeps } from '../fanout/realDeps';
import { parseWorkerOutput } from '../parse/workerOutput';
import { EVENT_LOG_SCHEMA_VERSION, type EventLogOutcome } from '../schema/eventLog';
import { buildWorkerArgs } from '../spawn/cliAdapters';
import { appendEvent } from '../store/eventLogStore';

export interface BrainstormLane {
  lane: string;
  cli: string;
}

export interface BrainstormOptions {
  prompt: string;
  lanes: BrainstormLane[];
  /** CLI that synthesizes the diversity; defaults to the first lane's CLI */
  synthesizerCli?: string;
  /** cwd for the lane processes (no repo required) */
  workDir: string;
  taskType?: string;
  timeoutMs?: number;
}

export interface BrainstormLaneResult {
  lane: string;
  outcome: EventLogOutcome;
  answer: string;
}

export interface BrainstormResult {
  taskId: string;
  lanes: BrainstormLaneResult[];
  /** null when every lane failed — synthesis is never fabricated */
  synthesis: string | null;
  eventsFile: string;
}

export async function runBrainstorm(options: BrainstormOptions): Promise<BrainstormResult> {
  const taskId = `task-${Date.now().toString(36)}`;
  const eventsFile = path.join(options.workDir, '.modes', 'events.jsonl');
  await mkdir(path.dirname(eventsFile), { recursive: true });
  const deps = makeRealDeps(options.workDir, { taskId, timeoutMs: options.timeoutMs });
  // Physical isolation: lanes think in a scratch dir so a rogue worker can never write
  // into the user's workDir (observed: a real synthesizer lane wrote an analysis doc unprompted)
  const scratchDir = await mkdtemp(path.join(os.tmpdir(), 'modes-brainstorm-lanes-'));

  try {
    const lanes = await Promise.all(
      options.lanes.map(async ({ lane, cli }): Promise<BrainstormLaneResult> => {
        const started = Date.now();
        const raw = await deps.spawnProcess(cli, buildWorkerArgs(cli, options.prompt), { cwd: scratchDir });
        const parsed = parseWorkerOutput(raw);
        // oxlint-disable-next-line no-await-in-loop -- append-only log: writes must stay ordered
        await appendEvent(eventsFile, {
          schema_version: EVENT_LOG_SCHEMA_VERSION,
          task_id: taskId,
          lane,
          attempt_id: `${taskId}-${lane}-1`,
          task_type: options.taskType ?? 'brainstorm',
          model: 'unknown',
          provider: cli,
          role: 'worker',
          outcome: parsed.outcome,
          score: null,
          cost: null,
          latency: Date.now() - started,
          verifier: 'process',
          ts: new Date().toISOString(),
        });
        return { lane, outcome: parsed.outcome, answer: parsed.summary };
      })
    );

    const survivors = lanes.filter((l) => l.outcome === 'success');
    let synthesis: string | null = null;

    if (survivors.length > 0) {
      const synthesizerCli = options.synthesizerCli ?? options.lanes[0].cli;
      const synthesisPrompt = `Below are ${survivors.length} independent answers to the same question.
Synthesize them: keep the diversity (what only one answer saw), resolve conflicts explicitly,
and produce a combined answer better than any single one.

=== QUESTION ===
${options.prompt}

${survivors.map((l) => `=== ANSWER ${l.lane} ===\n${l.answer}`).join('\n\n')}

=== YOUR SYNTHESIS ===`;

      const started = Date.now();
      const raw = await deps.spawnProcess(synthesizerCli, buildWorkerArgs(synthesizerCli, synthesisPrompt), {
        cwd: scratchDir,
      });
      const parsed = parseWorkerOutput(raw);
      if (parsed.outcome === 'success') {
        synthesis = parsed.summary;
      }
      await appendEvent(eventsFile, {
        schema_version: EVENT_LOG_SCHEMA_VERSION,
        task_id: taskId,
        lane: 'synthesis',
        attempt_id: `${taskId}-synthesis-1`,
        task_type: options.taskType ?? 'brainstorm',
        model: 'unknown',
        provider: synthesizerCli,
        role: 'synthesizer',
        outcome: parsed.outcome,
        score: null,
        cost: null,
        latency: Date.now() - started,
        verifier: synthesizerCli,
        ts: new Date().toISOString(),
      });
    }

    return { taskId, lanes, synthesis, eventsFile };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
