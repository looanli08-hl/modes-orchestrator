/**
 * Unit test: taskRegistry persistence + filePersistence — durable task history
 * for the modes console. A fake TaskPersistence drives the registry contract:
 * save after every state change, load on init, zombie running → failed, prune
 * to the newest 100. filePersistence is tested against a temp dir: atomic
 * write-then-rename, and missing/corrupted files reading as empty history.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFilePersistence } from '../src/server/filePersistence';
import { createTaskRegistry, type ConsoleTask, type TaskPersistence } from '../src/server/taskRegistry';

function makeTask(overrides: Partial<ConsoleTask> = {}): ConsoleTask {
  return {
    id: 'console-test-1',
    engineTaskId: null,
    mode: 'compete',
    prompt: 'do the thing',
    repoPath: '/repo',
    status: 'awaiting_pick',
    createdAt: '2026-09-13T00:00:00.000Z',
    error: null,
    eventsFile: '/tmp/events.jsonl',
    compete: null,
    brainstorm: null,
    ...overrides,
  };
}

function makeFakePersistence(seed: unknown[] = []) {
  const persistence: TaskPersistence = {
    save: vi.fn(async () => {}),
    load: vi.fn(async () => seed),
  };
  return persistence;
}

async function waitForSaves(persistence: TaskPersistence, times: number): Promise<void> {
  await vi.waitFor(() => expect(persistence.save).toHaveBeenCalledTimes(times), { timeout: 2000, interval: 10 });
}

/** last save call's payload, typed loosely for assertions */
function lastSaved(persistence: TaskPersistence): ConsoleTask[] {
  const calls = vi.mocked(persistence.save).mock.calls;
  return calls[calls.length - 1][0] as ConsoleTask[];
}

describe('taskRegistry persistence', () => {
  it('saves after create and after every state transition', async () => {
    const persistence = makeFakePersistence();
    const registry = createTaskRegistry({ persistence });
    await registry.init();
    expect(persistence.save).not.toHaveBeenCalled();

    const task = registry.create('compete', 'do the thing', '/repo');
    await waitForSaves(persistence, 1);
    expect(lastSaved(persistence)[0]).toMatchObject({ id: task.id, status: 'running' });

    registry.completeCompete(task.id, {
      taskId: 'task-eng-1',
      lanes: [{ lane: 'A', outcome: 'success', summary: 's', diff: 'd', worktreePath: '/wt/a', branch: 'modes/t-A' }],
      review: { verdict: 'agreed', rationale: 'r', pick: 'A' },
      eventsFile: '/tmp/events.jsonl',
    });
    await waitForSaves(persistence, 2);
    // pick-time pointers and review must survive serialization (pick after restart)
    expect(lastSaved(persistence)[0]).toMatchObject({
      status: 'awaiting_pick',
      engineTaskId: 'task-eng-1',
      compete: { lanes: [{ worktreePath: '/wt/a', branch: 'modes/t-A' }], review: { verdict: 'agreed' } },
    });

    registry.markDone(task.id);
    await waitForSaves(persistence, 3);
    expect(lastSaved(persistence)[0].status).toBe('done');

    const other = registry.create('brainstorm', 'think', '/repo');
    await waitForSaves(persistence, 4);
    registry.fail(other.id, new Error('spawn kimi ENOENT'));
    await waitForSaves(persistence, 5);
    expect(lastSaved(persistence).find((t) => t.id === other.id)).toMatchObject({
      status: 'failed',
      error: 'spawn kimi ENOENT',
    });

    registry.setError(other.id, new Error('merge_conflict'));
    await waitForSaves(persistence, 6);
    expect(lastSaved(persistence).find((t) => t.id === other.id)?.error).toBe('merge_conflict');
  });

  it('restores tasks from load on init, pick-time pointers included', async () => {
    const stored = makeTask({
      id: 'console-stored-1',
      engineTaskId: 'task-eng-9',
      status: 'awaiting_pick',
      compete: {
        lanes: [{ lane: 'A', outcome: 'success', summary: 's', diff: 'd', worktreePath: '/wt/a', branch: 'modes/t-A' }],
        review: { verdict: 'agreed', rationale: 'r', pick: 'A' },
      },
    });
    const registry = createTaskRegistry({ persistence: makeFakePersistence([stored]) });
    await registry.init();

    expect(registry.get('console-stored-1')).toEqual(stored);
    expect(registry.list()).toEqual([
      { id: 'console-stored-1', mode: 'compete', prompt: 'do the thing', status: 'awaiting_pick', createdAt: stored.createdAt },
    ]);
  });

  it('marks tasks that were running at shutdown as failed (zombie) and persists the fix', async () => {
    const zombie = makeTask({ id: 'console-zombie-1', status: 'running' });
    const healthy = makeTask({ id: 'console-ok-1', status: 'awaiting_pick', createdAt: '2026-09-13T01:00:00.000Z' });
    const persistence = makeFakePersistence([zombie, healthy]);
    const registry = createTaskRegistry({ persistence });
    await registry.init();

    const restored = registry.get('console-zombie-1');
    expect(restored?.status).toBe('failed');
    expect(restored?.error).toBe('server restarted while task was running');
    expect(registry.get('console-ok-1')?.status).toBe('awaiting_pick');

    await waitForSaves(persistence, 1);
    expect(lastSaved(persistence).find((t) => t.id === 'console-zombie-1')).toMatchObject({
      status: 'failed',
      error: 'server restarted while task was running',
    });
  });

  it('prunes to the newest 100 tasks by createdAt', async () => {
    const many = Array.from({ length: 105 }, (_, i) =>
      makeTask({
        id: `console-old-${i}`,
        status: 'done',
        createdAt: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
      })
    );
    // distinct monotonically increasing createdAt so ordering is unambiguous
    many.forEach((t, i) => (t.createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()));

    const persistence = makeFakePersistence(many);
    const registry = createTaskRegistry({ persistence });
    await registry.init();

    expect(registry.list()).toHaveLength(100);
    expect(registry.get('console-old-0')).toBeUndefined();
    expect(registry.get('console-old-4')).toBeUndefined();
    expect(registry.get('console-old-5')).toBeDefined();
    await waitForSaves(persistence, 1);
    expect(lastSaved(persistence)).toHaveLength(100);
  });

  it('starts empty when load rejects instead of crashing', async () => {
    const persistence: TaskPersistence = {
      save: vi.fn(async () => {}),
      load: vi.fn(async () => {
        throw new Error('disk on fire');
      }),
    };
    const registry = createTaskRegistry({ persistence });
    await expect(registry.init()).resolves.toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('keeps working when a save rejects (later saves still attempted)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const persistence = makeFakePersistence();
    vi.mocked(persistence.save).mockRejectedValueOnce(new Error('ENOSPC'));
    try {
      const registry = createTaskRegistry({ persistence });
      const task = registry.create('compete', 'p', '/repo');
      await waitForSaves(persistence, 1);
      registry.fail(task.id, new Error('boom'));
      await waitForSaves(persistence, 2);
      expect(registry.get(task.id)?.status).toBe('failed');
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('skips malformed records in the loaded payload', async () => {
    const good = makeTask({ id: 'console-good-1' });
    const persistence = makeFakePersistence([good, null, 42, { nope: true }, { id: 7 }]);
    const registry = createTaskRegistry({ persistence });
    await registry.init();
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('console-good-1')).toBeDefined();
  });
});

describe('filePersistence', () => {
  const dirs: string[] = [];

  function makeDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'modes-tasks-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips tasks through the file', async () => {
    const file = path.join(makeDir(), 'tasks.json');
    const persistence = createFilePersistence(file);
    const tasks = [makeTask({ id: 'console-rt-1' }), makeTask({ id: 'console-rt-2', status: 'done' })];

    await persistence.save(tasks);
    expect(await persistence.load()).toEqual(tasks);
  });

  it('writes atomically: no tmp file is left behind after save', async () => {
    const file = path.join(makeDir(), 'tasks.json');
    const persistence = createFilePersistence(file);

    await persistence.save([makeTask()]);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
  });

  it('reads a missing file as empty history', async () => {
    const persistence = createFilePersistence(path.join(makeDir(), 'nope.json'));
    expect(await persistence.load()).toEqual([]);
  });

  it('reads a corrupted file as empty history', async () => {
    const file = path.join(makeDir(), 'tasks.json');
    writeFileSync(file, '{not json', 'utf8');
    expect(await createFilePersistence(file).load()).toEqual([]);
  });

  it('reads a non-array JSON payload as empty history', async () => {
    const file = path.join(makeDir(), 'tasks.json');
    writeFileSync(file, '{"tasks": []}', 'utf8');
    expect(await createFilePersistence(file).load()).toEqual([]);
  });
});
