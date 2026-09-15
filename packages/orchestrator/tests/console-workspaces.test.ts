/**
 * Unit test: workspace registry + /api/workspaces endpoints.
 *
 * Registry: CRUD, the hard busy lock (beginRun throws while running), run
 * completion storing the session id + renewal flag, persistence across
 * restarts with zombie 'running' records dropping back to idle.
 *
 * Endpoints (real git fixtures for create/delete — the worktree, branch,
 * baseRef and .env blind copy are the contract): create (generated vs given
 * name, non-git 400, duplicate 409, .env copied/skipped), detail + diff vs
 * baseRef, prompt (busy 409, spawn cwd/args/session wiring, sessionRenewed
 * landing on the run record), SSE + catch-up read (same contract as the task
 * lane routes), delete (running 409, precise cleanup, failed cleanup keeps
 * the record).
 */

import { execFile } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConsoleServer, type CompeteEngineResult, type ConsoleDeps } from '../src/server/consoleServer';
import { createFilePersistence } from '../src/server/filePersistence';
import { createWorkspaceRegistry, type Workspace, type WorkspaceRegistry } from '../src/server/workspaceRegistry';
import { createLaneStreamHub, type LaneStreamHub } from '../src/spawn/laneStream';
import { workspaceStreamKey, type WorkspaceRunOptions, type WorkspaceRunResult } from '../src/workspace/workspaceRun';

const execFileAsync = promisify(execFile);

const servers: Server[] = [];
let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers.length = 0;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeRepo(options: { env?: string } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-ws-'));
  tempDirs.push(dir);
  await execFileAsync('git', ['init'], { cwd: dir });
  await writeFile(path.join(dir, 'README.md'), 'seed\n');
  if (options.env !== undefined) await writeFile(path.join(dir, '.env'), options.env);
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['-c', 'user.email=t@m', '-c', 'user.name=t', 'commit', '-m', 'seed'], { cwd: dir });
  return dir;
}

function makeDeps(): ConsoleDeps {
  return {
    runCompete: vi.fn(async (): Promise<CompeteEngineResult> => ({
      taskId: 't', state: 'awaiting_user_pick', lanes: [], review: null, eventsFile: '/tmp/e.jsonl',
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

async function startServer(deps: ConsoleDeps, workspaces?: WorkspaceRegistry): Promise<string> {
  const server = createConsoleServer(deps, workspaces ? { workspaces } : {});
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function createWorkspace(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getWorkspace(baseUrl: string, id: string): Promise<Workspace & { diff?: { committed: string; uncommitted: string } }> {
  return (await (await fetch(`${baseUrl}/api/workspaces/${id}`)).json()) as Workspace & {
    diff?: { committed: string; uncommitted: string };
  };
}

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

/** Read SSE frames (event name + parsed data) until the stream closes. */
async function readSseUntilClose(res: Response, idleMs = 1000): Promise<SseFrame[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: SseFrame[] = [];
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- stream frames are inherently sequential
    const next = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), idleMs))]);
    if (next === null || next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = frame.split('\n').find((l) => l.startsWith('event: '))?.slice(7) ?? 'message';
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine) frames.push({ event, data: JSON.parse(dataLine.slice(6)) as Record<string, unknown> });
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
}

describe('workspaceRegistry', () => {
  it('creates, lists (runs as a count), gets and removes workspaces', () => {
    const registry = createWorkspaceRegistry();
    const ws = registry.create({
      name: 'brisk-otter', repoPath: '/repo', worktreePath: '/repo/.modes-workspaces/brisk-otter',
      branch: 'modes-ws/brisk-otter', cli: 'kimi', baseRef: 'abc123',
    });
    expect(ws.id).toMatch(/^ws-/);
    expect(ws.status).toBe('idle');
    expect(ws.sessionId).toBeNull();
    expect(registry.get(ws.id)?.name).toBe('brisk-otter');
    expect(registry.takenNames()).toEqual(new Set(['brisk-otter']));

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].runs).toBe(0);
    expect(list[0].status).toBe('idle');

    expect(registry.remove(ws.id)?.id).toBe(ws.id);
    expect(registry.get(ws.id)).toBeUndefined();
    expect(registry.remove(ws.id)).toBeNull();
  });

  it('the busy lock is hard: beginRun throws while running; completion stores session + renewal', () => {
    const registry = createWorkspaceRegistry();
    const ws = registry.create({
      name: 'w', repoPath: '/r', worktreePath: '/r/.modes-workspaces/w', branch: 'modes-ws/w', cli: 'kimi', baseRef: 'a',
    });
    const lane = registry.beginRun(ws.id, 'do a thing');
    expect(lane).toBe('run-1');
    expect(registry.get(ws.id)?.status).toBe('running');
    expect(() => registry.beginRun(ws.id, 'concurrent')).toThrow(/already running/);

    registry.completeRun(ws.id, { outcome: 'success', sessionId: 'session_x-1', sessionRenewed: false });
    const after = registry.get(ws.id) as Workspace;
    expect(after.status).toBe('idle');
    expect(after.sessionId).toBe('session_x-1');
    expect(after.runs[0]).toMatchObject({ lane: 'run-1', outcome: 'success', sessionRenewed: false });
    expect(after.runs[0].finishedAt).not.toBeNull();
    expect(after.lastActiveAt >= after.createdAt).toBe(true);

    // a renewal lands on the run record and replaces the stored id
    registry.beginRun(ws.id, 'again');
    registry.completeRun(ws.id, { outcome: 'success', sessionId: 'session_y-2', sessionRenewed: true });
    const renewed = registry.get(ws.id) as Workspace;
    expect(renewed.sessionId).toBe('session_y-2');
    expect(renewed.runs[1]).toMatchObject({ lane: 'run-2', sessionRenewed: true });
  });

  it('failRun closes the run and drops back to idle with the session untouched', () => {
    const registry = createWorkspaceRegistry();
    const ws = registry.create({
      name: 'w', repoPath: '/r', worktreePath: '/r/wt', branch: 'modes-ws/w', cli: 'kimi', baseRef: 'a',
    });
    registry.beginRun(ws.id, 'boom');
    registry.failRun(ws.id);
    const after = registry.get(ws.id) as Workspace;
    expect(after.status).toBe('idle');
    expect(after.runs[0].outcome).toBe('failed');
    expect(after.sessionId).toBeNull();
  });

  it('persists across restarts; a workspace caught running drops back to idle', async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), 'modes-ws-store-'));
    tempDirs.push(storeDir);
    const storePath = path.join(storeDir, 'workspaces.json');

    const first = createWorkspaceRegistry({ persistence: createFilePersistence(storePath) });
    const ws = first.create({
      name: 'w', repoPath: '/r', worktreePath: '/r/wt', branch: 'modes-ws/w', cli: 'kimi', baseRef: 'a',
    });
    first.beginRun(ws.id, 'mid-run when the server died');
    await vi.waitFor(async () => expect((await createFilePersistence(storePath).load()).length).toBe(1), { timeout: 2000 });

    const second = createWorkspaceRegistry({ persistence: createFilePersistence(storePath) });
    await second.init();
    const restored = second.get(ws.id) as Workspace;
    expect(restored.status).toBe('idle');
    expect(restored.runs[0].outcome).toBe('interrupted');
    expect(restored.runs[0].finishedAt).not.toBeNull();
  });
});

describe('POST /api/workspaces', () => {
  it('creates the worktree, branch and baseRef for real, generating a name when omitted', async () => {
    const repo = await makeRepo();
    const baseUrl = await startServer(makeDeps());

    const res = await createWorkspace(baseUrl, { repoPath: repo });
    expect(res.status).toBe(201);
    const ws = (await res.json()) as Workspace;
    expect(ws.name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(ws.cli).toBe('kimi');
    expect(ws.status).toBe('idle');
    expect(ws.repoPath).toBe(repo);
    expect(ws.worktreePath).toBe(path.join(repo, '.modes-workspaces', ws.name));
    expect(ws.branch).toBe(`modes-ws/${ws.name}`);

    // the worktree exists on disk, on its own branch, anchored at the repo's HEAD
    await expect(stat(ws.worktreePath)).resolves.toBeTruthy();
    const { stdout: branches } = await execFileAsync('git', ['branch', '--list', `modes-ws/${ws.name}`, '--format=%(refname:short)'], { cwd: repo });
    expect(branches.trim()).toBe(`modes-ws/${ws.name}`);
    const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    expect(ws.baseRef).toBe(head.trim());

    // and it shows up in the list
    const list = (await (await fetch(`${baseUrl}/api/workspaces`)).json()) as { id: string; status: string }[];
    expect(list.map((w) => w.id)).toEqual([ws.id]);
    expect(list[0].status).toBe('idle');
  });

  it('blind-copies a root .env into the worktree (cp -n), and skips it when absent', async () => {
    const withEnv = await makeRepo({ env: 'SECRET=hunter2\n' });
    const withoutEnv = await makeRepo();
    const baseUrl = await startServer(makeDeps());

    const ws1 = (await (await createWorkspace(baseUrl, { repoPath: withEnv, name: 'env-ws' })).json()) as Workspace;
    expect(await readFile(path.join(ws1.worktreePath, '.env'), 'utf8')).toBe('SECRET=hunter2\n');

    const ws2 = (await (await createWorkspace(baseUrl, { repoPath: withoutEnv, name: 'plain-ws' })).json()) as Workspace;
    await expect(stat(path.join(ws2.worktreePath, '.env'))).rejects.toThrow();
  });

  it('400s a non-git path and an invalid name, 409s a taken name', async () => {
    const repo = await makeRepo();
    const notARepo = await mkdtemp(path.join(os.tmpdir(), 'modes-ws-plain-'));
    tempDirs.push(notARepo);
    const baseUrl = await startServer(makeDeps());

    const badRepo = await createWorkspace(baseUrl, { repoPath: notARepo });
    expect(badRepo.status).toBe(400);
    expect(((await badRepo.json()) as { error: string }).error).toContain('not a git repository');

    expect((await createWorkspace(baseUrl, { repoPath: repo, name: 'Bad Name!' })).status).toBe(400);
    expect((await createWorkspace(baseUrl, { name: 'no-repo' })).status).toBe(400); // missing repoPath

    expect((await createWorkspace(baseUrl, { repoPath: repo, name: 'taken-ws' })).status).toBe(201);
    const dupe = await createWorkspace(baseUrl, { repoPath: repo, name: 'taken-ws' });
    expect(dupe.status).toBe(409);
  });
});

describe('GET /api/workspaces/:id', () => {
  it('returns the record plus committed (baseRef...HEAD) and uncommitted diffs', async () => {
    const repo = await makeRepo();
    const baseUrl = await startServer(makeDeps());
    const ws = (await (await createWorkspace(baseUrl, { repoPath: repo, name: 'diff-ws' })).json()) as Workspace;

    // commit a change on the workspace branch, then leave an untracked file
    await writeFile(path.join(ws.worktreePath, 'committed.txt'), 'done\n');
    await execFileAsync('git', ['add', '.'], { cwd: ws.worktreePath });
    await execFileAsync('git', ['-c', 'user.email=t@m', '-c', 'user.name=t', 'commit', '-m', 'work'], { cwd: ws.worktreePath });
    await writeFile(path.join(ws.worktreePath, 'loose.txt'), 'uncommitted\n');

    const detail = await getWorkspace(baseUrl, ws.id);
    expect(detail.baseRef).toBe(ws.baseRef);
    expect(detail.diff?.committed).toContain('committed.txt');
    expect(detail.diff?.committed).not.toContain('loose.txt');
    expect(detail.diff?.uncommitted).toContain('loose.txt');

    expect((await fetch(`${baseUrl}/api/workspaces/nope`)).status).toBe(404);
  });
});

describe('POST /api/workspaces/:id/prompt', () => {
  it('spawns in the worktree, stores the parsed session back, and resumes it on the next run', async () => {
    const repo = await makeRepo();
    const deps = makeDeps();
    const runResults: WorkspaceRunResult[] = [
      { outcome: 'success', sessionId: 'session_aaa-1', sessionRenewed: false },
      { outcome: 'success', sessionId: 'session_bbb-2', sessionRenewed: true },
    ];
    deps.runWorkspacePrompt = vi.fn(async () => runResults.shift() as WorkspaceRunResult);
    const baseUrl = await startServer(deps);
    const ws = (await (await createWorkspace(baseUrl, { repoPath: repo, name: 'prompt-ws' })).json()) as Workspace;

    const first = await fetch(`${baseUrl}/api/workspaces/${ws.id}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'create a file' }),
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ id: ws.id, lane: 'run-1', sessionId: null, resumed: false });

    await vi.waitFor(async () => expect((await getWorkspace(baseUrl, ws.id)).status).toBe('idle'), { timeout: 2000 });
    // cwd bound to the worktree by construction; first run is a fresh session
    const firstCall = (deps.runWorkspacePrompt as ReturnType<typeof vi.fn>).mock.calls[0][0] as WorkspaceRunOptions;
    expect(firstCall.worktreePath).toBe(ws.worktreePath);
    expect(firstCall.cli).toBe('kimi');
    expect(firstCall.sessionId).toBeNull();
    expect(firstCall.laneLabel).toBe('run-1');
    expect(firstCall.prompt).toBe('create a file');

    const afterFirst = await getWorkspace(baseUrl, ws.id);
    expect(afterFirst.sessionId).toBe('session_aaa-1');
    expect(afterFirst.runs[0]).toMatchObject({ lane: 'run-1', outcome: 'success', sessionRenewed: false });

    // second run resumes the stored session; a silent renewal is flagged on the record
    const second = await fetch(`${baseUrl}/api/workspaces/${ws.id}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'update it' }),
    });
    expect(await second.json()).toEqual({ id: ws.id, lane: 'run-2', sessionId: 'session_aaa-1', resumed: true });
    await vi.waitFor(async () => expect((await getWorkspace(baseUrl, ws.id)).status).toBe('idle'), { timeout: 2000 });

    const secondCall = (deps.runWorkspacePrompt as ReturnType<typeof vi.fn>).mock.calls[1][0] as WorkspaceRunOptions;
    expect(secondCall.sessionId).toBe('session_aaa-1');
    expect(secondCall.laneLabel).toBe('run-2');

    const afterSecond = await getWorkspace(baseUrl, ws.id);
    expect(afterSecond.sessionId).toBe('session_bbb-2');
    expect(afterSecond.runs[1]).toMatchObject({ lane: 'run-2', sessionRenewed: true });
  });

  it('409s while a run is live (hard busy lock) and while deleting', async () => {
    const repo = await makeRepo();
    const deps = makeDeps();
    let release: ((r: WorkspaceRunResult) => void) | null = null;
    deps.runWorkspacePrompt = vi.fn(() => new Promise<WorkspaceRunResult>((resolve) => { release = resolve; }));
    deps.cleanWorkspace = vi.fn(async () => ({ removed: [], branches: [], failed: [] }));
    const baseUrl = await startServer(deps);
    const ws = (await (await createWorkspace(baseUrl, { repoPath: repo, name: 'busy-ws' })).json()) as Workspace;

    expect((await fetch(`${baseUrl}/api/workspaces/${ws.id}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'one' }),
    })).status).toBe(202);

    const concurrent = await fetch(`${baseUrl}/api/workspaces/${ws.id}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'two' }),
    });
    expect(concurrent.status).toBe(409);
    expect((await fetch(`${baseUrl}/api/workspaces/${ws.id}`, { method: 'DELETE' })).status).toBe(409);

    release!({ outcome: 'success', sessionId: null, sessionRenewed: false });
    await vi.waitFor(async () => expect((await getWorkspace(baseUrl, ws.id)).status).toBe('idle'), { timeout: 2000 });

    // idle again: the next prompt is accepted
    expect((await fetch(`${baseUrl}/api/workspaces/${ws.id}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'three' }),
    })).status).toBe(202);
    release!({ outcome: 'failed', sessionId: null, sessionRenewed: false });
    await vi.waitFor(async () => expect((await getWorkspace(baseUrl, ws.id)).status).toBe('idle'), { timeout: 2000 });
  });

  it('400s an empty text and 404s an unknown workspace', async () => {
    const repo = await makeRepo();
    const deps = makeDeps();
    deps.runWorkspacePrompt = vi.fn(async () => ({ outcome: 'success', sessionId: null, sessionRenewed: false }));
    const baseUrl = await startServer(deps);
    const ws = (await (await createWorkspace(baseUrl, { repoPath: repo, name: 'edge-ws' })).json()) as Workspace;

    expect((await fetch(`${baseUrl}/api/workspaces/${ws.id}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '  ' }),
    })).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/workspaces/nope/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
    })).status).toBe(404);
    // a rejected prompt never started a run
    expect((await getWorkspace(baseUrl, ws.id)).runs).toEqual([]);
  });
});

describe('workspace SSE + catch-up reads', () => {
  it('streams lane_output under ws-<id>/run-N, closes on idle, and serves catch-up reads', async () => {
    const repo = await makeRepo();
    const hubDir = await mkdtemp(path.join(os.tmpdir(), 'modes-ws-stream-'));
    tempDirs.push(hubDir);
    const hub: LaneStreamHub = createLaneStreamHub({ dir: hubDir, batchWindowMs: 10 });
    const deps = makeDeps();
    deps.laneStreams = hub;
    deps.runWorkspacePrompt = vi.fn(async (options: WorkspaceRunOptions) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      options.stream?.write(options.laneLabel, 'chunk-1;');
      options.stream?.write(options.laneLabel, 'chunk-2;');
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { outcome: 'success', sessionId: 'session_s-1', sessionRenewed: false };
    });
    const baseUrl = await startServer(deps);
    const ws = (await (await createWorkspace(baseUrl, { repoPath: repo, name: 'stream-ws' })).json()) as Workspace;

    await fetch(`${baseUrl}/api/workspaces/${ws.id}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'go' }),
    });

    const frames = await readSseUntilClose(await fetch(`${baseUrl}/api/workspaces/${ws.id}/events`));
    const outputs = frames.filter((f) => f.event === 'lane_output');
    expect(outputs.length).toBeGreaterThanOrEqual(1);
    expect(outputs.map((f) => String(f.data.chunk)).join('')).toBe('chunk-1;chunk-2;');
    expect(outputs.every((f) => f.data.lane === 'run-1')).toBe(true);
    // state frames are unnamed message events; the terminal one is idle
    const messages = frames.filter((f) => f.event === 'message');
    expect(String(messages[messages.length - 1].data.status)).toBe('idle');

    // the stream file lives under the ws-<id> key
    expect(await readFile(hub.streamPath(workspaceStreamKey(ws.id), 'run-1'), 'utf8')).toBe('chunk-1;chunk-2;');

    // catch-up read: full content, then incremental from the returned offset
    const full = (await (
      await fetch(`${baseUrl}/api/workspaces/${ws.id}/runs/run-1/output`)
    ).json()) as Record<string, unknown>;
    expect(full).toMatchObject({ workspaceId: ws.id, lane: 'run-1', content: 'chunk-1;chunk-2;', truncated: false });
    hub.bind(workspaceStreamKey(ws.id)).write('run-1', 'late;');
    const incremental = (await (
      await fetch(`${baseUrl}/api/workspaces/${ws.id}/runs/run-1/output?offset=${full.offset}`)
    ).json()) as Record<string, unknown>;
    expect(incremental.content).toBe('late;');

    expect((await fetch(`${baseUrl}/api/workspaces/${ws.id}/runs/run-1/output?offset=-1`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/workspaces/nope/runs/run-1/output`)).status).toBe(404);
  });

  it('404s the events and output routes for unknown workspaces', async () => {
    const baseUrl = await startServer(makeDeps());
    expect((await fetch(`${baseUrl}/api/workspaces/nope/events`)).status).toBe(404);
  });
});

describe('DELETE /api/workspaces/:id', () => {
  it('removes the worktree and branch for real, then unregisters the record', async () => {
    const repo = await makeRepo();
    const baseUrl = await startServer(makeDeps());
    const ws = (await (await createWorkspace(baseUrl, { repoPath: repo, name: 'gone-ws' })).json()) as Workspace;
    await expect(stat(ws.worktreePath)).resolves.toBeTruthy();

    const res = await fetch(`${baseUrl}/api/workspaces/${ws.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; removed: string[]; branches: string[]; failed: unknown[] };
    expect(body.id).toBe(ws.id);
    expect(body.removed).toEqual([ws.worktreePath]);
    expect(body.branches).toEqual([`modes-ws/gone-ws`]);
    expect(body.failed).toEqual([]);

    await expect(stat(ws.worktreePath)).rejects.toThrow();
    const { stdout: branches } = await execFileAsync('git', ['branch', '--list', 'modes-ws/gone-ws'], { cwd: repo });
    expect(branches.trim()).toBe('');
    expect((await (await fetch(`${baseUrl}/api/workspaces`)).json()) as unknown[]).toEqual([]);
    expect((await fetch(`${baseUrl}/api/workspaces/${ws.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('a failed cleanup keeps the record and reports the failure', async () => {
    const repo = await makeRepo();
    const deps = makeDeps();
    deps.cleanWorkspace = vi.fn(async () => ({
      removed: [], branches: [], failed: [{ target: 'modes-ws/stuck-ws', error: 'branch is checked out' }],
    }));
    const baseUrl = await startServer(deps);
    const ws = (await (await createWorkspace(baseUrl, { repoPath: repo, name: 'stuck-ws' })).json()) as Workspace;

    const res = await fetch(`${baseUrl}/api/workspaces/${ws.id}`, { method: 'DELETE' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { failed: { target: string }[] };
    expect(body.failed[0].target).toBe('modes-ws/stuck-ws');
    // record survives for a retry
    expect(((await (await fetch(`${baseUrl}/api/workspaces`)).json()) as { id: string }[]).map((w) => w.id)).toEqual([ws.id]);
  });
});
