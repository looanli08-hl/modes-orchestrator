/**
 * taskRegistry — in-memory task state for the modes console. The engine stays
 * stateless (its truth is the JSONL event log); this registry only mirrors enough
 * for the panel to render: status machine running → awaiting_pick | done | failed,
 * the lane results, and the pick-time pointers (eventsFile / worktree / branch)
 * needed to apply a human pick later. Nothing here is persisted — a server
 * restart forgets every task, by design for a local dev console.
 */

import type { UserPick } from '../gate/userGate';
import type { ReviewVerdict } from '../review/crossReview';

export type ConsoleTaskMode = 'compete' | 'brainstorm';
export type ConsoleTaskStatus = 'running' | 'awaiting_pick' | 'done' | 'failed';

export interface CompeteLaneState {
  lane: string;
  outcome: string;
  summary: string;
  diff: string;
  worktreePath: string;
  branch: string;
}

export interface BrainstormLaneState {
  lane: string;
  outcome: string;
  answer: string;
}

export interface ConsoleTask {
  /** console-assigned id — the engine only hands back its taskId when the run finishes */
  id: string;
  /** engine taskId, known once the run resolves; null while running */
  engineTaskId: string | null;
  mode: ConsoleTaskMode;
  prompt: string;
  repoPath: string;
  status: ConsoleTaskStatus;
  createdAt: string;
  error: string | null;
  eventsFile: string | null;
  compete: { lanes: CompeteLaneState[]; review: ReviewVerdict | null } | null;
  brainstorm: { lanes: BrainstormLaneState[]; synthesis: string | null } | null;
}

export interface ConsoleTaskSummary {
  id: string;
  mode: ConsoleTaskMode;
  prompt: string;
  status: ConsoleTaskStatus;
  createdAt: string;
}

export interface TaskRegistry {
  create(mode: ConsoleTaskMode, prompt: string, repoPath: string): ConsoleTask;
  get(id: string): ConsoleTask | undefined;
  list(): ConsoleTaskSummary[];
  completeCompete(
    id: string,
    result: { taskId: string; lanes: CompeteLaneState[]; review: ReviewVerdict | null; eventsFile: string }
  ): void;
  completeBrainstorm(
    id: string,
    result: { taskId: string; lanes: BrainstormLaneState[]; synthesis: string | null; eventsFile: string }
  ): void;
  /** engine threw — terminal state with the message surfaced to the panel */
  fail(id: string, error: unknown): void;
  /** pick applied (recorded + merged, or recorded as "neither") */
  markDone(id: string): void;
  /** pick application failed — task stays awaiting_pick so the human can retry */
  setError(id: string, error: unknown): void;
}

export function createTaskRegistry(): TaskRegistry {
  const tasks = new Map<string, ConsoleTask>();
  let seq = 0;

  const requireTask = (id: string): ConsoleTask => {
    const task = tasks.get(id);
    if (!task) throw new Error(`unknown task ${id}`);
    return task;
  };

  return {
    create(mode, prompt, repoPath) {
      seq += 1;
      const task: ConsoleTask = {
        id: `console-${Date.now().toString(36)}-${seq}`,
        engineTaskId: null,
        mode,
        prompt,
        repoPath,
        status: 'running',
        createdAt: new Date().toISOString(),
        error: null,
        eventsFile: null,
        compete: null,
        brainstorm: null,
      };
      tasks.set(task.id, task);
      return task;
    },

    get: (id) => tasks.get(id),

    list: () =>
      [...tasks.values()]
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((t) => ({ id: t.id, mode: t.mode, prompt: t.prompt, status: t.status, createdAt: t.createdAt })),

    completeCompete(id, result) {
      const task = requireTask(id);
      task.engineTaskId = result.taskId;
      task.eventsFile = result.eventsFile;
      task.compete = { lanes: result.lanes, review: result.review };
      // runTask always lands in awaiting_user_pick — the gate can only be resolved by a human pick
      task.status = 'awaiting_pick';
    },

    completeBrainstorm(id, result) {
      const task = requireTask(id);
      task.engineTaskId = result.taskId;
      task.eventsFile = result.eventsFile;
      task.brainstorm = { lanes: result.lanes, synthesis: result.synthesis };
      task.status = 'done';
    },

    fail(id, error) {
      const task = requireTask(id);
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
    },

    markDone(id) {
      const task = requireTask(id);
      task.status = 'done';
      task.error = null;
    },

    setError(id, error) {
      const task = requireTask(id);
      task.error = error instanceof Error ? error.message : String(error);
    },
  };
}

/** a pick is valid for a task when it is "neither" or one of that task's lane letters */
export function isUserPick(value: unknown, lanes: string[]): value is UserPick {
  return value === 'neither' || (typeof value === 'string' && lanes.includes(value));
}
