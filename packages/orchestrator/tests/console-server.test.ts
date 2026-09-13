/**
 * Unit test: consoleServer + taskRegistry — the modes console API.
 * Fake engine deps drive the state machine: create → running → awaiting_pick (compete)
 * or done (brainstorm); the human pick records the gate and merges only A/B; engine
 * throws land in failed with the error message surfaced. Real wiring is in
 * scripts/modes-console.ts, so no CLI processes or git repos are touched here.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createConsoleServer,
  type BrainstormEngineResult,
  type CompeteEngineResult,
  type ConsoleDeps,
} from '../src/server/consoleServer';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeCompeteResult(): CompeteEngineResult {
  return {
    taskId: 'task-eng-1',
    state: 'awaiting_user_pick',
    lanes: [
      { lane: 'A', outcome: 'success', summary: 'summary A', diff: 'diff A', worktreePath: '/wt/a', branch: 'modes/t-A' },
      { lane: 'B', outcome: 'success', summary: 'summary B', diff: 'diff B', worktreePath: '/wt/b', branch: 'modes/t-B' },
    ],
    review: { verdict: 'agreed', rationale: 'A is cleaner', pick: 'A' },
    eventsFile: '/tmp/events.jsonl',
  };
}

function makeBrainstormResult(): BrainstormEngineResult {
  return {
    taskId: 'task-eng-2',
    lanes: [
      { lane: 'A', outcome: 'success', answer: 'answer A' },
      { lane: 'B', outcome: 'success', answer: 'answer B' },
    ],
    synthesis: 'combined',
    eventsFile: '/tmp/events.jsonl',
  };
}

function makeFakeDeps() {
  const compete = deferred<CompeteEngineResult>();
  const brainstorm = deferred<BrainstormEngineResult>();
  const deps: ConsoleDeps = {
    runCompete: vi.fn(() => compete.promise),
    runBrainstormTask: vi.fn(() => brainstorm.promise),
    recordPick: vi.fn(async () => {}),
    mergeLane: vi.fn(async () => {}),
  };
  return { deps, compete, brainstorm };
}

const servers: Server[] = [];

async function startServer(deps: ConsoleDeps): Promise<string> {
  const server = createConsoleServer(deps);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers.length = 0;
});

async function postJson(baseUrl: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function getTask(baseUrl: string, id: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/api/tasks/${id}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function waitForStatus(baseUrl: string, id: string, status: string): Promise<void> {
  await vi.waitFor(
    async () => {
      expect((await getTask(baseUrl, id)).status).toBe(status);
    },
    { timeout: 2000, interval: 20 }
  );
}

async function createCompeteTask(baseUrl: string): Promise<string> {
  const res = await postJson(baseUrl, '/api/tasks', { mode: 'compete', prompt: 'do the thing', repoPath: '/repo' });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe('GET /', () => {
  it('serves the panel HTML', async () => {
    const baseUrl = await startServer(makeFakeDeps().deps);
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('modes console');
  });
});

describe('token auth + CORS', () => {
  const TOKEN = 'test-token-123';
  const authedDeps = () => ({ ...makeFakeDeps().deps, token: TOKEN });

  it('GET /api/health is public, with and without a token configured', async () => {
    const open = await startServer(makeFakeDeps().deps);
    expect((await fetch(`${open}/api/health`)).status).toBe(200);

    const gated = await startServer(authedDeps());
    const res = await fetch(`${gated}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects /api/* without or with a wrong token (401), accepts the right one', async () => {
    const baseUrl = await startServer(authedDeps());
    expect((await fetch(`${baseUrl}/api/tasks`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/tasks`, { headers: { 'x-modes-token': 'wrong' } })).status).toBe(401);

    const res = await fetch(`${baseUrl}/api/tasks`, { headers: { 'x-modes-token': TOKEN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('keeps legacy open behavior when no token is configured', async () => {
    const baseUrl = await startServer(makeFakeDeps().deps);
    expect((await fetch(`${baseUrl}/api/tasks`)).status).toBe(200);
  });

  it('answers OPTIONS preflight with the token header allowed', async () => {
    const baseUrl = await startServer(authedDeps());
    const res = await fetch(`${baseUrl}/api/tasks`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type, x-modes-token');
  });

  it('carries access-control-allow-origin: * on API responses (401s included)', async () => {
    const baseUrl = await startServer(authedDeps());
    const unauthorized = await fetch(`${baseUrl}/api/tasks`);
    expect(unauthorized.headers.get('access-control-allow-origin')).toBe('*');
    const ok = await fetch(`${baseUrl}/api/health`);
    expect(ok.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('GET / token injection', () => {
  const TOKEN = 'test-token-123';

  it('injects window.MODES_TOKEN into the panel when a token is configured', async () => {
    const baseUrl = await startServer({ ...makeFakeDeps().deps, token: TOKEN });
    const html = await (await fetch(`${baseUrl}/`)).text();
    expect(html).toContain(`window.MODES_TOKEN = "${TOKEN}";`);
  });

  it('withholds the token from cross-origin browser readers (non-loopback Origin)', async () => {
    const baseUrl = await startServer({ ...makeFakeDeps().deps, token: TOKEN });
    const html = await (
      await fetch(`${baseUrl}/`, { headers: { origin: 'https://evil.example' } })
    ).text();
    expect(html).not.toContain('MODES_TOKEN = ');
    // a loopback Origin (e.g. the WebUI front door on another local port) still gets it
    const local = await (
      await fetch(`${baseUrl}/`, { headers: { origin: 'http://127.0.0.1:25808' } })
    ).text();
    expect(local).toContain(`window.MODES_TOKEN = "${TOKEN}";`);
  });

  it('fails loudly (500) when the panel marker drifts and a token is configured', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'modes-panel-'));
    const panelPath = path.join(dir, 'index.html');
    writeFileSync(panelPath, '<html>no marker</html>');
    try {
      const server = createConsoleServer({ ...makeFakeDeps().deps, token: TOKEN }, { panelPath });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining('marker') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/tasks', () => {
  it('rejects an invalid mode with 400', async () => {
    const baseUrl = await startServer(makeFakeDeps().deps);
    const res = await postJson(baseUrl, '/api/tasks', { mode: 'yolo', prompt: 'x' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing prompt with 400', async () => {
    const baseUrl = await startServer(makeFakeDeps().deps);
    const res = await postJson(baseUrl, '/api/tasks', { mode: 'compete' });
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON with 400', async () => {
    const baseUrl = await startServer(makeFakeDeps().deps);
    const res = await postJson(baseUrl, '/api/tasks', '{not json');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/tasks/:id', () => {
  it('returns 404 for an unknown task', async () => {
    const baseUrl = await startServer(makeFakeDeps().deps);
    const res = await fetch(`${baseUrl}/api/tasks/nope`);
    expect(res.status).toBe(404);
  });
});

describe('compete flow', () => {
  it('runs running → awaiting_pick and exposes lanes + review', async () => {
    const { deps, compete } = makeFakeDeps();
    const baseUrl = await startServer(deps);

    const id = await createCompeteTask(baseUrl);
    expect((await getTask(baseUrl, id)).status).toBe('running');
    expect(deps.runCompete).toHaveBeenCalledWith({ repoPath: '/repo', prompt: 'do the thing' });

    compete.resolve(makeCompeteResult());
    await waitForStatus(baseUrl, id, 'awaiting_pick');

    const task = await getTask(baseUrl, id);
    expect(task.engineTaskId).toBe('task-eng-1');
    expect(task.review).toEqual({ verdict: 'agreed', rationale: 'A is cleaner', pick: 'A' });
    const lanes = task.lanes as Record<string, unknown>[];
    expect(lanes).toHaveLength(2);
    expect(lanes[0]).toMatchObject({ lane: 'A', outcome: 'success', summary: 'summary A', diff: 'diff A' });
    // pick-time pointers stay server-side
    expect(lanes[0].worktreePath).toBeUndefined();

    const list = await (await fetch(`${baseUrl}/api/tasks`)).json();
    expect(list[0]).toMatchObject({ id, mode: 'compete', status: 'awaiting_pick' });
  });

  it('pick A records the gate, merges lane A, and lands in done', async () => {
    const { deps, compete } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const id = await createCompeteTask(baseUrl);
    compete.resolve(makeCompeteResult());
    await waitForStatus(baseUrl, id, 'awaiting_pick');

    const res = await postJson(baseUrl, `/api/tasks/${id}/pick`, { pick: 'A' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('done');

    expect(deps.recordPick).toHaveBeenCalledWith('/tmp/events.jsonl', {
      taskId: 'task-eng-1',
      pick: 'A',
      reviewVerdict: 'agreed',
    });
    expect(deps.mergeLane).toHaveBeenCalledWith({
      repoPath: '/repo',
      worktreePath: '/wt/a',
      branch: 'modes/t-A',
      taskId: 'task-eng-1',
      pick: 'A',
    });
  });

  it('pick neither records the gate but never merges', async () => {
    const { deps, compete } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const id = await createCompeteTask(baseUrl);
    compete.resolve(makeCompeteResult());
    await waitForStatus(baseUrl, id, 'awaiting_pick');

    const res = await postJson(baseUrl, `/api/tasks/${id}/pick`, { pick: 'neither' });
    expect(res.status).toBe(200);
    expect(deps.recordPick).toHaveBeenCalledOnce();
    expect(deps.mergeLane).not.toHaveBeenCalled();
    expect((await getTask(baseUrl, id)).status).toBe('done');
  });

  it('rejects a pick while still running with 409', async () => {
    const { deps } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const id = await createCompeteTask(baseUrl);
    const res = await postJson(baseUrl, `/api/tasks/${id}/pick`, { pick: 'A' });
    expect(res.status).toBe(409);
  });

  it('rejects a second pick after the task is done with 409', async () => {
    const { deps, compete } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const id = await createCompeteTask(baseUrl);
    compete.resolve(makeCompeteResult());
    await waitForStatus(baseUrl, id, 'awaiting_pick');
    await postJson(baseUrl, `/api/tasks/${id}/pick`, { pick: 'B' });

    const res = await postJson(baseUrl, `/api/tasks/${id}/pick`, { pick: 'A' });
    expect(res.status).toBe(409);
  });

  it('rejects an invalid pick value with 400', async () => {
    const { deps, compete } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const id = await createCompeteTask(baseUrl);
    compete.resolve(makeCompeteResult());
    await waitForStatus(baseUrl, id, 'awaiting_pick');

    const res = await postJson(baseUrl, `/api/tasks/${id}/pick`, { pick: 'C' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when picking an unknown task', async () => {
    const baseUrl = await startServer(makeFakeDeps().deps);
    const res = await postJson(baseUrl, '/api/tasks/nope/pick', { pick: 'A' });
    expect(res.status).toBe(404);
  });

  it('keeps the task awaiting_pick with an error field when the merge fails', async () => {
    const { deps, compete } = makeFakeDeps();
    vi.mocked(deps.mergeLane).mockRejectedValueOnce(new Error('merge_conflict: resolve manually'));
    const baseUrl = await startServer(deps);
    const id = await createCompeteTask(baseUrl);
    compete.resolve(makeCompeteResult());
    await waitForStatus(baseUrl, id, 'awaiting_pick');

    const res = await postJson(baseUrl, `/api/tasks/${id}/pick`, { pick: 'A' });
    expect(res.status).toBe(500);
    const task = await getTask(baseUrl, id);
    expect(task.status).toBe('awaiting_pick');
    expect(task.error).toContain('merge_conflict');
  });
});

describe('brainstorm flow', () => {
  it('runs running → done and exposes lane answers + synthesis', async () => {
    const { deps, brainstorm } = makeFakeDeps();
    const baseUrl = await startServer(deps);

    const res = await postJson(baseUrl, '/api/tasks', { mode: 'brainstorm', prompt: 'think about it' });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(deps.runBrainstormTask).toHaveBeenCalledWith({ workDir: process.cwd(), prompt: 'think about it' });

    brainstorm.resolve(makeBrainstormResult());
    await waitForStatus(baseUrl, id, 'done');

    const task = await getTask(baseUrl, id);
    expect(task.lanes).toEqual([
      { lane: 'A', outcome: 'success', answer: 'answer A' },
      { lane: 'B', outcome: 'success', answer: 'answer B' },
    ]);
    expect(task.synthesis).toBe('combined');
  });

  it('rejects a pick on a brainstorm task with 409', async () => {
    const { deps, brainstorm } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const res = await postJson(baseUrl, '/api/tasks', { mode: 'brainstorm', prompt: 'think' });
    const { id } = (await res.json()) as { id: string };
    brainstorm.resolve(makeBrainstormResult());
    await waitForStatus(baseUrl, id, 'done');

    const pickRes = await postJson(baseUrl, `/api/tasks/${id}/pick`, { pick: 'A' });
    expect(pickRes.status).toBe(409);
  });
});

describe('engine failure', () => {
  it('lands in failed with the error message surfaced', async () => {
    const { deps, compete } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const id = await createCompeteTask(baseUrl);

    compete.reject(new Error('spawn kimi ENOENT'));
    await waitForStatus(baseUrl, id, 'failed');

    const task = await getTask(baseUrl, id);
    expect(task.error).toBe('spawn kimi ENOENT');
  });
});
