/**
 * report — turns the eval data into a plain-text report. Two sources are joined:
 * the run summaries in evals/eval-runs.jsonl (one line per unattended run) and the
 * retained per-scenario event snapshots under evals/events/ (the detailed event
 * streams that used to evaporate with the temp repos). Aggregations are pure
 * functions; file IO lives in loadReportData; rendering is dependency-free.
 * Sections with insufficient data say "(no data)" — nothing is fabricated.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { EventLogRecord } from '../schema/eventLog';
import { readEvents } from '../store/eventLogStore';
import type { ScenarioResult } from './runEval';

/** a run is flagged "(degraded)" when timeout+quota_exhausted exceed this share of its lane outcomes */
export const DEGRADED_OUTCOME_SHARE_THRESHOLD = 0.3;
export const DEFAULT_LAST_RUNS = 10;

export interface EvalRunRecord {
  ts: string;
  passed: number;
  total: number;
  results: ScenarioResult[];
}

export function parseEvalRuns(content: string): EvalRunRecord[] {
  const runs: EvalRunRecord[] = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    runs.push(JSON.parse(line) as EvalRunRecord);
  }
  return runs;
}

/** load the last N runs plus the event snapshots they reference (missing files are skipped, never fatal) */
export async function loadReportData(
  evalsDir: string,
  last: number
): Promise<{ runs: EvalRunRecord[]; eventsBySnapshot: Map<string, EventLogRecord[]> }> {
  let content = '';
  try {
    content = await readFile(path.join(evalsDir, 'eval-runs.jsonl'), 'utf8');
  } catch {
    // no summary file yet — the report renders its empty form
  }
  const runs = parseEvalRuns(content).slice(-last);

  const eventsBySnapshot = new Map<string, EventLogRecord[]>();
  for (const run of runs) {
    for (const result of run.results) {
      const snapshot = result.eventsSnapshot;
      if (!snapshot || eventsBySnapshot.has(snapshot)) continue;
      try {
        // oxlint-disable-next-line no-await-in-loop -- append-only logs read in stable order
        eventsBySnapshot.set(snapshot, await readEvents(snapshot));
      } catch {
        // snapshot deleted or unreadable — the summaries still carry what they know
      }
    }
  }
  return { runs, eventsBySnapshot };
}

// ── aggregations (pure) ──

export interface ScenarioStats {
  id: string;
  runs: number;
  passed: number;
  avgDurationMs: number;
  /** pass/fail in the newest run that included this scenario */
  latestPass: boolean;
}

export function aggregateScenarios(runs: EvalRunRecord[]): ScenarioStats[] {
  const map = new Map<string, { runs: number; passed: number; durationSum: number; latestPass: boolean }>();
  for (const run of runs) {
    for (const r of run.results) {
      const s = map.get(r.scenarioId) ?? { runs: 0, passed: 0, durationSum: 0, latestPass: false };
      s.runs += 1;
      s.passed += r.pass ? 1 : 0;
      s.durationSum += r.durationMs;
      s.latestPass = r.pass;
      map.set(r.scenarioId, s);
    }
  }
  return [...map.entries()]
    .map(([id, s]) => ({ id, runs: s.runs, passed: s.passed, avgDurationMs: s.durationSum / s.runs, latestPass: s.latestPass }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

export interface ModelStats {
  /** `${provider}/${model}` */
  key: string;
  count: number;
  outcomes: Partial<Record<string, number>>;
  avgLatencyMs: number;
}

/** worker events only, grouped by provider/model — reviewer/gate/synthesizer events are not worker outcomes */
export function aggregateModels(events: EventLogRecord[]): ModelStats[] {
  const map = new Map<string, { count: number; outcomes: Record<string, number>; latencySum: number }>();
  for (const e of events) {
    if (e.role !== 'worker') continue;
    const key = `${e.provider}/${e.model}`;
    const s = map.get(key) ?? { count: 0, outcomes: {}, latencySum: 0 };
    s.count += 1;
    s.outcomes[e.outcome] = (s.outcomes[e.outcome] ?? 0) + 1;
    s.latencySum += e.latency;
    map.set(key, s);
  }
  return [...map.entries()]
    .map(([key, s]) => ({ key, count: s.count, outcomes: s.outcomes, avgLatencyMs: s.latencySum / s.count }))
    .toSorted((a, b) => a.key.localeCompare(b.key));
}

export interface ReviewPickStats {
  total: number;
  /** pick value ("A" / "B" / … / "tie") → times recommended */
  byPick: Record<string, number>;
  /** provider of the picked lane → times recommended (ties excluded: no lane was picked) */
  byProvider: Record<string, number>;
}

export function aggregateReviewPicks(
  runs: EvalRunRecord[],
  eventsBySnapshot: Map<string, EventLogRecord[]>
): ReviewPickStats {
  const stats: ReviewPickStats = { total: 0, byPick: {}, byProvider: {} };
  for (const run of runs) {
    for (const r of run.results) {
      const pick = r.reviewPick;
      if (pick == null) continue;
      stats.total += 1;
      stats.byPick[pick] = (stats.byPick[pick] ?? 0) + 1;
      if (pick === 'tie') continue;
      const events = r.eventsSnapshot ? eventsBySnapshot.get(r.eventsSnapshot) : undefined;
      const provider = events?.find((e) => e.role === 'worker' && e.lane === pick)?.provider ?? 'unknown';
      stats.byProvider[provider] = (stats.byProvider[provider] ?? 0) + 1;
    }
  }
  return stats;
}

export interface CascadeStats {
  /** cascade scenario results seen (cascade + auto→cascade) */
  runs: number;
  /** chain level → times it produced the winner */
  levelWins: Record<number, number>;
  wins: number;
  /** level-1 wins / all wins — the quota saver; null when nothing ever won */
  earlyStopRate: number | null;
  /** times the chain moved to a deeper level */
  escalations: number;
  /** runs where the chain ran out without a winner */
  exhausted: number;
}

const CASCADE_PICK_PATTERN = /^cascade-(\d+)$/;

export function aggregateCascade(runs: EvalRunRecord[]): CascadeStats {
  const stats: CascadeStats = { runs: 0, levelWins: {}, wins: 0, earlyStopRate: null, escalations: 0, exhausted: 0 };
  for (const run of runs) {
    for (const r of run.results) {
      const attempts = Object.keys(r.laneOutcomes ?? {}).filter((k) => k.startsWith('cascade-')).length;
      if (attempts === 0) continue;
      stats.runs += 1;
      stats.escalations += attempts - 1;
      const winner = r.pick ? CASCADE_PICK_PATTERN.exec(r.pick) : null;
      if (winner) {
        const level = Number(winner[1]);
        stats.levelWins[level] = (stats.levelWins[level] ?? 0) + 1;
        stats.wins += 1;
      } else {
        stats.exhausted += 1;
      }
    }
  }
  if (stats.wins > 0) stats.earlyStopRate = (stats.levelWins[1] ?? 0) / stats.wins;
  return stats;
}

/** timeout + quota_exhausted share of the run's lane outcomes; null when the run recorded none */
export function degradedShare(run: EvalRunRecord): number | null {
  let degraded = 0;
  let total = 0;
  for (const r of run.results) {
    for (const outcome of Object.values(r.laneOutcomes ?? {})) {
      total += 1;
      if (outcome === 'timeout' || outcome === 'quota_exhausted') degraded += 1;
    }
  }
  return total === 0 ? null : degraded / total;
}

export function isDegraded(run: EvalRunRecord): boolean {
  const share = degradedShare(run);
  return share !== null && share > DEGRADED_OUTCOME_SHARE_THRESHOLD;
}

// ── rendering (pure) ──

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** align columns: every column padded to its widest cell, two-space gutter */
function table(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (const [i, cell] of row.entries()) {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    }
  }
  return rows.map((row) => '  ' + row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]) : cell)).join('  ').trimEnd());
}

const NO_DATA = '  (no data)';

export function renderReport(runs: EvalRunRecord[], eventsBySnapshot: Map<string, EventLogRecord[]>): string {
  const lines: string[] = [];
  lines.push(`MODES EVAL REPORT — last ${runs.length} run(s)`);
  if (runs.length > 0) {
    lines.push(`window: ${runs[0].ts} → ${runs[runs.length - 1].ts}`);
  }
  lines.push('');

  // ── overview ──
  lines.push('== Overview ==');
  if (runs.length === 0) {
    lines.push(NO_DATA);
  } else {
    const total = runs.reduce((n, r) => n + r.total, 0);
    const passed = runs.reduce((n, r) => n + r.passed, 0);
    const latest = runs[runs.length - 1];
    const rows = [
      ['runs:', String(runs.length)],
      ['scenario results:', `${total} — ${passed}/${total} passed (${fmtPct(passed / total)})`],
      [
        'latest run:',
        `${latest.ts} — ${latest.passed}/${latest.total} passed${isDegraded(latest) ? '  (degraded)' : ''}`,
      ],
    ];
    lines.push(...table(rows));
  }
  lines.push('');

  // ── per scenario ──
  lines.push('== Scenarios ==');
  const scenarios = aggregateScenarios(runs);
  if (scenarios.length === 0) {
    lines.push(NO_DATA);
  } else {
    lines.push(
      ...table([
        ['scenario', 'runs', 'pass', 'avg duration', 'latest'],
        ...scenarios.map((s) => [
          s.id,
          String(s.runs),
          `${s.passed}/${s.runs}`,
          fmtMs(s.avgDurationMs),
          s.latestPass ? 'PASS' : 'FAIL',
        ]),
      ])
    );
  }
  lines.push('');

  // ── per model (worker events from the retained snapshots) ──
  lines.push('== Models (worker events) ==');
  const models = aggregateModels([...eventsBySnapshot.values()].flat());
  if (models.length === 0) {
    lines.push(NO_DATA);
  } else {
    lines.push(
      ...table([
        ['provider/model', 'events', 'success', 'failed', 'timeout', 'quota_exhausted', 'avg latency'],
        ...models.map((m) => [
          m.key,
          String(m.count),
          String(m.outcomes.success ?? 0),
          String(m.outcomes.failed ?? 0),
          String(m.outcomes.timeout ?? 0),
          String(m.outcomes.quota_exhausted ?? 0),
          fmtMs(m.avgLatencyMs),
        ]),
      ])
    );
  }
  lines.push('');

  // ── reviewer picks ──
  lines.push('== Reviewer picks ==');
  const picks = aggregateReviewPicks(runs, eventsBySnapshot);
  if (picks.total === 0) {
    lines.push(NO_DATA);
  } else {
    const pickList = Object.keys(picks.byPick)
      .toSorted()
      .map((p) => `${p}=${picks.byPick[p]}`)
      .join('  ');
    lines.push(`  picks (${picks.total}): ${pickList}`);
    if (Object.keys(picks.byProvider).length > 0) {
      lines.push('  picked-lane provider:');
      const providers = Object.entries(picks.byProvider).toSorted((a, b) => b[1] - a[1]);
      lines.push(...table(providers.map(([provider, count]) => [provider, String(count)])));
    }
  }
  lines.push('');

  // ── cascade ──
  lines.push('== Cascade ==');
  const cascade = aggregateCascade(runs);
  if (cascade.runs === 0) {
    lines.push(NO_DATA);
  } else {
    const rows = [
      ['cascade results:', String(cascade.runs)],
      [
        'level wins:',
        Object.keys(cascade.levelWins).length > 0
          ? Object.entries(cascade.levelWins)
              .map(([level, count]) => `${level}=${count}`)
              .join('  ')
          : '(none)',
      ],
      ['early-stop rate:', cascade.earlyStopRate === null ? '(no winners)' : `${fmtPct(cascade.earlyStopRate)} of winners stopped at level 1`],
      ['escalations:', String(cascade.escalations)],
      ['chain exhausted:', String(cascade.exhausted)],
    ];
    lines.push(...table(rows));
  }
  lines.push('');

  // ── degraded-day fingerprint ──
  lines.push('== Degraded runs ==');
  if (runs.length === 0) {
    lines.push(NO_DATA);
  } else {
    lines.push(`  threshold: timeout+quota share > ${fmtPct(DEGRADED_OUTCOME_SHARE_THRESHOLD)} of lane outcomes`);
    lines.push(
      ...table(
        runs.map((run) => {
          const share = degradedShare(run);
          return [
            run.ts,
            share === null ? 'share n/a (no lane outcomes)' : `share ${fmtPct(share)}`,
            isDegraded(run) ? '(degraded)' : '',
          ];
        })
      )
    );
  }

  return lines.join('\n');
}
