/**
 * Unit test: repo registry + /api/repos endpoints + DELETE /api/tasks/:id/worktrees.
 * Repos: registration validates the path is a git repository, persists across
 * restarts via the injected store, and unregistration never touches the disk.
 * Worktree cleanup: the endpoint refuses running tasks, delegates to the
 * (injected) cleaner with the task's repoPath + engineTaskId, and reports the
 * cleaner's result verbatim — the real git cleanup lives in
 * worktree-cleanup.test.ts.
 */

import { execFile } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConsoleServer, type ConsoleDeps, type CompeteEngineResult } from '../src/server/consoleServer';
import { createFilePersistence } from '../src/server/filePersistence';
import { createRepoRegistry } from '../src/server/repoRegistry';

const execFileAsync = promisify(execFile);

const servers: Server[] = [];
let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers.length = 0;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-repos-'));
  tempDirs.push(dir);
  await execFileAsync('git', ['init'], { cwd: dir });
  await writeFile(path.join(dir, 'README.md'), 'seed\n');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['-c', 'user.email=t@m', '-c', 'user.name=t', 'commit', '-m', 'seed'], { cwd: dir });
  return dir;
}

function makeDeps(): ConsoleDeps {
  return {
    runCompete: vi.fn(async (): Promise<CompeteEngineResult> => ({
      taskId: 'task-eng-1',
      state: 'awaiting_user_pick',
      lanes: [
        { lane: 'A', outcome: 'success', summary: 's A', diff: 'd A', worktreePath: '/wt/a', branch: 'modes/t-A' },
        { lane: 'B', outcome: 'success', summary: 's B', diff: 'd B', worktreePath: '/wt/b', branch: 'modes/t-B' },
      ],
      review: null,
      eventsFile: '/tmp/events.jsonl',
    })),
    runBrainstormTask: vi.fn(async () => ({ taskId: 't', lanes: [], synthesis: null, eventsFile: '/tmp/e.jsonl' })),
    runCascadeTask: vi.fn(async () => ({ taskId: 't', attempts: [], winner: null, eventsFile: '/tmp/e.jsonl' })),
    runRoundtableTask: vi.fn(async () => ({ taskId: 't', rounds: [], consensus: false, synthesis: null, eventsFile: '/tmp/e.jsonl' })),
    runSingleTask: vi.fn(async () => ({
      taskId: 't',
      lane: { cli: 'kimi', outcome: 'failed', latency: 1, summary: '', diff: '', worktreePath: '/wt/s', branch: 'modes/t-s' },
      eventsFile: '/tmp/e.jsonl',
    })),
    recordPick: vi.fn(async () => {}),
    mergeLane: vi.fn(async () => {}),
  };
}

async function startServer(deps: ConsoleDeps, repos?: ReturnType<typeof createRepoRegistry>): Promise<string> {
  const server = createConsoleServer(deps, repos ? { repos } : {});
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function createCompeteTask(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'compete', prompt: 'do the thing', repoPath: '/repo' }),
  });
  return ((await res.json()) as { id: string }).id;
}

describe('repoRegistry', () => {
  it('registers a git repo, rejects a non-git directory, and is idempotent per path', async () => {
    const repo = await makeRepo();
    const notARepo = await mkdtemp(path.join(os.tmpdir(), 'modes-repos-plain-'));
    tempDirs.push(notARepo);

    const registry = createRepoRegistry();
    const added = await registry.add(repo);
    expect(added.path).toBe(repo);
    await expect(registry.add(notARepo)).rejects.toThrow('not a git repository');

    const again = await registry.add(repo + '/');
    expect(again.id).toBe(added.id);
    expect(registry.list()).toHaveLength(1);
  });

  it('remove() unregisters without touching the directory on disk', async () => {
    const repo = await makeRepo();
    const registry = createRepoRegistry();
    const added = await registry.add(repo);

    expect(registry.remove(added.id)).toEqual(added);
    expect(registry.list()).toEqual([]);
    expect(registry.remove(added.id)).toBeNull();
    await expect(readdir(repo)).resolves.toContain('README.md');
  });

  it('persists across restarts via the injected store', async () => {
    const repo = await makeRepo();
    const storeDir = await mkdtemp(path.join(os.tmpdir(), 'modes-repos-store-'));
    tempDirs.push(storeDir);
    const storePath = path.join(storeDir, 'repos.json');

    const first = createRepoRegistry({ persistence: createFilePersistence(storePath) });
    const added = await first.add(repo);
    // saves queue asynchronously — give the write a tick to land
    await vi.waitFor(async () => expect((await createFilePersistence(storePath).load()).length).toBe(1), { timeout: 2000 });

    const second = createRepoRegistry({ persistence: createFilePersistence(storePath) });
    await second.init();
    expect(second.list()).toEqual([added]);
  });
});

describe('/api/repos endpoints', () => {
  it('registers, lists and unregisters repos over HTTP', async () => {
    const repo = await makeRepo();
    const notARepo = await mkdtemp(path.join(os.tmpdir(), 'modes-repos-plain-'));
    tempDirs.push(notARepo);
    const baseUrl = await startServer(makeDeps());

    const bad = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: notARepo }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('not a git repository');

    const created = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: repo }),
    });
    expect(created.status).toBe(201);
    const repo1 = (await created.json()) as { id: string; path: string };

    const listed = (await (await fetch(`${baseUrl}/api/repos`)).json()) as { id: string }[];
    expect(listed.map((r) => r.id)).toEqual([repo1.id]);

    const removed = await fetch(`${baseUrl}/api/repos/${repo1.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect((await (await fetch(`${baseUrl}/api/repos`)).json()) as unknown[]).toEqual([]);
    // unregistering never deletes the directory
    await expect(readdir(repo)).resolves.toContain('README.md');

    expect((await fetch(`${baseUrl}/api/repos/${repo1.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('DELETE /api/tasks/:id/worktrees', () => {
  it('cleans a finished task via the injected cleaner and reports the result', async () => {
    const deps = makeDeps();
    deps.cleanWorktrees = vi.fn(async () => ({
      removed: ['/repo/.modes-worktrees/task-eng-1-A', '/repo/.modes-worktrees/task-eng-1-B'],
      branches: ['modes/task-eng-1-A', 'modes/task-eng-1-B'],
      failed: [],
    }));
    const baseUrl = await startServer(deps);
    const id = await createCompeteTask(baseUrl);
    await vi.waitFor(
      async () => expect(((await (await fetch(`${baseUrl}/api/tasks/${id}`)).json()) as { status: string }).status).toBe('awaiting_pick'),
      { timeout: 2000 }
    );

    const res = await fetch(`${baseUrl}/api/tasks/${id}/worktrees`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskId: string; removed: string[]; branches: string[]; failed: unknown[] };
    expect(body.taskId).toBe(id);
    expect(body.removed).toHaveLength(2);
    expect(body.branches).toEqual(['modes/task-eng-1-A', 'modes/task-eng-1-B']);
    expect(deps.cleanWorktrees).toHaveBeenCalledWith({ repoPath: '/repo', engineTaskId: 'task-eng-1' });

    // the task record itself survives the cleanup
    expect(((await (await fetch(`${baseUrl}/api/tasks/${id}`)).json()) as { status: string }).status).toBe('awaiting_pick');
  });

  it('reports partial failures honestly', async () => {
    const deps = makeDeps();
    deps.cleanWorktrees = vi.fn(async () => ({
      removed: ['/repo/.modes-worktrees/task-eng-1-A'],
      branches: [],
      failed: [{ target: 'modes/task-eng-1-B', error: 'branch is checked out' }],
    }));
    const baseUrl = await startServer(deps);
    const id = await createCompeteTask(baseUrl);
    await vi.waitFor(async () => expect(deps.runCompete).toHaveBeenCalled(), { timeout: 2000 });
    await vi.waitFor(
      async () => expect(((await (await fetch(`${baseUrl}/api/tasks/${id}`)).json()) as { status: string }).status).toBe('awaiting_pick'),
      { timeout: 2000 }
    );

    const res = await fetch(`${baseUrl}/api/tasks/${id}/worktrees`, { method: 'DELETE' });
    const body = (await res.json()) as { removed: string[]; failed: { target: string; error: string }[] };
    expect(body.failed).toEqual([{ target: 'modes/task-eng-1-B', error: 'branch is checked out' }]);
  });

  it('409s a running task and 404s an unknown one', async () => {
    const never = new Promise<CompeteEngineResult>(() => {});
    const deps = makeDeps();
    deps.runCompete = vi.fn(() => never);
    const baseUrl = await startServer(deps);

    const id = await createCompeteTask(baseUrl);
    const running = await fetch(`${baseUrl}/api/tasks/${id}/worktrees`, { method: 'DELETE' });
    expect(running.status).toBe(409);

    expect((await fetch(`${baseUrl}/api/tasks/nope/worktrees`, { method: 'DELETE' })).status).toBe(404);
  });
});
