/**
 * Unit test: laneStream hub (spawn/laneStream.ts) + the realDeps spawn tap.
 * The hub mirrors lane stdout/stderr into per-(task, lane) stream files
 * (tail-capped) and batches push events for SSE; the tap in
 * realDeps.spawnProcess feeds it live chunks without touching the spawn result
 * or the process-group kill timer.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeRealDeps } from '../src/fanout/realDeps';
import { createLaneStreamHub, type LaneOutputEvent } from '../src/spawn/laneStream';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('lane stream hub', () => {
  it('batches writes within the window into one event per lane', async () => {
    const hub = createLaneStreamHub({ dir: await tempDir('modes-stream-'), batchWindowMs: 60_000 });
    const events: LaneOutputEvent[] = [];
    hub.subscribe('t1', (e) => events.push(e));

    const stream = hub.bind('t1');
    stream.write('A', 'hello');
    stream.write('A', ' world');
    stream.write('B', 'other lane');
    expect(events).toEqual([]); // still buffered

    hub.flush('t1');
    expect(events).toEqual([
      { taskId: 't1', lane: 'A', chunk: 'hello world' },
      { taskId: 't1', lane: 'B', chunk: 'other lane' },
    ]);
    // drain the file-write queue so it never races the temp-dir cleanup
    expect((await hub.read('t1', 'A')).content).toBe('hello world');
  });

  it('flushes immediately once the buffer reaches batchBytes', async () => {
    const hub = createLaneStreamHub({ dir: await tempDir('modes-stream-'), batchWindowMs: 60_000, batchBytes: 8 });
    const events: LaneOutputEvent[] = [];
    hub.subscribe('t1', (e) => events.push(e));

    hub.bind('t1').write('A', '0123456789');
    expect(events).toEqual([{ taskId: 't1', lane: 'A', chunk: '0123456789' }]);
    await hub.read('t1', 'A'); // drain the file-write queue before temp-dir cleanup
  });

  it('flushes on the batch window timer without an explicit flush', async () => {
    const hub = createLaneStreamHub({ dir: await tempDir('modes-stream-'), batchWindowMs: 20 });
    const events: LaneOutputEvent[] = [];
    hub.subscribe('t1', (e) => events.push(e));

    hub.bind('t1').write('A', 'tick');
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 2000 });
    expect(events[0]).toEqual({ taskId: 't1', lane: 'A', chunk: 'tick' });
    await hub.read('t1', 'A'); // drain the file-write queue before temp-dir cleanup
  });

  it('does not leak chunks across tasks', async () => {
    const hub = createLaneStreamHub({ dir: await tempDir('modes-stream-'), batchWindowMs: 60_000 });
    const events: LaneOutputEvent[] = [];
    hub.subscribe('t1', (e) => events.push(e));

    hub.bind('t2').write('A', 'not for t1');
    hub.flush('t2');
    expect(events).toEqual([]);
    await hub.read('t2', 'A'); // drain the file-write queue before temp-dir cleanup
  });

  it('read() serves catch-up content with byte-offset semantics', async () => {
    const hub = createLaneStreamHub({ dir: await tempDir('modes-stream-'), batchWindowMs: 60_000 });
    const stream = hub.bind('t1');
    stream.write('A', 'hello world');

    const first = await hub.read('t1', 'A');
    expect(first).toEqual({ content: 'hello world', offset: 11, truncated: false });

    stream.write('A', '!');
    const second = await hub.read('t1', 'A', first.offset);
    expect(second).toEqual({ content: '!', offset: 12, truncated: false });

    // an offset past EOF (e.g. the file was truncated since) restarts from 0
    const restarted = await hub.read('t1', 'A', 999);
    expect(restarted).toEqual({ content: 'hello world!', offset: 12, truncated: false });
  });

  it('read() of a lane that never wrote is empty, not an error', async () => {
    const hub = createLaneStreamHub({ dir: await tempDir('modes-stream-') });
    expect(await hub.read('t1', 'nope')).toEqual({ content: '', offset: 0, truncated: false });
  });

  it('caps the stream file at maxBytes, keeping the tail', async () => {
    const dir = await tempDir('modes-stream-');
    const hub = createLaneStreamHub({ dir, maxBytes: 32, batchWindowMs: 60_000 });
    const chunk = 'x'.repeat(100);
    hub.bind('t1').write('A', chunk);

    const result = await hub.read('t1', 'A');
    expect(result.truncated).toBe(true);
    expect(result.offset).toBeLessThanOrEqual(32);
    expect(result.content).toBe(chunk.slice(-result.offset));

    const onDisk = await readFile(hub.streamPath('t1', 'A'), 'utf8');
    expect(onDisk).toBe(result.content);
  });

  it('sanitizes task/lane names so they cannot escape the streams dir', async () => {
    const dir = await tempDir('modes-stream-');
    const hub = createLaneStreamHub({ dir });
    expect(hub.streamPath('../evil', '../../x')).toBe(path.join(dir, '.._evil-.._.._x.log'));
  });
});

describe('realDeps spawn streaming tap', () => {
  it('mirrors live stdout/stderr chunks into the lane stream file and events', async () => {
    const dir = await tempDir('modes-spawn-stream-');
    const hub = createLaneStreamHub({ dir: path.join(dir, 'streams'), batchWindowMs: 10 });
    const events: LaneOutputEvent[] = [];
    hub.subscribe('console-1', (e) => events.push(e));

    const deps = makeRealDeps(dir, { taskId: 'task-x', timeoutMs: 10_000, stream: hub.bind('console-1') });
    const result = await deps.spawnProcess('bash', ['-c', 'printf a; sleep 0.2; printf b; sleep 0.2; printf e >&2'], {
      cwd: dir,
      lane: 'A',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ab');

    // batching is timing-based; the union of chunks is the contract
    await vi.waitFor(() => expect(events.map((e) => e.chunk).join('')).toBe('abe'), { timeout: 2000 });
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.every((e) => e.taskId === 'console-1' && e.lane === 'A')).toBe(true);

    const file = await hub.read('console-1', 'A'); // read() lines up behind pending writes
    expect(file.content).toBe('abe');
  });

  it('labels the lane by cli name when opts.lane is omitted', async () => {
    const dir = await tempDir('modes-spawn-stream-');
    const hub = createLaneStreamHub({ dir: path.join(dir, 'streams'), batchWindowMs: 10 });

    const deps = makeRealDeps(dir, { taskId: 'task-x', stream: hub.bind('console-2') });
    await deps.spawnProcess('bash', ['-c', 'printf hi'], { cwd: dir });

    expect((await hub.read('console-2', 'bash')).content).toBe('hi');
  });

  it('spawns and kills exactly as before when no stream is wired', async () => {
    const dir = await tempDir('modes-spawn-stream-');
    const deps = makeRealDeps(dir, { taskId: 'task-x', timeoutMs: 300 });
    const result = await deps.spawnProcess('bash', ['-c', 'sleep 300'], { cwd: dir });
    expect(result.timedOut).toBe(true);
  });
});
