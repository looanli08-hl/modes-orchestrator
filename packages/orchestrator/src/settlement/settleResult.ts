/**
 * Result settlement — port-spec §4 row 6 (Orca worker_done settlement guards).
 * Settlement is idempotent per (task_id, lane, attempt_id): re-settling the same
 * attempt is a no-op. A late result from an OLD attempt is rejected with
 * code "stale_attempt" and never overwrites the newer attempt's result.
 */

import { OrchestratorError } from '../errors';

export interface LaneResult {
  task_id: string;
  lane: string;
  attempt_id: string;
  attempt_seq: number;
  outcome: string;
  model: string;
  provider: string;
  latency: number;
  ts: string;
}

export type SettleStatus = { status: 'settled' } | { status: 'already_settled' };

export interface ResultStore {
  settle(result: LaneResult): SettleStatus;
  recordsFor(taskId: string, lane: string): LaneResult[];
  currentFor(taskId: string, lane: string): LaneResult;
}

function laneKey(taskId: string, lane: string): string {
  return `${taskId}:${lane}`;
}

export function createResultStore(): ResultStore {
  const lanes = new Map<string, { byAttempt: Map<string, LaneResult>; current: LaneResult | null }>();

  function laneEntry(taskId: string, lane: string) {
    const k = laneKey(taskId, lane);
    let entry = lanes.get(k);
    if (!entry) {
      entry = { byAttempt: new Map(), current: null };
      lanes.set(k, entry);
    }
    return entry;
  }

  return {
    settle(result) {
      const entry = laneEntry(result.task_id, result.lane);
      if (entry.byAttempt.has(result.attempt_id)) {
        return { status: 'already_settled' };
      }
      if (entry.current && result.attempt_seq < entry.current.attempt_seq) {
        throw new OrchestratorError(
          'stale_attempt',
          `attempt "${result.attempt_id}" (seq ${result.attempt_seq}) is older than current attempt ` +
            `"${entry.current.attempt_id}" (seq ${entry.current.attempt_seq}) for ${result.task_id}/${result.lane}`
        );
      }
      entry.byAttempt.set(result.attempt_id, result);
      entry.current = result;
      return { status: 'settled' };
    },
    recordsFor(taskId, lane) {
      return [...laneEntry(taskId, lane).byAttempt.values()];
    },
    currentFor(taskId, lane) {
      const current = laneEntry(taskId, lane).current;
      if (!current) {
        throw new OrchestratorError('no_result', `no settled result for ${taskId}/${lane}`);
      }
      return current;
    },
  };
}

export function settleResult(store: ResultStore, result: LaneResult): SettleStatus {
  return store.settle(result);
}
