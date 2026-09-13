/**
 * Task-level lifecycle + user gate — port-spec §2B / §4 row 7 (Orca decision_gate).
 * pending → fanning_out → reviewing → awaiting_user_pick → done.
 * Only an explicit user pick (a lane letter or "neither", validated against the
 * task's lanes) can leave awaiting_user_pick:
 * no programmatic event, timer, or review outcome may — the merge decision always
 * belongs to a human (spec-mvp §1). Both lanes failed skips review and lands in
 * awaiting_user_pick directly (port-spec §2B; hermes "all advisors failed → skip
 * synthesis" counterpart).
 */

import { OrchestratorError } from '../errors';

export const TASK_STATES = ['pending', 'fanning_out', 'reviewing', 'awaiting_user_pick', 'done'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export type TaskEvent = 'begin_fanout' | 'fanout_done' | 'fanout_all_failed' | 'review_done';

export const USER_PICK_OPTIONS = ['A', 'B', 'neither'] as const;
/**
 * A human gate decision: "neither", or one of the task's lane letters (uppercase).
 * Widened from the USER_PICK_OPTIONS union to string when compete generalized to N
 * lanes — the valid lane set is per-task, passed to createTaskLifecycle.
 */
export type UserPick = string;

export interface GateResolution {
  verifier: 'human';
  pick: UserPick;
}

const TRANSITIONS: Record<TaskState, Partial<Record<TaskEvent, TaskState>>> = {
  pending: { begin_fanout: 'fanning_out' },
  fanning_out: { fanout_done: 'reviewing', fanout_all_failed: 'awaiting_user_pick' },
  reviewing: { review_done: 'awaiting_user_pick' },
  awaiting_user_pick: {},
  done: {},
};

export interface TaskLifecycle {
  readonly taskId: string;
  readonly state: TaskState;
  readonly resolution: GateResolution | null;
  advance(event: TaskEvent | string): void;
  userPick(pick: UserPick): void;
}

export function createTaskLifecycle(taskId: string, opts?: { lanes?: string[] }): TaskLifecycle {
  let state: TaskState = 'pending';
  let resolution: GateResolution | null = null;
  const lanes = opts?.lanes ?? ['A', 'B'];
  const pickOptions = [...lanes, 'neither'];

  return {
    taskId,
    get state() {
      return state;
    },
    get resolution() {
      return resolution;
    },
    advance(event) {
      if (state === 'awaiting_user_pick') {
        throw new OrchestratorError(
          'user_pick_required',
          `task ${taskId} is awaiting a user pick; "${event}" cannot resolve the gate`
        );
      }
      const to = TRANSITIONS[state][event as TaskEvent];
      if (!to) {
        throw new OrchestratorError('lifecycle_conflict', `illegal task transition: ${state} --${event}-->`);
      }
      state = to;
    },
    userPick(pick) {
      if (state !== 'awaiting_user_pick') {
        throw new OrchestratorError(
          'lifecycle_conflict',
          `task ${taskId} is in state "${state}"; user pick requires awaiting_user_pick`
        );
      }
      if (!pickOptions.includes(pick)) {
        throw new OrchestratorError('invalid_pick', `pick "${pick}" is not one of ${pickOptions.join(', ')}`);
      }
      resolution = { verifier: 'human', pick };
      state = 'done';
    },
  };
}
