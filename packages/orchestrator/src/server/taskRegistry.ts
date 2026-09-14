/**
 * taskRegistry — in-memory task state for the modes console. The engine stays
 * stateless (its truth is the JSONL event log); this registry only mirrors enough
 * for the panel to render: status machine running → awaiting_pick | done | failed,
 * the lane results, and the pick-time pointers (eventsFile / worktree / branch)
 * needed to apply a human pick later.
 *
 * Persistence is optional and injected (deps.persistence): when present, the
 * registry saves the full task records after every state change and loads them
 * back on init(), so a server restart keeps task history and still-undable
 * awaiting_pick tasks pickable. Tasks caught in 'running' at load time are
 * zombies (the process died, so the lanes are gone) and are marked failed.
 * History is pruned to the newest MAX_TASKS records by createdAt.
 */

import type { UserPick } from '../gate/userGate';
import type { ReviewVerdict } from '../review/crossReview';
import type { TaskClassification } from '../router/classifyTask';

export type ConsoleTaskMode = 'compete' | 'brainstorm' | 'cascade' | 'roundtable';
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

export interface CascadeAttemptState {
  level: number;
  cli: string;
  outcome: string;
  latency: number;
}

export interface CascadeWinnerState {
  level: number;
  cli: string;
  summary: string;
  diff: string;
  worktreePath: string;
  branch: string;
}

export interface RoundtableLaneState {
  cli: string;
  outcome: string;
  answer: string;
}

export interface RoundtableRoundState {
  round: number;
  lanes: RoundtableLaneState[];
}

export interface ConsoleTask {
  /** console-assigned id — the engine only hands back its taskId when the run finishes */
  id: string;
  /** engine taskId, known once the run resolves; null while running */
  engineTaskId: string | null;
  mode: ConsoleTaskMode;
  /** routing decision when the task was created with mode "auto"; null otherwise */
  classification: TaskClassification | null;
  prompt: string;
  repoPath: string;
  status: ConsoleTaskStatus;
  createdAt: string;
  error: string | null;
  eventsFile: string | null;
  compete: { lanes: CompeteLaneState[]; review: ReviewVerdict | null } | null;
  brainstorm: { lanes: BrainstormLaneState[]; synthesis: string | null } | null;
  cascade: { attempts: CascadeAttemptState[]; winner: CascadeWinnerState | null } | null;
  roundtable: { rounds: RoundtableRoundState[]; consensus: boolean; synthesis: string | null } | null;
}

export interface ConsoleTaskSummary {
  id: string;
  mode: ConsoleTaskMode;
  /** routing decision when the task was created with mode "auto"; null otherwise */
  classification: TaskClassification | null;
  prompt: string;
  status: ConsoleTaskStatus;
  createdAt: string;
}

/** called after every state change of one task (create, completion, failure, pick) */
export type TaskChangeListener = (task: ConsoleTask) => void;

export interface TaskRegistry {
  /** load persisted state (no-op without persistence); call once before serving */
  init(): Promise<void>;
  create(mode: ConsoleTaskMode, prompt: string, repoPath: string, classification?: TaskClassification): ConsoleTask;
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
  completeCascade(
    id: string,
    result: { taskId: string; attempts: CascadeAttemptState[]; winner: CascadeWinnerState | null; eventsFile: string }
  ): void;
  completeRoundtable(
    id: string,
    result: {
      taskId: string;
      rounds: RoundtableRoundState[];
      consensus: boolean;
      synthesis: string | null;
      eventsFile: string;
    }
  ): void;
  /** engine threw — terminal state with the message surfaced to the panel */
  fail(id: string, error: unknown): void;
  /** pick applied (recorded + merged, or recorded as "neither") */
  markDone(id: string): void;
  /** pick application failed — task stays awaiting_pick so the human can retry */
  setError(id: string, error: unknown): void;
  /**
   * Subscribe to state changes; the listener receives the changed task after
   * every mutation. Returns an unsubscribe function. Used by the console's SSE
   * endpoint to push progress instead of relying on panel polling alone.
   */
  subscribe(listener: TaskChangeListener): () => void;
}

/**
 * Durable store for console tasks. save() receives the full ConsoleTask records
 * (lanes/review/synthesis plus pick-time pointers — everything a restart needs
 * to render history and to still apply a pick); load() returns what a previous
 * save() wrote, or an empty array when there is nothing readable.
 */
export interface TaskPersistence {
  save(tasks: unknown[]): Promise<void>;
  load(): Promise<unknown[]>;
}

export interface TaskRegistryDeps {
  persistence?: TaskPersistence;
}

/** history is capped so the persistence file cannot grow without bound */
const MAX_TASKS = 100;

/** minimal shape check — the file is ours, but a hand-edited record should not crash the console */
function isConsoleTask(value: unknown): value is ConsoleTask {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    (t.status === 'running' || t.status === 'awaiting_pick' || t.status === 'done' || t.status === 'failed')
  );
}

export function createTaskRegistry(deps: TaskRegistryDeps = {}): TaskRegistry {
  const tasks = new Map<string, ConsoleTask>();
  const listeners = new Set<TaskChangeListener>();
  const persistence = deps.persistence;
  let seq = 0;
  // saves are serialized: a slow/failed write must never interleave with or block the next one
  let saveQueue: Promise<void> = Promise.resolve();

  const persist = (): void => {
    if (!persistence) return;
    const snapshot = [...tasks.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    saveQueue = saveQueue.then(() => persistence.save(snapshot)).catch((err) => console.error('task save failed:', err));
  };

  /** drop the oldest tasks beyond MAX_TASKS, then save, then notify subscribers */
  const changed = (task?: ConsoleTask): void => {
    if (tasks.size > MAX_TASKS) {
      const ordered = [...tasks.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const old of ordered.slice(0, ordered.length - MAX_TASKS)) tasks.delete(old.id);
    }
    persist();
    if (task) {
      for (const listener of listeners) {
        // a broken subscriber (e.g. a half-closed SSE socket) must not break the registry
        try {
          listener(task);
        } catch (err) {
          console.error('task change listener failed:', err);
        }
      }
    }
  };

  const requireTask = (id: string): ConsoleTask => {
    const task = tasks.get(id);
    if (!task) throw new Error(`unknown task ${id}`);
    return task;
  };

  return {
    async init() {
      if (!persistence) return;
      let loaded: unknown[];
      try {
        loaded = await persistence.load();
      } catch {
        return; // unreadable store — start with empty history rather than crash
      }
      let restored = 0;
      for (const raw of loaded) {
        if (!isConsoleTask(raw)) continue;
        if (raw.status === 'running') {
          // the process died mid-run — the lanes are gone, so it can never finish
          raw.status = 'failed';
          raw.error = 'server restarted while task was running';
        }
        tasks.set(raw.id, raw);
        restored += 1;
      }
      if (restored > 0) changed(); // persist zombie fixes and pruning
    },
    create(mode, prompt, repoPath, classification) {
      seq += 1;
      const task: ConsoleTask = {
        id: `console-${Date.now().toString(36)}-${seq}`,
        engineTaskId: null,
        mode,
        classification: classification ?? null,
        prompt,
        repoPath,
        status: 'running',
        createdAt: new Date().toISOString(),
        error: null,
        eventsFile: null,
        compete: null,
        brainstorm: null,
        cascade: null,
        roundtable: null,
      };
      tasks.set(task.id, task);
      changed(task);
      return task;
    },

    get: (id) => tasks.get(id),

    list: () =>
      [...tasks.values()]
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((t) => ({
          id: t.id,
          mode: t.mode,
          classification: t.classification,
          prompt: t.prompt,
          status: t.status,
          createdAt: t.createdAt,
        })),

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    completeCompete(id, result) {
      const task = requireTask(id);
      task.engineTaskId = result.taskId;
      task.eventsFile = result.eventsFile;
      task.compete = { lanes: result.lanes, review: result.review };
      // runTask always lands in awaiting_user_pick — the gate can only be resolved by a human pick
      task.status = 'awaiting_pick';
      changed(task);
    },

    completeBrainstorm(id, result) {
      const task = requireTask(id);
      task.engineTaskId = result.taskId;
      task.eventsFile = result.eventsFile;
      task.brainstorm = { lanes: result.lanes, synthesis: result.synthesis };
      task.status = 'done';
      changed(task);
    },

    completeCascade(id, result) {
      const task = requireTask(id);
      task.engineTaskId = result.taskId;
      task.eventsFile = result.eventsFile;
      task.cascade = { attempts: result.attempts, winner: result.winner };
      // a winner leaves the merge decision to the human; an exhausted chain is
      // terminal on its own — the failure is presented honestly, never fabricated
      task.status = result.winner ? 'awaiting_pick' : 'done';
      changed(task);
    },

    completeRoundtable(id, result) {
      const task = requireTask(id);
      task.engineTaskId = result.taskId;
      task.eventsFile = result.eventsFile;
      task.roundtable = { rounds: result.rounds, consensus: result.consensus, synthesis: result.synthesis };
      // thinking produces text, not commits — no gate, no pick (same as brainstorm)
      task.status = 'done';
      changed(task);
    },

    fail(id, error) {
      const task = requireTask(id);
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      changed(task);
    },

    markDone(id) {
      const task = requireTask(id);
      task.status = 'done';
      task.error = null;
      changed(task);
    },

    setError(id, error) {
      const task = requireTask(id);
      task.error = error instanceof Error ? error.message : String(error);
      changed(task);
    },
  };
}

/** a pick is valid for a task when it is "neither" or one of that task's lane letters */
export function isUserPick(value: unknown, lanes: string[]): value is UserPick {
  return value === 'neither' || (typeof value === 'string' && lanes.includes(value));
}
