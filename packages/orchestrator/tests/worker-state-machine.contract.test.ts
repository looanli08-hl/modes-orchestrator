/**
 * Contract test: worker-state-machine (port-spec.md §4 row 5)
 * Orca counterpart: src/main/runtime/orchestration/db/lifecycle-transition.test.ts
 *   + lifecycle-transition-boundary.test.ts (illegal transitions throw lifecycle_conflict; terminal
 *   states have no outgoing edges)
 * Pinned contract: the per-lane worker state machine is exactly the port-spec §2B set
 *   {spawning, running, succeeded, failed, timeout, quota_exhausted} — one-directional, acyclic,
 *   no *_unknown states. Legal edges: spawning→{running, failed},
 *   running→{succeeded, failed, timeout, quota_exhausted}. Every other transition throws
 *   code "lifecycle_conflict"; terminal states reject every event.
 * Spec references: docs/port-spec.md §4 row 5, §2B (deleted Orca mechanisms: start_unknown /
 *   stop_unknown / circuit_broken / heartbeat)
 * Red mode: ../src/worker/workerStateMachine does not exist yet — the import failure IS the red state.
 */

import { describe, expect, it } from 'vitest';

import {
  transitionWorker,
  WORKER_EVENTS,
  WORKER_STATES,
  WORKER_TERMINAL_STATES,
  type WorkerEvent,
  type WorkerState,
} from '../src/worker/workerStateMachine';

const LEGAL_EDGES: Array<[WorkerState, WorkerEvent, WorkerState]> = [
  ['spawning', 'spawn_ok', 'running'],
  ['spawning', 'spawn_error', 'failed'],
  ['running', 'exit_success', 'succeeded'],
  ['running', 'exit_failure', 'failed'],
  ['running', 'timeout', 'timeout'],
  ['running', 'quota_exhausted', 'quota_exhausted'],
];

describe('worker-state-machine: port-spec §2B one-directional acyclic machine', () => {
  it('state set is exactly the §2B six states — no *_unknown states exist', () => {
    expect([...WORKER_STATES].toSorted()).toEqual(
      ['failed', 'quota_exhausted', 'running', 'spawning', 'succeeded', 'timeout'].toSorted()
    );
    for (const state of WORKER_STATES) {
      expect(state).not.toContain('unknown');
    }
  });

  it('terminal states are exactly {succeeded, failed, timeout, quota_exhausted}', () => {
    expect([...WORKER_TERMINAL_STATES].toSorted()).toEqual(['failed', 'quota_exhausted', 'succeeded', 'timeout']);
  });

  it.each(LEGAL_EDGES)('legal edge: %s --%s--> %s', (from, event, expected) => {
    expect(transitionWorker(from, event)).toBe(expected);
  });

  it('every illegal non-terminal transition throws code "lifecycle_conflict"', () => {
    const legalPairs = new Set(LEGAL_EDGES.map(([from, event]) => `${from}:${event}`));
    for (const from of WORKER_STATES) {
      if (WORKER_TERMINAL_STATES.includes(from)) continue;
      for (const event of WORKER_EVENTS) {
        if (legalPairs.has(`${from}:${event}`)) continue;
        expect(() => transitionWorker(from, event), `${from} --${event}-->`).toThrowError(
          expect.objectContaining({ code: 'lifecycle_conflict' })
        );
      }
    }
  });

  it('terminal states have no outgoing edge — every event throws "lifecycle_conflict"', () => {
    for (const terminal of WORKER_TERMINAL_STATES) {
      for (const event of WORKER_EVENTS) {
        expect(() => transitionWorker(terminal, event), `${terminal} --${event}-->`).toThrowError(
          expect.objectContaining({ code: 'lifecycle_conflict' })
        );
      }
    }
  });
});
