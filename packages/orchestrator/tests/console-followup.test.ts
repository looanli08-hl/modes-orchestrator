/**
 * Unit test: POST /api/tasks/:id/followup + POST /api/tasks/:id/annotations.
 * Fake runFollowup drives the state machine; a real LaneStreamHub (tmp dir)
 * backs session-id parsing; worktree paths are real temp dirs so the
 * "worktree cleaned" 409 is exercised by removing one.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyTask } from '../src/router/classifyTask';
import { createConsoleServer, type CompeteEngineResult, type ConsoleDeps } from '../src/server/consoleServer';
import type { FollowupEngineOptions, FollowupEngineResult } from '../src/server/consoleServer';
import { createLaneStreamHub, type LaneStreamHub } from '../src/spawn/laneStream';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const dirs: string[] = [];
const servers: Server[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'modes-followup-api-'));
  dirs.push(dir);
  return dir;
}

function makeCompeteResult(wtA: string, wtB: string): CompeteEngineResult {
  return {
    taskId: 'task-eng-1',
    state: 'awaiting_user_pick',
    lanes: [
      { lane: 'A', outcome: 'success', summary: 'summary A', diff: 'diff A', worktreePath: wtA, branch: 'modes/t-A' },
      { lane: 'B', outcome: 'success', summary: 'summary B', diff: 'diff B', worktreePath: wtB, branch: 'modes/t-B' },
    ],
    review: null,
    eventsFile: '/tmp/events.jsonl',
  };
}

function makeRig() {
  const compete = deferred<CompeteEngineResult>();
  const followup = deferred<FollowupEngineResult>();
  const laneStreams = createLaneStreamHub({ dir: tmpDir() });
  const wtA = tmpDir();
  const wtB = tmpDir();
  const deps: ConsoleDeps = {
    runCompete: vi.fn(() => compete.promise),
    runBrainstormTask: vi.fn(),
    runCascadeTask: vi.fn(),
    runRoundtableTask: vi.fn(),
    runSingleTask: vi.fn(),
    runFollowup: vi.fn(() => followup.promise),
    dispatch: vi.fn(async (prompt: string) => ({ ...classifyTask(prompt), dispatchSource: 'ai' as const })),
    recordPick: vi.fn(async () => {}),
    mergeLane: vi.fn(async () => {}),
    laneStreams,
  };
  return { deps, compete, followup, laneStreams, wtA, wtB };
}

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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function postJson(baseUrl: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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

/** create + settle a compete task into awaiting_pick; returns its console id */
async function settleCompete(baseUrl: string, rig: ReturnType<typeof makeRig>): Promise<string> {
  const res = await postJson(baseUrl, '/api/tasks', { mode: 'compete', prompt: 'do the thing', repoPath: '/repo' });
  const { id } = (await res.json()) as { id: string };
  rig.compete.resolve(makeCompeteResult(rig.wtA, rig.wtB));
  await waitForStatus(baseUrl, id, 'awaiting_pick');
  return id;
}

/** write a lane stream and force the hub's write queue to flush */
async function writeStream(hub: LaneStreamHub, taskId: string, lane: string, text: string): Promise<void> {
  hub.bind(taskId).write(lane, text);
  await hub.read(taskId, lane, 0);
}

describe('POST /api/tasks/:id/annotations', () => {
  it('stores annotations and returns them in the task view', async () => {
    const rig = makeRig();
    const baseUrl = await startServer(rig.deps);
    const id = await settleCompete(baseUrl, rig);

    const annotations = [{ id: 'n1', lane: 'A', path: 'src/x.ts', line: 12, body: 'rename this' }];
    const res = await postJson(baseUrl, `/api/tasks/${id}/annotations`, { annotations });
    expect(res.status).toBe(200);
    const task = await getTask(baseUrl, id);
    expect(task.annotations).toEqual([expect.objectContaining({ id: 'n1', lane: 'A', line: 12, body: 'rename this' })]);
  });

  it('rejects malformed annotations with 400', async () => {
    const rig = makeRig();
    const baseUrl = await startServer(rig.deps);
    const id = await settleCompete(baseUrl, rig);
    expect((await postJson(baseUrl, `/api/tasks/${id}/annotations`, { annotations: [{ lane: 'A' }] })).status).toBe(400);
    expect((await postJson(baseUrl, `/api/tasks/${id}/annotations`, { annotations: 'nope' })).status).toBe(400);
  });
});

describe('POST /api/tasks/:id/followup', () => {
  it('rejects unknown tasks, bad bodies, running tasks and unknown lanes', async () => {
    const rig = makeRig();
    const baseUrl = await startServer(rig.deps);

    expect((await postJson(baseUrl, '/api/tasks/nope/followup', { lane: 'A', notes: 'x' })).status).toBe(404);

    // still running: 409
    const create = await postJson(baseUrl, '/api/tasks', { mode: 'compete', prompt: 'do the thing', repoPath: '/repo' });
    const { id } = (await create.json()) as { id: string };
    expect((await postJson(baseUrl, `/api/tasks/${id}/followup`, { lane: 'A', notes: 'x' })).status).toBe(409);
    rig.compete.resolve(makeCompeteResult(rig.wtA, rig.wtB));
    await waitForStatus(baseUrl, id, 'awaiting_pick');

    // bad payloads: 400
    expect((await postJson(baseUrl, `/api/tasks/${id}/followup`, { notes: 'x' })).status).toBe(400);
    expect((await postJson(baseUrl, `/api/tasks/${id}/followup`, { lane: 'A', notes: [] })).status).toBe(400);
    expect((await postJson(baseUrl, `/api/tasks/${id}/followup`, { lane: 'A', notes: [{ body: '  ' }] })).status).toBe(400);
    // unknown lane: 404
    expect((await postJson(baseUrl, `/api/tasks/${id}/followup`, { lane: 'Z', notes: 'x' })).status).toBe(404);
  });

  it('409s honestly when the lane worktree was cleaned', async () => {
    const rig = makeRig();
    const baseUrl = await startServer(rig.deps);
    const id = await settleCompete(baseUrl, rig);
    rmSync(rig.wtA, { recursive: true, force: true });
    const res = await postJson(baseUrl, `/api/tasks/${id}/followup`, { lane: 'A', notes: 'more' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('worktree');
    expect(rig.deps.runFollowup).not.toHaveBeenCalled();
  });

  it('resumes the LAST kimi session from the lane stream, notes line-anchored', async () => {
    const rig = makeRig();
    const baseUrl = await startServer(rig.deps);
    const id = await settleCompete(baseUrl, rig);
    await writeStream(
      rig.laneStreams,
      id,
      'A',
      'kimi version 0.42.0\nkimi -r session_first\n…\nTo resume this session: kimi -r session_last\n'
    );

    const res = await postJson(baseUrl, `/api/tasks/${id}/followup`, {
      lane: 'A',
      notes: [{ path: 'src/x.ts', line: 12, body: 'rename this' }],
    });
    expect(res.status).toBe(202);
    const ack = (await res.json()) as { followupLane: string; sessionId: string | null; fallback: boolean };
    expect(ack).toEqual({ id, followupLane: 'followup-1', sessionId: 'session_last', fallback: false });

    // the task is running again, and the engine call carries the resume handle
    expect((await getTask(baseUrl, id)).status).toBe('running');
    const call = (rig.deps.runFollowup as ReturnType<typeof vi.fn>).mock.calls[0][0] as FollowupEngineOptions;
    expect(call.laneLabel).toBe('followup-1');
    expect(call.sessionId).toBe('session_last');
    expect(call.worktreePath).toBe(rig.wtA);
    // resume prompts are notes-only — the agent still has its own context
    expect(call.prompt).toContain('File: src/x.ts\nLine: 12\nUser comment: "rename this"');
    expect(call.prompt).not.toContain('do the thing');

    // completion: back to awaiting_pick with the lane's summary/diff refreshed
    rig.followup.resolve({ outcome: 'success', summary: 'renamed', diff: 'diff A v2' });
    await waitForStatus(baseUrl, id, 'awaiting_pick');
    const task = await getTask(baseUrl, id);
    const laneA = (task.lanes as { lane: string; summary: string; diff: string }[]).find((l) => l.lane === 'A');
    expect(laneA).toMatchObject({ summary: 'renamed', diff: 'diff A v2' });

    // a second follow-up increments the stream label
    const again = await postJson(baseUrl, `/api/tasks/${id}/followup`, { lane: 'A', notes: 'one more' });
    expect(((await again.json()) as { followupLane: string }).followupLane).toBe('followup-2');
  });

  it('falls back to a fresh spawn with task + diff + notes when no session exists', async () => {
    const rig = makeRig();
    const baseUrl = await startServer(rig.deps);
    const id = await settleCompete(baseUrl, rig);
    // lane B has no stream file (e.g. a qwen lane) — no session to resume
    const res = await postJson(baseUrl, `/api/tasks/${id}/followup`, { lane: 'B', notes: 'plain text note' });
    expect(res.status).toBe(202);
    const ack = (await res.json()) as { sessionId: string | null; fallback: boolean };
    expect(ack).toMatchObject({ sessionId: null, fallback: true });

    const call = (rig.deps.runFollowup as ReturnType<typeof vi.fn>).mock.calls[0][0] as FollowupEngineOptions;
    expect(call.prompt).toContain('Original task: do the thing');
    expect(call.prompt).toContain('diff B');
    expect(call.prompt).toContain('User comment: "plain text note"');
    rig.followup.resolve({ outcome: 'failed', summary: 'boom', diff: '' });
    await waitForStatus(baseUrl, id, 'awaiting_pick');
  });

  it('a throwing follow-up lands back at awaiting_pick with the error surfaced', async () => {
    const rig = makeRig();
    const baseUrl = await startServer(rig.deps);
    const id = await settleCompete(baseUrl, rig);
    (rig.deps.runFollowup as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('spawn died'));
    const res = await postJson(baseUrl, `/api/tasks/${id}/followup`, { lane: 'A', notes: 'go' });
    expect(res.status).toBe(202);
    await waitForStatus(baseUrl, id, 'awaiting_pick');
    expect((await getTask(baseUrl, id)).error).toBe('spawn died');
  });
});
