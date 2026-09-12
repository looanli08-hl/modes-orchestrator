/**
 * Contract test: result-settlement (port-spec.md §4 row 6)
 * Orca counterpart: src/main/runtime/orchestration/db-task-dispatch-lifecycle-guards.test.ts
 *   + db-task-dispatch-races.test.ts + db-task-dispatch-invariant.test.ts
 *   (worker_done settlement guards: exactly-once settlement; a stale dispatch's late report
 *    must NOT complete the current attempt)
 * Pinned contract: settling a lane result is idempotent per (task_id, lane, attempt_id) —
 *   re-settling the same attempt is a no-op, never a duplicate record. Re-running a lane produces
 *   a new attempt; a late result from the OLD attempt is rejected with code "stale_attempt" and
 *   never overwrites the newer attempt's result.
 * Spec references: docs/port-spec.md §4 row 6, §2A (stale-dispatch invariant), §7 item 1;
 *   docs/spec-mvp.md §5 (attempt_id field, added 2026-09-12 for exactly this contract)
 * Red mode: ../src/settlement/settleResult does not exist yet — the import failure IS the red state.
 */

import { describe, expect, it } from 'vitest';

import { createResultStore, settleResult } from '../src/settlement/settleResult';

function makeResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    task_id: 'task-1',
    lane: 'A',
    attempt_id: 'attempt-1',
    attempt_seq: 1,
    outcome: 'success',
    model: 'fake-model',
    provider: 'fake-cli',
    latency: 42,
    ts: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('result-settlement: idempotent per attempt, stale attempts never overwrite', () => {
  it('settling the same attempt twice is a no-op — exactly one record survives', () => {
    const store = createResultStore();
    const result = makeResult();

    const first = settleResult(store, result);
    const second = settleResult(store, result);

    expect(first).toMatchObject({ status: 'settled' });
    expect(second).toMatchObject({ status: 'already_settled' });
    expect(store.recordsFor('task-1', 'A')).toHaveLength(1);
  });

  it('a late result from an old attempt is rejected as stale_attempt and changes nothing', () => {
    const store = createResultStore();

    // Newer attempt settles first (e.g. lane was re-run after a failure).
    settleResult(store, makeResult({ attempt_id: 'attempt-2', attempt_seq: 2, outcome: 'success' }));

    // The old attempt's late report arrives afterwards.
    expect(() =>
      settleResult(store, makeResult({ attempt_id: 'attempt-1', attempt_seq: 1, outcome: 'failed' }))
    ).toThrowError(expect.objectContaining({ code: 'stale_attempt' }));

    const current = store.currentFor('task-1', 'A');
    expect(current.attempt_id).toBe('attempt-2');
    expect(current.outcome).toBe('success');
  });

  it('attempts of DIFFERENT lanes of the same task settle independently', () => {
    const store = createResultStore();

    settleResult(store, makeResult({ lane: 'A', attempt_id: 'attempt-a1' }));
    settleResult(store, makeResult({ lane: 'B', attempt_id: 'attempt-b1', outcome: 'failed' }));

    expect(store.currentFor('task-1', 'A').outcome).toBe('success');
    expect(store.currentFor('task-1', 'B').outcome).toBe('failed');
  });
});
