/**
 * repoRegistry — repos the console knows about (tasks-as-persistent-workspaces
 * skeleton, T1). Registration is metadata only: add() validates the path is a
 * git repository, remove() only unregisters — it never touches the disk.
 *
 * Persistence mirrors the task registry: an optional injected store
 * (filePersistence's JSON file in production) saves after every change and
 * loads on init(), so registered repos survive a console restart.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** packages/orchestrator/.modes-console-repos.json (gitignored). */
export const CONSOLE_REPOS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.modes-console-repos.json'
);

export interface ConsoleRepo {
  id: string;
  /** absolute path of a git repository */
  path: string;
  addedAt: string;
}

export interface RepoPersistence {
  save(repos: unknown[]): Promise<void>;
  load(): Promise<unknown[]>;
}

export interface RepoRegistryDeps {
  persistence?: RepoPersistence;
  /** injectable for tests; defaults to `git rev-parse --is-inside-work-tree` */
  isGitRepo?: (repoPath: string) => Promise<boolean>;
}

export interface RepoRegistry {
  /** load persisted state (no-op without persistence); call once before serving */
  init(): Promise<void>;
  list(): ConsoleRepo[];
  /**
   * Register a repo. Throws when the path is not a git repository. Re-adding
   * an already-registered path returns the existing record (idempotent).
   */
  add(repoPath: string): Promise<ConsoleRepo>;
  /** Unregister by id (metadata only — the directory on disk is untouched). */
  remove(id: string): ConsoleRepo | null;
}

async function probeIsGitRepo(repoPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

/** minimal shape check — the file is ours, but a hand-edited record should not crash the console */
function isConsoleRepo(value: unknown): value is ConsoleRepo {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.path === 'string' && typeof r.addedAt === 'string';
}

export function createRepoRegistry(deps: RepoRegistryDeps = {}): RepoRegistry {
  const repos = new Map<string, ConsoleRepo>();
  const persistence = deps.persistence;
  const isGitRepo = deps.isGitRepo ?? probeIsGitRepo;
  let seq = 0;
  let saveQueue: Promise<void> = Promise.resolve();

  const persist = (): void => {
    if (!persistence) return;
    const snapshot = [...repos.values()];
    saveQueue = saveQueue.then(() => persistence.save(snapshot)).catch((err) => console.error('repo save failed:', err));
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
      for (const raw of loaded) {
        if (isConsoleRepo(raw)) repos.set(raw.id, raw);
      }
    },

    list: () => [...repos.values()].toSorted((a, b) => a.addedAt.localeCompare(b.addedAt)),

    async add(repoPath) {
      const resolved = path.resolve(repoPath);
      const existing = [...repos.values()].find((r) => r.path === resolved);
      if (existing) return existing;
      if (!(await isGitRepo(resolved))) {
        throw new Error(`"${resolved}" is not a git repository`);
      }
      seq += 1;
      const repo: ConsoleRepo = {
        id: `repo-${Date.now().toString(36)}-${seq}`,
        path: resolved,
        addedAt: new Date().toISOString(),
      };
      repos.set(repo.id, repo);
      persist();
      return repo;
    },

    remove(id) {
      const repo = repos.get(id) ?? null;
      if (repo) {
        repos.delete(id);
        persist();
      }
      return repo;
    },
  };
}
