/**
 * workspaceRegistry — workspaces as first-class, persistent citizens.
 *
 * A workspace is a NAMED, long-lived git worktree (`.modes-workspaces/<name>`,
 * branch `modes-ws/<name>`) with one continuable agent session — the pivot from
 * "tasks as one-shot consumables" (feasibility report 2026-09-15 §一/§五:
 * Orca/Conductor/Nimbalyst all won on exactly this model). The existing task
 * model stays untouched; workspaces are a parallel concept.
 *
 * The registry mirrors taskRegistry: in-memory truth, optional injected
 * persistence (filePersistence's JSON file in production) saved after every
 * change and loaded on init(). Workspaces caught in 'running' at load time are
 * zombies (the server process died, so the run is gone) and drop back to
 * 'idle' — the session is resumable, so nothing is lost.
 *
 * The busy lock is HARD (feasibility §五 修正 #1: two concurrent resumes of the
 * same session corrupt the CLI's session record — Claude double-writes the
 * JSONL transcript, Codex errors with "active writer"). The registry only
 * exposes beginRun() → completeRun()/failRun(); the endpoint 409s on running.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** packages/orchestrator/.modes-console-workspaces.json (gitignored). */
export const CONSOLE_WORKSPACES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.modes-console-workspaces.json'
);

/** one prompt run inside a workspace; the full history is the run log */
export interface WorkspaceRun {
  /** stream label: run-1, run-2… */
  lane: string;
  prompt: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  /**
   * true when a resume attempt came back under a DIFFERENT session id — the
   * old session had silently died (kimi opens a fresh session for unknown ids
   * without any error) and the CLI renewed it. User-visible, never silent.
   */
  sessionRenewed: boolean;
}

export interface Workspace {
  id: string;
  /** human handle; also the worktree dir suffix and branch suffix */
  name: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  cli: string;
  /** resumable agent session (kimi session_*); null until the first run parses one */
  sessionId: string | null;
  status: 'idle' | 'running';
  createdAt: string;
  lastActiveAt: string;
  /** commit the worktree branched from — the base for the detail diff */
  baseRef: string;
  runs: WorkspaceRun[];
}

export type WorkspaceSummary = Omit<Workspace, 'runs'> & { runs: number };

export type WorkspaceChangeListener = (workspace: Workspace) => void;

export interface WorkspacePersistence {
  save(workspaces: unknown[]): Promise<void>;
  load(): Promise<unknown[]>;
}

export interface WorkspaceRegistryDeps {
  persistence?: WorkspacePersistence;
}

export interface WorkspaceRegistry {
  /** load persisted state (no-op without persistence); call once before serving */
  init(): Promise<void>;
  /** names already taken — the endpoint feeds this to generateWorkspaceName */
  takenNames(): Set<string>;
  create(record: Omit<Workspace, 'id' | 'status' | 'createdAt' | 'lastActiveAt' | 'runs' | 'sessionId'>): Workspace;
  get(id: string): Workspace | undefined;
  list(): WorkspaceSummary[];
  /**
   * Busy lock: flip idle → running and open a run record. Returns the run
   * label (run-N). Throws when the workspace is already running — concurrent
   * resumes of one session corrupt the CLI's session store, so this must
   * never silently queue (feasibility §五 修正 #1).
   */
  beginRun(id: string, prompt: string): string;
  /** run finished: session id + renewal flag land on the model, back to idle */
  completeRun(id: string, result: { outcome: string; sessionId: string | null; sessionRenewed: boolean }): void;
  /** run threw: close the run record, back to idle with the session untouched */
  failRun(id: string, outcome?: string): void;
  remove(id: string): Workspace | null;
  subscribe(listener: WorkspaceChangeListener): () => void;
}

/** minimal shape check — the file is ours, but a hand-edited record should not crash the console */
function isWorkspace(value: unknown): value is Workspace {
  if (typeof value !== 'object' || value === null) return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.id === 'string' &&
    typeof w.name === 'string' &&
    typeof w.repoPath === 'string' &&
    typeof w.worktreePath === 'string' &&
    typeof w.branch === 'string' &&
    typeof w.baseRef === 'string' &&
    (w.status === 'idle' || w.status === 'running')
  );
}

/** Orca's friction-killer: no name given → adjective + sea animal (`brisk-otter`) */
const NAME_ADJECTIVES = [
  'amber', 'bold', 'brisk', 'calm', 'clever', 'crisp', 'dawn', 'deft',
  'eager', 'ember', 'faint', 'fleet', 'frost', 'gentle', 'glad', 'golden',
  'hazy', 'ivory', 'jolly', 'keen', 'lively', 'lucid', 'lunar', 'mellow',
  'misty', 'nimble', 'noble', 'opal', 'patient', 'proud', 'quick', 'quiet',
  'rapid', 'rosy', 'rustic', 'serene', 'sharp', 'silver', 'solar', 'steady',
  'stormy', 'sunny', 'swift', 'tidal', 'vivid', 'warm', 'wild', 'zephyr',
] as const;

const NAME_ANIMALS = [
  'anchovy', 'barracuda', 'clam', 'cod', 'coral', 'crab', 'dolphin', 'eel',
  'falcon', 'flounder', 'grouper', 'gull', 'herring', 'jellyfish', 'kelp', 'krill',
  'lobster', 'mackerel', 'manatee', 'marlin', 'minnow', 'narwhal', 'octopus', 'orca',
  'otter', 'oyster', 'pelican', 'penguin', 'perch', 'pike', 'polyp', 'puffin',
  'ray', 'salmon', 'sardine', 'scallop', 'seal', 'shark', 'shrimp', 'squid',
  'starfish', 'sturgeon', 'tern', 'trout', 'tuna', 'turtle', 'urchin', 'walrus',
] as const;

const pick = <T>(list: readonly T[], rng: () => number): T => list[Math.floor(rng() * list.length)];

/**
 * Random `adjective-animal` not in `taken`; after 50 collisions (the pool is
 * 48×48 = 2304, so this means the pool is nearly exhausted) falls back to a
 * numeric suffix. Deterministic injectable rng for tests.
 */
export function generateWorkspaceName(taken: ReadonlySet<string>, rng: () => number = Math.random): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const name = `${pick(NAME_ADJECTIVES, rng)}-${pick(NAME_ANIMALS, rng)}`;
    if (!taken.has(name)) return name;
  }
  let suffix = 2;
  const base = `${pick(NAME_ADJECTIVES, rng)}-${pick(NAME_ANIMALS, rng)}`;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** user-given names become a path segment and a branch suffix — keep them boring */
export const WORKSPACE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function createWorkspaceRegistry(deps: WorkspaceRegistryDeps = {}): WorkspaceRegistry {
  const workspaces = new Map<string, Workspace>();
  const listeners = new Set<WorkspaceChangeListener>();
  const persistence = deps.persistence;
  let seq = 0;
  // saves are serialized: a slow/failed write must never interleave with or block the next one
  let saveQueue: Promise<void> = Promise.resolve();

  const persist = (): void => {
    if (!persistence) return;
    const snapshot = [...workspaces.values()];
    saveQueue = saveQueue.then(() => persistence.save(snapshot)).catch((err) => console.error('workspace save failed:', err));
  };

  const changed = (workspace?: Workspace): void => {
    persist();
    if (workspace) {
      for (const listener of listeners) {
        // a broken subscriber (e.g. a half-closed SSE socket) must not break the registry
        try {
          listener(workspace);
        } catch (err) {
          console.error('workspace change listener failed:', err);
        }
      }
    }
  };

  const requireWorkspace = (id: string): Workspace => {
    const ws = workspaces.get(id);
    if (!ws) throw new Error(`unknown workspace ${id}`);
    return ws;
  };

  return {
    async init() {
      if (!persistence) return;
      let loaded: unknown[];
      try {
        loaded = await persistence.load();
      } catch {
        return; // unreadable store — start empty rather than crash
      }
      let restored = 0;
      for (const raw of loaded) {
        if (!isWorkspace(raw)) continue;
        if (raw.status === 'running') {
          // the process died mid-run — the spawn is gone with it; the session
          // is resumable, so dropping back to idle loses nothing
          raw.status = 'idle';
          const open = raw.runs.find((r) => r.finishedAt === null);
          if (open) {
            open.finishedAt = new Date().toISOString();
            open.outcome = 'interrupted';
          }
        }
        // records written before runs/sessionId existed get the defaults
        raw.runs ??= [];
        raw.sessionId ??= null;
        workspaces.set(raw.id, raw);
        restored += 1;
      }
      if (restored > 0) changed(); // persist zombie fixes
    },

    takenNames: () => new Set([...workspaces.values()].map((w) => w.name)),

    create(record) {
      seq += 1;
      const now = new Date().toISOString();
      const workspace: Workspace = {
        ...record,
        id: `ws-${Date.now().toString(36)}-${seq}`,
        sessionId: null,
        status: 'idle',
        createdAt: now,
        lastActiveAt: now,
        runs: [],
      };
      workspaces.set(workspace.id, workspace);
      changed(workspace);
      return workspace;
    },

    get: (id) => workspaces.get(id),

    list: () =>
      [...workspaces.values()]
        .toSorted((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
        .map((w) => ({
          id: w.id,
          name: w.name,
          repoPath: w.repoPath,
          worktreePath: w.worktreePath,
          branch: w.branch,
          cli: w.cli,
          sessionId: w.sessionId,
          status: w.status,
          createdAt: w.createdAt,
          lastActiveAt: w.lastActiveAt,
          baseRef: w.baseRef,
          runs: w.runs.length,
        })),

    beginRun(id, prompt) {
      const ws = requireWorkspace(id);
      if (ws.status === 'running') {
        throw new Error(`workspace ${id} is already running — concurrent resumes would corrupt the session`);
      }
      const lane = `run-${ws.runs.length + 1}`;
      ws.runs.push({ lane, prompt, startedAt: new Date().toISOString(), finishedAt: null, outcome: null, sessionRenewed: false });
      ws.status = 'running';
      changed(ws);
      return lane;
    },

    completeRun(id, result) {
      const ws = requireWorkspace(id);
      const run = ws.runs[ws.runs.length - 1];
      run.finishedAt = new Date().toISOString();
      run.outcome = result.outcome;
      run.sessionRenewed = result.sessionRenewed;
      if (result.sessionId) ws.sessionId = result.sessionId;
      ws.status = 'idle';
      ws.lastActiveAt = run.finishedAt;
      changed(ws);
    },

    failRun(id, outcome = 'failed') {
      const ws = requireWorkspace(id);
      const run = ws.runs[ws.runs.length - 1];
      if (run && run.finishedAt === null) {
        run.finishedAt = new Date().toISOString();
        run.outcome = outcome;
      }
      ws.status = 'idle';
      ws.lastActiveAt = new Date().toISOString();
      changed(ws);
    },

    remove(id) {
      const ws = workspaces.get(id) ?? null;
      if (ws) {
        workspaces.delete(id);
        persist();
      }
      return ws;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
