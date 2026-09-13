/**
 * Per-lane worker state machine — port-spec §2B.
 * One-directional, acyclic, no *_unknown states: in `-p` non-interactive mode the
 * process exit code is a deterministic terminal signal, so Orca's whole "liveness
 * unprovable" layer (start_unknown / stop_unknown / unverifiable) is deleted.
 */

import { OrchestratorError } from '../errors';

export const WORKER_STATES = ['spawning', 'running', 'succeeded', 'failed', 'timeout', 'quota_exhausted'] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

export const WORKER_TERMINAL_STATES = ['succeeded', 'failed', 'timeout', 'quota_exhausted'] as const;

export const WORKER_EVENTS = [
  'spawn_ok',
  'spawn_error',
  'exit_success',
  'exit_failure',
  'timeout',
  'quota_exhausted',
] as const;
export type WorkerEvent = (typeof WORKER_EVENTS)[number];

const TRANSITIONS: Record<WorkerState, Partial<Record<WorkerEvent, WorkerState>>> = {
  spawning: { spawn_ok: 'running', spawn_error: 'failed' },
  running: {
    exit_success: 'succeeded',
    exit_failure: 'failed',
    timeout: 'timeout',
    quota_exhausted: 'quota_exhausted',
  },
  succeeded: {},
  failed: {},
  timeout: {},
  quota_exhausted: {},
};

export function transitionWorker(from: WorkerState, event: WorkerEvent): WorkerState {
  const to = TRANSITIONS[from][event];
  if (!to) {
    throw new OrchestratorError('lifecycle_conflict', `illegal worker transition: ${from} --${event}-->`);
  }
  return to;
}
