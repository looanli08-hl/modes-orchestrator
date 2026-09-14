/**
 * Report tests — the modes-report aggregations and rendering, against small fixtures:
 * eval-runs.jsonl summary lines plus retained per-scenario event snapshots
 * (evals/events/*.jsonl). Pure aggregations and report rendering are tested
 * separately; the loader is tested against real temp files.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  aggregateCascade,
  aggregateModels,
  aggregateReviewPicks,
  aggregateScenarios,
  degradedShare,
  isDegraded,
  loadReportData,
  parseEvalRuns,
  renderReport,
  type EvalRunRecord,
} from '../src/eval/report';
import type { ScenarioResult } from '../src/eval/runEval';
import { EVENT_LOG_SCHEMA_VERSION, type EventLogRecord } from '../src/schema/eventLog';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

function makeEvent(partial: Partial<EventLogRecord>): EventLogRecord {
  return {
    schema_version: EVENT_LOG_SCHEMA_VERSION,
    task_id: 'task-fixture',
    lane: 'A',
    attempt_id: 'task-fixture-A-1',
    task_type: 'eval:fixture',
    model: 'fixture-model',
    provider: 'fixture-cli',
    role: 'worker',
    outcome: 'success',
    score: null,
    cost: null,
    latency: 100,
    verifier: 'process',
    ts: '2026-09-14T00:00:00.000Z',
    ...partial,
  };
}

function makeResult(partial: Partial<ScenarioResult>): ScenarioResult {
  return {
    scenarioId: 'simple-create',
    pass: true,
    failures: [],
    durationMs: 1000,
    eventsFile: null,
    workDir: '',
    ...partial,
  };
}

function makeRun(ts: string, results: ScenarioResult[]): EvalRunRecord {
  return { ts, passed: results.filter((r) => r.pass).length, total: results.length, results };
}

/** writes an events snapshot file and returns its path */
async function writeSnapshot(dir: string, name: string, events: EventLogRecord[]): Promise<string> {
  const file = path.join(dir, 'events', name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return file;
}

interface Fixture {
  evalsDir: string;
  runs: EvalRunRecord[];
}

/**
 * Two runs. Run 1 (degraded): simple-create with a kimi success + qwen timeout,
 * reviewer picked A; cascade-basic won at level 2 after one escalation. Run 2
 * (healthy): simple-create all-success, reviewer tie; cascade-basic early-stopped
 * at level 1.
 */
async function writeFixture(): Promise<Fixture> {
  const evalsDir = await mkdtemp(path.join(os.tmpdir(), 'modes-report-fixture-'));
  tempDirs.push(evalsDir);

  const snap1 = await writeSnapshot(evalsDir, 'simple-create-20260914T000000Z-task-1.jsonl', [
    makeEvent({ lane: 'A', provider: 'kimi', model: 'kimi-for-coding', outcome: 'success', latency: 100 }),
    makeEvent({ lane: 'B', provider: 'qwen', model: 'qwen3-coder', outcome: 'timeout', latency: 600000 }),
    makeEvent({ lane: 'review', provider: 'kimi', model: 'kimi-for-coding', role: 'reviewer', latency: 5000, verifier: 'kimi' }),
    makeEvent({ lane: 'gate', provider: 'human', model: 'none', role: 'gate', latency: 0, verifier: 'human:A' }),
  ]);
  const snap2 = await writeSnapshot(evalsDir, 'simple-create-20260914T010000Z-task-2.jsonl', [
    makeEvent({ lane: 'A', provider: 'kimi', model: 'kimi-for-coding', outcome: 'success', latency: 300 }),
    makeEvent({ lane: 'B', provider: 'qwen', model: 'qwen3-coder', outcome: 'success', latency: 900 }),
    makeEvent({ lane: 'review', provider: 'kimi', model: 'kimi-for-coding', role: 'reviewer', latency: 4000, verifier: 'kimi' }),
    makeEvent({ lane: 'gate', provider: 'human', model: 'none', role: 'gate', latency: 0, verifier: 'human:A' }),
  ]);

  const runs: EvalRunRecord[] = [
    makeRun('2026-09-14T00:10:00.000Z', [
      makeResult({
        scenarioId: 'simple-create',
        pass: false,
        durationMs: 600000,
        pick: 'A',
        reviewPick: 'A',
        laneOutcomes: { A: 'success', B: 'timeout' },
        eventsSnapshot: snap1,
      }),
      makeResult({
        scenarioId: 'cascade-basic',
        pass: true,
        durationMs: 610000,
        pick: 'cascade-2',
        laneOutcomes: { 'cascade-1': 'timeout', 'cascade-2': 'success' },
      }),
    ]),
    makeRun('2026-09-14T01:10:00.000Z', [
      makeResult({
        scenarioId: 'simple-create',
        pass: true,
        durationMs: 20000,
        pick: 'A',
        reviewPick: 'tie',
        laneOutcomes: { A: 'success', B: 'success' },
        eventsSnapshot: snap2,
      }),
      makeResult({
        scenarioId: 'cascade-basic',
        pass: true,
        durationMs: 15000,
        pick: 'cascade-1',
        laneOutcomes: { 'cascade-1': 'success' },
      }),
    ]),
  ];

  await writeFile(
    path.join(evalsDir, 'eval-runs.jsonl'),
    runs.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  );
  return { evalsDir, runs };
}

describe('parseEvalRuns', () => {
  it('parses JSONL lines and skips blanks', () => {
    const runs = parseEvalRuns(
      JSON.stringify(makeRun('2026-09-14T00:00:00.000Z', [])) + '\n\n' + JSON.stringify(makeRun('2026-09-14T01:00:00.000Z', [])) + '\n'
    );
    expect(runs).toHaveLength(2);
    expect(runs[0].ts).toBe('2026-09-14T00:00:00.000Z');
  });

  it('empty content yields no runs', () => {
    expect(parseEvalRuns('')).toEqual([]);
  });
});

describe('aggregateScenarios', () => {
  it('computes pass count, average duration and latest result per scenario', async () => {
    const { runs } = await writeFixture();
    const stats = aggregateScenarios(runs);
    const simple = stats.find((s) => s.id === 'simple-create')!;
    expect(simple.runs).toBe(2);
    expect(simple.passed).toBe(1);
    expect(simple.avgDurationMs).toBe(310000);
    expect(simple.latestPass).toBe(true); // newest run passed

    const cascade = stats.find((s) => s.id === 'cascade-basic')!;
    expect(cascade.runs).toBe(2);
    expect(cascade.passed).toBe(2);
  });

  it('no runs → no scenario stats', () => {
    expect(aggregateScenarios([])).toEqual([]);
  });
});

describe('aggregateModels', () => {
  it('groups worker events by provider/model with outcome counts and average latency', () => {
    const stats = aggregateModels([
      makeEvent({ provider: 'kimi', model: 'kimi-for-coding', outcome: 'success', latency: 100 }),
      makeEvent({ provider: 'kimi', model: 'kimi-for-coding', outcome: 'success', latency: 300 }),
      makeEvent({ provider: 'qwen', model: 'qwen3-coder', outcome: 'timeout', latency: 600000 }),
      // reviewer and gate events are not worker outcomes and must be excluded
      makeEvent({ provider: 'kimi', model: 'kimi-for-coding', role: 'reviewer', latency: 5000 }),
    ]);
    expect(stats).toHaveLength(2);
    const kimi = stats.find((s) => s.key === 'kimi/kimi-for-coding')!;
    expect(kimi.count).toBe(2);
    expect(kimi.outcomes).toEqual({ success: 2 });
    expect(kimi.avgLatencyMs).toBe(200);
    const qwen = stats.find((s) => s.key === 'qwen/qwen3-coder')!;
    expect(qwen.outcomes).toEqual({ timeout: 1 });
    expect(qwen.avgLatencyMs).toBe(600000);
  });

  it('no events → no model stats', () => {
    expect(aggregateModels([])).toEqual([]);
  });
});

describe('aggregateReviewPicks', () => {
  it('counts reviewer picks and groups non-tie picks by the picked lane provider', async () => {
    const { evalsDir, runs } = await writeFixture();
    const { eventsBySnapshot } = await loadReportData(evalsDir, 10);
    const stats = aggregateReviewPicks(runs, eventsBySnapshot);
    expect(stats.total).toBe(2);
    expect(stats.byPick).toEqual({ A: 1, tie: 1 });
    // lane A in run 1 was provided by kimi, per its event snapshot
    expect(stats.byProvider).toEqual({ kimi: 1 });
  });

  it('falls back to "unknown" provider when the snapshot is missing', () => {
    const runs = [makeRun('2026-09-14T00:00:00.000Z', [makeResult({ reviewPick: 'B', eventsSnapshot: null })])];
    const stats = aggregateReviewPicks(runs, new Map());
    expect(stats.byPick).toEqual({ B: 1 });
    expect(stats.byProvider).toEqual({ unknown: 1 });
  });

  it('no picks → zeroed stats', () => {
    const stats = aggregateReviewPicks([makeRun('2026-09-14T00:00:00.000Z', [makeResult({})])], new Map());
    expect(stats.total).toBe(0);
  });
});

describe('aggregateCascade', () => {
  it('counts level wins, escalations and exhaustion across cascade results', async () => {
    const { runs } = await writeFixture();
    const stats = aggregateCascade(runs);
    expect(stats.runs).toBe(2);
    expect(stats.levelWins).toEqual({ 1: 1, 2: 1 });
    expect(stats.wins).toBe(2);
    expect(stats.earlyStopRate).toBe(0.5);
    expect(stats.escalations).toBe(1); // run 1 went level 1 → 2
    expect(stats.exhausted).toBe(0);
  });

  it('counts a fully exhausted chain (no winner) honestly', () => {
    const runs = [
      makeRun('2026-09-14T00:00:00.000Z', [
        makeResult({
          scenarioId: 'cascade-basic',
          pick: 'neither',
          laneOutcomes: { 'cascade-1': 'timeout', 'cascade-2': 'failed' },
        }),
      ]),
    ];
    const stats = aggregateCascade(runs);
    expect(stats.wins).toBe(0);
    expect(stats.exhausted).toBe(1);
    expect(stats.escalations).toBe(1);
    expect(stats.earlyStopRate).toBeNull();
  });

  it('ignores non-cascade results', () => {
    const runs = [makeRun('2026-09-14T00:00:00.000Z', [makeResult({ pick: 'A', laneOutcomes: { A: 'success' } })])];
    expect(aggregateCascade(runs).runs).toBe(0);
  });
});

describe('degraded detection', () => {
  it('flags a run whose timeout/quota share exceeds the threshold', async () => {
    const { runs } = await writeFixture();
    expect(degradedShare(runs[0])).toBeCloseTo(0.5);
    expect(isDegraded(runs[0])).toBe(true); // 2 timeouts out of 4 lane outcomes
    expect(degradedShare(runs[1])).toBe(0);
    expect(isDegraded(runs[1])).toBe(false);
  });

  it('does not flag a run at or below the threshold', () => {
    const run = makeRun('2026-09-14T00:00:00.000Z', [
      makeResult({ laneOutcomes: { A: 'success', B: 'success', C: 'timeout' } }),
      makeResult({ laneOutcomes: { A: 'success', B: 'success', C: 'success', D: 'success' } }),
    ]);
    expect(degradedShare(run)).toBeCloseTo(1 / 7); // ~14% < 30%
    expect(isDegraded(run)).toBe(false);
  });

  it('a run with no lane outcomes has no share and is never degraded', () => {
    const run = makeRun('2026-09-14T00:00:00.000Z', [makeResult({ laneOutcomes: undefined })]);
    expect(degradedShare(run)).toBeNull();
    expect(isDegraded(run)).toBe(false);
  });
});

describe('loadReportData', () => {
  it('loads the last N runs and their referenced event snapshots', async () => {
    const { evalsDir } = await writeFixture();
    const { runs, eventsBySnapshot } = await loadReportData(evalsDir, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0].ts).toBe('2026-09-14T01:10:00.000Z');
    // only the snapshot referenced by the selected run is loaded
    expect(eventsBySnapshot.size).toBe(1);
    const events = [...eventsBySnapshot.values()][0];
    expect(events).toHaveLength(4);
  });

  it('a missing snapshot file is skipped, not fatal', async () => {
    const { evalsDir, runs } = await writeFixture();
    runs[0].results[0].eventsSnapshot = path.join(evalsDir, 'events', 'gone.jsonl');
    await writeFile(path.join(evalsDir, 'eval-runs.jsonl'), runs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const { eventsBySnapshot } = await loadReportData(evalsDir, 10);
    expect(eventsBySnapshot.size).toBe(1); // only the surviving snapshot
  });

  it('a missing eval-runs.jsonl yields empty data', async () => {
    const evalsDir = await mkdtemp(path.join(os.tmpdir(), 'modes-report-empty-'));
    tempDirs.push(evalsDir);
    const { runs, eventsBySnapshot } = await loadReportData(evalsDir, 10);
    expect(runs).toEqual([]);
    expect(eventsBySnapshot.size).toBe(0);
  });
});

describe('renderReport', () => {
  it('renders every section with the key numbers', async () => {
    const { evalsDir } = await writeFixture();
    const { runs, eventsBySnapshot } = await loadReportData(evalsDir, 10);
    const report = renderReport(runs, eventsBySnapshot);

    // overview
    expect(report).toMatch(/runs:\s+2/);
    expect(report).toContain('3/4 passed');
    expect(report).toContain('2026-09-14T01:10:00.000Z');
    expect(report).toContain('(degraded)');

    // scenarios
    expect(report).toContain('simple-create');
    expect(report).toContain('cascade-basic');

    // models
    expect(report).toContain('kimi/kimi-for-coding');
    expect(report).toContain('qwen/qwen3-coder');

    // reviewer picks
    expect(report).toContain('A=1');
    expect(report).toContain('tie=1');
    expect(report).toContain('kimi');

    // cascade
    expect(report).toContain('early-stop');
    expect(report).toContain('50.0%');
    expect(report).toMatch(/escalations:\s+1/);

    // degraded runs section lists both runs, marking only run 1
    const degradedSection = report.split('== Degraded runs ==')[1];
    expect(degradedSection).toContain('2026-09-14T00:10:00.000Z');
    expect(degradedSection).toContain('(degraded)');
  });

  it('marks sections with no data honestly', () => {
    const report = renderReport([], new Map());
    expect(report).toContain('(no data)');
    const sections = report.split('==').length;
    expect(sections).toBeGreaterThan(5); // every section rendered, none invented
  });

  it('marks sections (no data) when only summaries exist (no snapshots, no picks, no cascade)', () => {
    const runs = [makeRun('2026-09-14T00:00:00.000Z', [makeResult({ laneOutcomes: { A: 'success' } })])];
    const report = renderReport(runs, new Map());
    expect(report).not.toMatch(/runs:\s+0/);
    expect(report.split('== Models (worker events) ==')[1]).toContain('(no data)');
    expect(report.split('== Reviewer picks ==')[1]).toContain('(no data)');
    expect(report.split('== Cascade ==')[1]).toContain('(no data)');
  });
});
