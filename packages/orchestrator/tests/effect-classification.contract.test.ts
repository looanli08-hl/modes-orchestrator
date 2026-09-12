/**
 * Contract test: effect-classification (port-spec.md §4 row 8)
 * Orca counterpart: src/shared/orchestration-rpc-contract.test.ts
 *   (explicit mutation vs read-only classification of every operation; retired methods are listed
 *    explicitly rather than silently disappearing)
 * Pinned contract: every public operation of @modes/orchestrator is explicitly classified as
 *   "effect" (writes JSONL / creates worktrees / spawns or kills processes) or "readonly".
 *   Nothing is unclassified; nothing is classified that does not exist. The expected table below
 *   is the published contract — changing an operation's class is a breaking change that turns
 *   this test red.
 * Spec references: docs/port-spec.md §4 row 8, §3 (effects: JSONL append + worktree + spawn);
 *   docs/constitution.md §7 (JSONL instrumentation exists from day one)
 * Red mode: ../src/operations/effectClassification does not exist yet — the import failure IS the red state.
 */

import { describe, expect, it } from 'vitest';

import { OPERATION_EFFECTS, PUBLIC_OPERATIONS, RETIRED_OPERATIONS } from '../src/operations/effectClassification';

// The published table. Rows exist so a reviewer can audit the effect surface at a glance:
// anything that writes the JSONL log, creates/removes worktrees, or spawns/kills processes
// is an effect; pure observation is readonly.
const EXPECTED_CLASSIFICATION: Record<string, 'effect' | 'readonly'> = {
  spawnWorker: 'effect',
  fanOut: 'effect',
  killWorker: 'effect',
  appendEvent: 'effect',
  settleResult: 'effect',
  recordUserPick: 'effect',
  readEvents: 'readonly',
  getTaskState: 'readonly',
  getWorkerState: 'readonly',
  diffWorktree: 'readonly',
};

describe('effect-classification: every public operation is explicitly effect or readonly', () => {
  it('classification table matches the published contract exactly', () => {
    expect(OPERATION_EFFECTS).toEqual(EXPECTED_CLASSIFICATION);
  });

  it('every public operation is classified — nothing missing, nothing extra', () => {
    expect([...PUBLIC_OPERATIONS].toSorted()).toEqual(Object.keys(EXPECTED_CLASSIFICATION).toSorted());
    for (const op of PUBLIC_OPERATIONS) {
      expect(OPERATION_EFFECTS[op], `operation "${op}" must be classified`).toMatch(/^(effect|readonly)$/);
    }
  });

  it('retired operations are listed explicitly, not silently absent', () => {
    expect(Array.isArray(RETIRED_OPERATIONS)).toBe(true);
    for (const retired of RETIRED_OPERATIONS) {
      expect(PUBLIC_OPERATIONS).not.toContain(retired);
      expect(OPERATION_EFFECTS).not.toHaveProperty(retired);
    }
  });
});
