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
  type CascadeEngineResult,
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

/**
 * winnerLevel: which chain level won (1-based), or null for an exhausted chain.
 * Attempts are shaped consistently: levels before the winner failed, levels
 * after it never ran.
 */
function makeCascadeResult(winnerLevel: number | null = 1): CascadeEngineResult {
  const attempts = [
    { level: 1, cli: 'qwen', outcome: winnerLevel === 1 ? 'success' : 'failed', latency: 1200 },
    ...(winnerLevel === 1
      ? []
      : [{ level: 2, cli: 'kimi', outcome: winnerLevel === 2 ? 'success' : 'failed', latency: 3400 }]),
  ];
  const winner =
    winnerLevel === null
      ? null
      : {
          level: winnerLevel,
          cli: winnerLevel === 1 ? 'qwen' : 'kimi',
          summary: `summary L${winnerLevel}`,
          diff: `diff L${winnerLevel}`,
          worktreePath: `/wt/cascade-${winnerLevel}`,
          branch: `modes/t-cascade-${winnerLevel}`,
        };
  return { taskId: 'task-eng-3', attempts, winner, eventsFile: '/tmp/events.jsonl' };
}

function makeFakeDeps() {
  const compete = deferred<CompeteEngineResult>();
  const brainstorm = deferred<BrainstormEngineResult>();
  const cascade = deferred<CascadeEngineResult>();
  const deps: ConsoleDeps = {
    runCompete: vi.fn(() => compete.promise),
    runBrainstormTask: vi.fn(() => brainstorm.promise),
    runCascadeTask: vi.fn(() => cascade.promise),
    recordPick: vi.fn(async () => {}),
    mergeLane: vi.fn(async () => {}),
  };
  return { deps, compete, brainstorm, cascade };
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

/**
 * Read up to `count` SSE data frames from an events response, then check
 * whether the server closed the stream (short race, since the terminal close
 * lands right after the final frame).
 */
async function collectEvents(res: Response, count: number): Promise<{ events: Record<string, unknown>[]; closed: boolean }> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Record<string, unknown>[] = [];
  let closed = false;
  while (events.length < count) {
    // oxlint-disable-next-line no-await-in-loop -- stream frames are inherently sequential
    const { done, value } = await reader.read();
    if (done) {
      closed = true;
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine) events.push(JSON.parse(dataLine.slice(6)) as Record<string, unknown>);
    }
  }
  if (!closed) {
    const next = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 500))]);
    closed = next?.done === true;
  }
  await reader.cancel().catch(() => {});
  return { events, closed };
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

  it('N lanes: pick C is accepted and merges lane C', async () => {
    const { deps, compete } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const id = await createCompeteTask(baseUrl);
    const threeLane = makeCompeteResult();
    threeLane.lanes.push({ lane: 'C', outcome: 'success', summary: 'summary C', diff: 'diff C', worktreePath: '/wt/c', branch: 'modes/t-C' });
    compete.resolve(threeLane);
    await waitForStatus(baseUrl, id, 'awaiting_pick');

    const res = await postJson(baseUrl, `/api/tasks/${id}/pick`, { pick: 'C' });
    expect(res.status).toBe(200);
    expect(deps.mergeLane).toHaveBeenCalledWith({
      repoPath: '/repo',
      worktreePath: '/wt/c',
      branch: 'modes/t-C',
      taskId: 'task-eng-1',
      pick: 'C',
    });
  });

  it('N lanes: a pick outside the task lanes is rejected with 400 listing the options', async () => {
    const { deps, compete } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const id = await createCompeteTask(baseUrl);
    const threeLane = makeCompeteResult();
    threeLane.lanes.push({ lane: 'C', outcome: 'success', summary: 'summary C', diff: 'diff C', worktreePath: '/wt/c', branch: 'modes/t-C' });
    compete.resolve(threeLane);
    await waitForStatus(baseUrl, id, 'awaiting_pick');

    const res = await postJson(baseUrl, `/api/tasks/${id}/pick`, { pick: 'D' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('neither');
    expect(deps.mergeLane).not.toHaveBeenCalled();
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

describe('cascade flow', () => {
  async function createCascadeTask(baseUrl: string, body: Record<string, unknown> = {}): Promise<string> {
    const res = await postJson(baseUrl, '/api/tasks', { mode: 'cascade', prompt: 'cheap first', repoPath: '/repo', ...body });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it('runs running → awaiting_pick and exposes attempts + winner, hiding pick-time pointers', async () => {
    const { deps, cascade } = makeFakeDeps();
    const baseUrl = await startServer(deps);

    const id = await createCascadeTask(baseUrl);
    expect((await getTask(baseUrl, id)).status).toBe('running');
    // no chain in the request → the server supplies the modes-run default, cheapest first
    expect(deps.runCascadeTask).toHaveBeenCalledWith({
      repoPath: '/repo',
      prompt: 'cheap first',
      chain: [{ cli: 'qwen' }, { cli: 'kimi' }],
    });

    cascade.resolve(makeCascadeResult(1));
    await waitForStatus(baseUrl, id, 'awaiting_pick');

    const task = await getTask(baseUrl, id);
    expect(task.mode).toBe('cascade');
    expect(task.engineTaskId).toBe('task-eng-3');
    expect(task.attempts).toEqual([{ level: 1, cli: 'qwen', outcome: 'success', latency: 1200 }]);
    expect(task.winner).toMatchObject({ level: 1, cli: 'qwen', summary: 'summary L1', diff: 'diff L1' });
    // pick-time pointers stay server-side, same as compete lanes
    expect((task.winner as Record<string, unknown>).worktreePath).toBeUndefined();
    expect((task.winner as Record<string, unknown>).branch).toBeUndefined();
    expect(task.eventsFile).toBeUndefined();

    const list = (await (await fetch(`${baseUrl}/api/tasks`)).json()) as Record<string, unknown>[];
    expect(list[0]).toMatchObject({ id, mode: 'cascade', status: 'awaiting_pick' });
  });

  it('passes a request-body chain through to the engine instead of the default', async () => {
    const { deps, cascade } = makeFakeDeps();
    const baseUrl = await startServer(deps);

    const chain = [{ cli: 'a' }, { cli: 'b', timeoutMs: 5000 }, { cli: 'c' }];
    await createCascadeTask(baseUrl, { chain });
    expect(deps.runCascadeTask).toHaveBeenCalledWith({ repoPath: '/repo', prompt: 'cheap first', chain });
    cascade.resolve(makeCascadeResult(null));
  });

  it('rejects a malformed chain with 400', async () => {
    const baseUrl = await startServer(makeFakeDeps().deps);
    for (const chain of [[], [{ cli: 5 }], [{ timeoutMs: 1000 }], 'qwen,kimi']) {
      // oxlint-disable-next-line no-await-in-loop -- sequential requests keep the assertions ordered and readable
      const res = await postJson(baseUrl, '/api/tasks', { mode: 'cascade', prompt: 'x', chain });
      expect(res.status).toBe(400);
    }
  });

  it('no winner → done (chain exhausted), and a pick is rejected with 409', async () => {
    const { deps, cascade } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const id = await createCascadeTask(baseUrl);

    cascade.resolve(makeCascadeResult(null));
    await waitForStatus(baseUrl, id, 'done');

    const task = await getTask(baseUrl, id);
    expect(task.winner).toBeNull();
    expect(task.attempts).toEqual([
      { level: 1, cli: 'qwen', outcome: 'failed', latency: 1200 },
      { level: 2, cli: 'kimi', outcome: 'failed', latency: 3400 },
    ]);

    const res = await postJson(baseUrl, `/api/tasks/${id}/pick`, { pick: 'cascade-1' });
    expect(res.status).toBe(409);
    expect(deps.recordPick).not.toHaveBeenCalled();
  });

  it('pick cascade-N records the gate and merges the winner worktree', async () => {
    const { deps, cascade } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const id = await createCascadeTask(baseUrl);
    cascade.resolve(makeCascadeResult(2)); // level 1 failed, level 2 won
    await waitForStatus(baseUrl, id, 'awaiting_pick');

    const res = await postJson(baseUrl, `/api/tasks/${id}/pick`, { pick: 'cascade-2' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('done');

    expect(deps.recordPick).toHaveBeenCalledWith('/tmp/events.jsonl', {
      taskId: 'task-eng-3',
      pick: 'cascade-2',
      reviewVerdict: null,
    });
    expect(deps.mergeLane).toHaveBeenCalledWith({
      repoPath: '/repo',
      worktreePath: '/wt/cascade-2',
      branch: 'modes/t-cascade-2',
      taskId: 'task-eng-3',
      pick: 'cascade-2',
    });
  });

  it('rejects a pick that does not match the winner level (cascade-2 vs level-1 winner) with 400', async () => {
    const { deps, cascade } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const id = await createCascadeTask(baseUrl);
    cascade.resolve(makeCascadeResult(1));
    await waitForStatus(baseUrl, id, 'awaiting_pick');

    const res = await postJson(baseUrl, `/api/tasks/${id}/pick`, { pick: 'cascade-2' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('neither');
    expect(deps.recordPick).not.toHaveBeenCalled();
    expect(deps.mergeLane).not.toHaveBeenCalled();
    expect((await getTask(baseUrl, id)).status).toBe('awaiting_pick');
  });

  it('pick neither records the gate but never merges', async () => {
    const { deps, cascade } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const id = await createCascadeTask(baseUrl);
    cascade.resolve(makeCascadeResult(1));
    await waitForStatus(baseUrl, id, 'awaiting_pick');

    const res = await postJson(baseUrl, `/api/tasks/${id}/pick`, { pick: 'neither' });
    expect(res.status).toBe(200);
    expect(deps.recordPick).toHaveBeenCalledWith('/tmp/events.jsonl', {
      taskId: 'task-eng-3',
      pick: 'neither',
      reviewVerdict: null,
    });
    expect(deps.mergeLane).not.toHaveBeenCalled();
    expect((await getTask(baseUrl, id)).status).toBe('done');
  });
});

describe('auto mode routing', () => {
  it('resolves an executional prompt to cascade at request time and stores the classification', async () => {
    const { deps, cascade } = makeFakeDeps();
    const baseUrl = await startServer(deps);

    const res = await postJson(baseUrl, '/api/tasks', {
      mode: 'auto',
      prompt: 'Create a file util.js with a clamp function',
      repoPath: '/repo',
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    // classification is synchronous (a pure function): the resolved engine is
    // already running with the default chain by the time POST returns
    expect(deps.runCascadeTask).toHaveBeenCalledWith({
      repoPath: '/repo',
      prompt: 'Create a file util.js with a clamp function',
      chain: [{ cli: 'qwen' }, { cli: 'kimi' }],
    });
    expect(deps.runCompete).not.toHaveBeenCalled();
    expect(deps.runBrainstormTask).not.toHaveBeenCalled();

    cascade.resolve(makeCascadeResult(1));
    await waitForStatus(baseUrl, id, 'awaiting_pick');

    const task = await getTask(baseUrl, id);
    expect(task.mode).toBe('cascade');
    expect(task.classification).toMatchObject({ mode: 'cascade', confidence: 'high' });
    expect((task.classification as { reason: string }).reason.length).toBeGreaterThan(0);

    // the list summary carries the classification too (the panel badges auto tasks)
    const list = (await (await fetch(`${baseUrl}/api/tasks`)).json()) as Record<string, unknown>[];
    expect(list[0]).toMatchObject({ id, mode: 'cascade', classification: { mode: 'cascade' } });
  });

  it('resolves an opinion prompt to brainstorm', async () => {
    const { deps, brainstorm } = makeFakeDeps();
    const baseUrl = await startServer(deps);

    const res = await postJson(baseUrl, '/api/tasks', { mode: 'auto', prompt: '你怎么看这个方案', repoPath: '/repo' });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(deps.runBrainstormTask).toHaveBeenCalledWith({ workDir: '/repo', prompt: '你怎么看这个方案' });

    brainstorm.resolve(makeBrainstormResult());
    await waitForStatus(baseUrl, id, 'done');

    const task = await getTask(baseUrl, id);
    expect(task.mode).toBe('brainstorm');
    expect(task.classification).toMatchObject({ mode: 'brainstorm', confidence: 'high' });
  });

  it('resolves explicit multi-version intent to compete', async () => {
    const { deps, compete } = makeFakeDeps();
    const baseUrl = await startServer(deps);

    const res = await postJson(baseUrl, '/api/tasks', { mode: 'auto', prompt: '给我两个方案实现防抖', repoPath: '/repo' });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(deps.runCompete).toHaveBeenCalledWith({ repoPath: '/repo', prompt: '给我两个方案实现防抖' });

    compete.resolve(makeCompeteResult());
    await waitForStatus(baseUrl, id, 'awaiting_pick');

    const task = await getTask(baseUrl, id);
    expect(task.mode).toBe('compete');
    expect(task.classification).toMatchObject({ mode: 'compete' });
  });

  it('explicit-mode tasks carry classification null', async () => {
    const { deps, compete } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const id = await createCompeteTask(baseUrl);
    compete.resolve(makeCompeteResult());
    await waitForStatus(baseUrl, id, 'awaiting_pick');
    expect((await getTask(baseUrl, id)).classification).toBeNull();
  });
});

describe('GET /api/tasks/:id/events (SSE)', () => {
  it('returns 404 for an unknown task', async () => {
    const baseUrl = await startServer(makeFakeDeps().deps);
    const res = await fetch(`${baseUrl}/api/tasks/nope/events`);
    expect(res.status).toBe(404);
  });

  it('sends the current state, pushes status changes, and closes after a terminal status', async () => {
    const { deps, compete } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const id = await createCompeteTask(baseUrl);

    const res = await fetch(`${baseUrl}/api/tasks/${id}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    compete.resolve(makeCompeteResult());
    const { events, closed } = await collectEvents(res, 2);
    expect(events[0]).toMatchObject({ id, status: 'running' });
    expect(events[1]).toMatchObject({ id, status: 'awaiting_pick' });
    // awaiting_pick is terminal for the stream — the server hangs up
    expect(closed).toBe(true);
  });

  it('a late subscriber to a finished task gets the final state and a closed stream', async () => {
    const { deps, brainstorm } = makeFakeDeps();
    const baseUrl = await startServer(deps);
    const res = await postJson(baseUrl, '/api/tasks', { mode: 'brainstorm', prompt: 'think' });
    const { id } = (await res.json()) as { id: string };
    brainstorm.resolve(makeBrainstormResult());
    await waitForStatus(baseUrl, id, 'done');

    const stream = await fetch(`${baseUrl}/api/tasks/${id}/events`);
    const { events, closed } = await collectEvents(stream, 1);
    expect(events[0]).toMatchObject({ id, status: 'done' });
    expect(closed).toBe(true);
  });

  it('honors the token as a ?token= query param (EventSource cannot send headers)', async () => {
    const TOKEN = 'sse-token-123';
    const baseUrl = await startServer({ ...makeFakeDeps().deps, token: TOKEN });
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-modes-token': TOKEN },
      body: JSON.stringify({ mode: 'brainstorm', prompt: 'think' }),
    });
    const { id } = (await createRes.json()) as { id: string };

    expect((await fetch(`${baseUrl}/api/tasks/${id}/events`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/tasks/${id}/events?token=wrong`)).status).toBe(401);

    const ok = await fetch(`${baseUrl}/api/tasks/${id}/events?token=${TOKEN}`);
    expect(ok.status).toBe(200);
    const { events } = await collectEvents(ok, 1);
    expect(events[0]).toMatchObject({ id, status: 'running' });
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
