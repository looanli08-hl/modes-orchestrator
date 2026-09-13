/**
 * Contract test: user-gate (port-spec.md §4 row 7)
 * Orca counterpart: src/main/runtime/orchestration/coordinator-decision-gates.test.ts
 *   + db/decision-gate-lifecycle.test.ts (gate lifecycle pending → resolved; resolution must come
 *   from the declared options)
 * Pinned contract: the task-level lifecycle pending → fanning_out → reviewing → awaiting_user_pick → done
 *   can only leave awaiting_user_pick via an explicit user pick ("A" | "B" | "neither"). No programmatic
 *   event, timer, or review outcome may push the task out of awaiting_user_pick; the merge decision
 *   always belongs to a human (spec-mvp §1; port-spec §1A decision_gate row).
 * Spec references: docs/port-spec.md §4 row 7, §1A (decision_gate), §2B (task-level machine incl.
 *   both-lanes-failed shortcut); docs/spec-mvp.md §1, A4
 * Red mode: ../src/gate/userGate does not exist yet — the import failure IS the red state.
 */

import { describe, expect, it } from 'vitest';

import { createTaskLifecycle } from '../src/gate/userGate';

function lifecycleAtUserPick() {
  const lifecycle = createTaskLifecycle('task-1');
  lifecycle.advance('begin_fanout'); // pending → fanning_out
  lifecycle.advance('fanout_done'); // fanning_out → reviewing
  lifecycle.advance('review_done'); // reviewing → awaiting_user_pick
  return lifecycle;
}

describe('user-gate: only a user pick can leave awaiting_user_pick', () => {
  it('happy path reaches awaiting_user_pick and resolves via userPick("A" | "B" | "neither")', () => {
    for (const pick of ['A', 'B', 'neither'] as const) {
      const lifecycle = lifecycleAtUserPick();
      expect(lifecycle.state).toBe('awaiting_user_pick');

      lifecycle.userPick(pick);

      expect(lifecycle.state).toBe('done');
      expect(lifecycle.resolution).toEqual({ verifier: 'human', pick });
    }
  });

  it('non-user events cannot push the task out of awaiting_user_pick', () => {
    const lifecycle = lifecycleAtUserPick();

    for (const event of ['review_done', 'fanout_done', 'auto_resolve', 'timeout'] as const) {
      expect(() => lifecycle.advance(event), `advance("${event}")`).toThrowError(
        expect.objectContaining({ code: 'user_pick_required' })
      );
    }
    expect(lifecycle.state).toBe('awaiting_user_pick');
  });

  it('a pick outside the declared options is rejected with "invalid_pick"', () => {
    const lifecycle = lifecycleAtUserPick();

    expect(() => lifecycle.userPick('C' as never)).toThrowError(expect.objectContaining({ code: 'invalid_pick' }));
    expect(lifecycle.state).toBe('awaiting_user_pick');
  });

  it('userPick before awaiting_user_pick is rejected — the gate must be reached first', () => {
    const lifecycle = createTaskLifecycle('task-1');

    expect(() => lifecycle.userPick('A')).toThrowError(expect.objectContaining({ code: 'lifecycle_conflict' }));
    expect(lifecycle.state).toBe('pending');
  });

  it('both lanes failed still lands in awaiting_user_pick (double failure is presented, not auto-resolved)', () => {
    const lifecycle = createTaskLifecycle('task-1');
    lifecycle.advance('begin_fanout');
    lifecycle.advance('fanout_all_failed'); // skip review per port-spec §2B

    expect(lifecycle.state).toBe('awaiting_user_pick');
    expect(() => lifecycle.advance('auto_resolve')).toThrowError(
      expect.objectContaining({ code: 'user_pick_required' })
    );
  });
});

describe('user-gate: N lanes (lanes option)', () => {
  function threeLaneAtUserPick() {
    const lifecycle = createTaskLifecycle('task-1', { lanes: ['A', 'B', 'C'] });
    lifecycle.advance('begin_fanout');
    lifecycle.advance('fanout_done');
    lifecycle.advance('review_done');
    return lifecycle;
  }

  it('accepts any declared lane letter', () => {
    const lifecycle = threeLaneAtUserPick();
    lifecycle.userPick('C');
    expect(lifecycle.state).toBe('done');
    expect(lifecycle.resolution).toEqual({ verifier: 'human', pick: 'C' });
  });

  it('still accepts "neither"', () => {
    const lifecycle = threeLaneAtUserPick();
    lifecycle.userPick('neither');
    expect(lifecycle.state).toBe('done');
  });

  it('rejects a letter outside the declared lanes, listing the actual options', () => {
    const lifecycle = threeLaneAtUserPick();
    expect(() => lifecycle.userPick('D')).toThrowError(/A, B, C, neither/);
    expect(lifecycle.state).toBe('awaiting_user_pick');
  });
});
