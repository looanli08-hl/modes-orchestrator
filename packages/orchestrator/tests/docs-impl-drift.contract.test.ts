/**
 * Contract test: docs-impl-drift (port-spec.md §4 row 1)
 * Orca counterpart: config/scripts/orchestration-guide-command-contract.test.mjs
 *   (every verb+flag in the 8 protocol guides must be accepted by the CLI spec — docs never drift from impl)
 * Pinned contract: the JSONL instrumentation schema exported by the implementation must match
 *   the spec-mvp §5 field table field-for-field (names, order, types, nullability, enum values).
 *   This test hardcodes the spec table; any drift between spec and implementation turns it red.
 * Spec references: docs/port-spec.md §4 row 1; docs/spec-mvp.md §5 (revised 2026-09-12: lane + attempt_id, cost nullable)
 * Red mode: ../src/schema/eventLog does not exist yet — the import failure IS the red state.
 */

import { describe, expect, it } from 'vitest';

import { EVENT_LOG_FIELDS, EVENT_LOG_OUTCOME_VALUES, EVENT_LOG_ROLE_VALUES } from '../src/schema/eventLog';

// Hardcoded from docs/spec-mvp.md §5 (2026-09-12 revision). Do NOT derive this from the
// implementation — that would defeat the purpose of the drift test.
const SPEC_MVP_S5_FIELDS = [
  { name: 'task_id', type: 'string', nullable: false },
  { name: 'lane', type: 'string', nullable: false },
  { name: 'attempt_id', type: 'string', nullable: false },
  { name: 'task_type', type: 'string', nullable: false },
  { name: 'model', type: 'string', nullable: false },
  { name: 'provider', type: 'string', nullable: false },
  { name: 'role', type: 'string', nullable: false },
  { name: 'outcome', type: 'string', nullable: false },
  { name: 'score', type: 'number', nullable: true },
  { name: 'cost', type: 'number', nullable: true },
  { name: 'latency', type: 'number', nullable: false },
  { name: 'verifier', type: 'string', nullable: false },
  { name: 'ts', type: 'string', nullable: false },
] as const;

describe('docs-impl-drift: JSONL schema matches spec-mvp §5', () => {
  it('exports exactly the §5 fields, in the documented order', () => {
    expect(EVENT_LOG_FIELDS.map((f) => ({ name: f.name, type: f.type, nullable: f.nullable }))).toEqual(
      SPEC_MVP_S5_FIELDS.map((f) => ({ name: f.name, type: f.type, nullable: f.nullable }))
    );
  });

  it('outcome enum is exactly success/failed/timeout/quota_exhausted (§5 + port-spec §2B)', () => {
    expect([...EVENT_LOG_OUTCOME_VALUES].toSorted()).toEqual(['failed', 'quota_exhausted', 'success', 'timeout']);
  });

  it('role enum is exactly worker/reviewer (§5)', () => {
    expect([...EVENT_LOG_ROLE_VALUES].toSorted()).toEqual(['reviewer', 'worker']);
  });
});
