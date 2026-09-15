/**
 * Unit test: consoleServer live lane output — the `lane_output` SSE event on
 * GET /api/tasks/:id/events and the catch-up route
 * GET /api/tasks/:id/lanes/:lane/output?offset=. The server binds a per-task
 * LaneStream into every mode's run options; fake engines write chunks through
 * it, a real hub (temp dir) backs the stream files.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConsoleServer, type CompeteEngineResult, type ConsoleDeps } from '../src/server/consoleServer';
import { createLaneStreamHub, type LaneStreamHub } from '../src/spawn/laneStream';

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

const servers: Server[] = [];
let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers.length = 0;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

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

function makeDeps(): ConsoleDeps {
  return {
    runCompete: vi.fn(async () => makeCompeteResult()),
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

async function startServer(deps: ConsoleDeps): Promise<string> {
  const server = createConsoleServer(deps);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function makeHub(): Promise<LaneStreamHub> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-console-stream-'));
  tempDirs.push(dir);
  return createLaneStreamHub({ dir, batchWindowMs: 10 });
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

describe('live lane output', () => {
  it('binds a per-task stream into the engine run options', async () => {
    const hub = await makeHub();
    const deps = makeDeps();
    deps.laneStreams = hub;
    const baseUrl = await startServer(deps);

    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'compete', prompt: 'x', repoPath: '/repo' }),
    });
    const { id } = (await res.json()) as { id: string };
    await vi.waitFor(() => expect(deps.runCompete).toHaveBeenCalled(), { timeout: 2000 });

    const options = (deps.runCompete as ReturnType<typeof vi.fn>).mock.calls[0][0] as { stream?: { write: unknown } };
    expect(typeof options.stream?.write).toBe('function');
    // the sink is bound to the console task id
    options.stream!.write('A', 'via-sink');
    const read = await hub.read(id, 'A');
    expect(read.content).toBe('via-sink');
  });

  it('pushes batched lane_output events on the SSE stream and keeps the stream file for catch-up', async () => {
    const hub = await makeHub();
    const deps = makeDeps();
    deps.laneStreams = hub;
    // the fake lane emits two chunks mid-run, then finishes — the delay leaves
    // time for the SSE reader below to subscribe before the first chunk lands
    deps.runCompete = vi.fn(async (options: { stream?: { write(lane: string, chunk: string): void } }) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      options.stream?.write('A', 'chunk-1;');
      options.stream?.write('A', 'chunk-2;');
      await new Promise((resolve) => setTimeout(resolve, 100)); // let the batch window flush
      return makeCompeteResult();
    });
    const baseUrl = await startServer(deps);

    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'compete', prompt: 'x', repoPath: '/repo' }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const frames = await readSseUntilClose(await fetch(`${baseUrl}/api/tasks/${id}/events`));
    const outputs = frames.filter((f) => f.event === 'lane_output');
    expect(outputs.length).toBeGreaterThanOrEqual(1);
    expect(outputs.map((f) => f.data).every((d) => d.lane === 'A')).toBe(true);
    expect(outputs.map((f) => String(f.data.chunk)).join('')).toBe('chunk-1;chunk-2;');
    // task-state frames stay unnamed `message` events — the lifecycle contract is untouched
    expect(frames.some((f) => f.event === 'message' && f.data.status === 'awaiting_pick')).toBe(true);

    // the stream file holds the full raw output, independent of SSE batching
    const streamFile = await readFile(hub.streamPath(id, 'A'), 'utf8');
    expect(streamFile).toBe('chunk-1;chunk-2;');

    // catch-up read: full content, then incremental from the returned offset
    const full = (await (await fetch(`${baseUrl}/api/tasks/${id}/lanes/A/output`)).json()) as Record<string, unknown>;
    expect(full).toMatchObject({ taskId: id, lane: 'A', content: 'chunk-1;chunk-2;', truncated: false });
    hub.bind(id).write('A', 'late;');
    const incremental = (await (
      await fetch(`${baseUrl}/api/tasks/${id}/lanes/A/output?offset=${full.offset}`)
    ).json()) as Record<string, unknown>;
    expect(incremental.content).toBe('late;');
  });

  it('flushes buffered lane_output before the terminal SSE close', async () => {
    const hub = await mkdtemp(path.join(os.tmpdir(), 'modes-console-stream-')).then((dir) => {
      tempDirs.push(dir);
      // a huge window means only the close-path flush can deliver the chunk
      return createLaneStreamHub({ dir, batchWindowMs: 60_000 });
    });
    const deps = makeDeps();
    deps.laneStreams = hub;
    deps.runBrainstormTask = vi.fn(async (options: { stream?: { write(lane: string, chunk: string): void } }) => {
      options.stream?.write('A', 'buffered-until-close');
      return { taskId: 't', lanes: [], synthesis: null, eventsFile: '/tmp/e.jsonl' };
    });
    const baseUrl = await startServer(deps);

    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'brainstorm', prompt: 'x', repoPath: '/repo' }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const frames = await readSseUntilClose(await fetch(`${baseUrl}/api/tasks/${id}/events`));
    const outputs = frames.filter((f) => f.event === 'lane_output');
    expect(outputs).toHaveLength(1);
    expect(outputs[0].data).toEqual({ lane: 'A', chunk: 'buffered-until-close' });
  });

  it('404s the output route for unknown tasks, 400s a bad offset, and 404s when no hub is wired', async () => {
    const hub = await makeHub();
    const deps = makeDeps();
    deps.laneStreams = hub;
    const baseUrl = await startServer(deps);

    expect((await fetch(`${baseUrl}/api/tasks/nope/lanes/A/output`)).status).toBe(404);

    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'compete', prompt: 'x', repoPath: '/repo' }),
    });
    const { id } = (await createRes.json()) as { id: string };
    expect((await fetch(`${baseUrl}/api/tasks/${id}/lanes/A/output?offset=-1`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/tasks/${id}/lanes/A/output?offset=abc`)).status).toBe(400);

    const bareBaseUrl = await startServer(makeDeps());
    expect((await fetch(`${bareBaseUrl}/api/tasks/whatever/lanes/A/output`)).status).toBe(404);
    const body = (await (await fetch(`${bareBaseUrl}/api/tasks/whatever/lanes/A/output`)).json()) as { error: string };
    expect(body.error).toContain('not enabled');
  });
});
