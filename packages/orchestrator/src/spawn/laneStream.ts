/**
 * laneStream — live lane output: one stream file per (task, lane) plus batched
 * push notifications for the console's SSE channel.
 *
 * Deliberately separate from the JSONL event log (spec-mvp §5): that log is the
 * lifecycle contract and would drown in stdout chunks. Stream files are raw
 * text under evals/streams/ (gitignored), capped per lane — the tail is kept
 * when the cap is hit, so the file is always the most recent output.
 *
 * The engine side only ever sees the per-task LaneStream sink (hub.bind(taskId));
 * the server side uses subscribe/flush/read for SSE push and catch-up reads.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface LaneOutputEvent {
  taskId: string;
  lane: string;
  chunk: string;
}

export type LaneOutputListener = (event: LaneOutputEvent) => void;

/** per-task sink handed to the spawn layer — the only handle the engine sees */
export interface LaneStream {
  write(lane: string, chunk: string): void;
}

export interface LaneStreamReadResult {
  /** file content from `offset` to EOF (utf8) */
  content: string;
  /** byte offset at EOF — pass it back as `offset` to continue from here */
  offset: number;
  /** true once the file hit the size cap and was rewritten to its tail */
  truncated: boolean;
}

export interface LaneStreamHub {
  bind(taskId: string): LaneStream;
  subscribe(taskId: string, listener: LaneOutputListener): () => void;
  /** push any buffered chunks to subscribers now (used before an SSE close) */
  flush(taskId: string): void;
  read(taskId: string, lane: string, offset?: number): Promise<LaneStreamReadResult>;
  streamPath(taskId: string, lane: string): string;
}

export interface LaneStreamHubOptions {
  dir: string;
  /** per-file cap in bytes; overflow keeps the tail (default 2 MB) */
  maxBytes?: number;
  /** SSE batching window in ms (default 50) */
  batchWindowMs?: number;
  /** SSE batches flush immediately once the buffer reaches this size (default 4 KB) */
  batchBytes?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_BATCH_WINDOW_MS = 50;
const DEFAULT_BATCH_BYTES = 4 * 1024;

/** ids are console task ids and lane labels, but never trust a caller with a path */
function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

interface FileState {
  size: number;
  truncated: boolean;
  /** appends/truncations serialize per file so a truncation never interleaves with an append */
  queue: Promise<void>;
}

interface BatchState {
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createLaneStreamHub(options: LaneStreamHubOptions): LaneStreamHub {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const batchBytes = options.batchBytes ?? DEFAULT_BATCH_BYTES;

  const files = new Map<string, FileState>();
  const batches = new Map<string, BatchState>();
  const listeners = new Map<string, Set<LaneOutputListener>>();

  const fileState = (key: string): FileState => {
    let state = files.get(key);
    if (!state) {
      state = { size: 0, truncated: false, queue: Promise.resolve() };
      files.set(key, state);
    }
    return state;
  };

  const enqueueFileWrite = (filePath: string, chunk: string): void => {
    const state = fileState(filePath);
    const bytes = Buffer.byteLength(chunk, 'utf8');
    state.queue = state.queue
      .then(async () => {
        await mkdir(path.dirname(filePath), { recursive: true });
        await appendFile(filePath, chunk, 'utf8');
        state.size += bytes;
        if (state.size > maxBytes) {
          // cap hit: rewrite the file to its tail so it stays the most recent output
          const tail = (await readFile(filePath)).subarray(-maxBytes);
          await writeFile(filePath, tail);
          state.size = tail.length;
          state.truncated = true;
        }
      })
      .catch((err) => console.error('lane stream write failed:', err));
  };

  const emit = (taskId: string, lane: string, chunk: string): void => {
    const subs = listeners.get(taskId);
    if (!subs) return;
    for (const listener of subs) {
      // a broken subscriber (e.g. a half-closed SSE socket) must not break the hub
      try {
        listener({ taskId, lane, chunk });
      } catch (err) {
        console.error('lane output listener failed:', err);
      }
    }
  };

  const flushKey = (key: string, taskId: string, lane: string): void => {
    const batch = batches.get(key);
    if (!batch || batch.buffer === '') return;
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }
    const chunk = batch.buffer;
    batch.buffer = '';
    emit(taskId, lane, chunk);
  };

  return {
    bind(taskId) {
      return {
        write(lane, chunk) {
          if (chunk === '') return;
          enqueueFileWrite(path.join(options.dir, `${safeName(taskId)}-${safeName(lane)}.log`), chunk);

          const key = `${taskId}${lane}`;
          let batch = batches.get(key);
          if (!batch) {
            batch = { buffer: '', timer: null };
            batches.set(key, batch);
          }
          batch.buffer += chunk;
          if (Buffer.byteLength(batch.buffer, 'utf8') >= batchBytes) {
            flushKey(key, taskId, lane);
          } else if (!batch.timer) {
            batch.timer = setTimeout(() => flushKey(key, taskId, lane), batchWindowMs);
            batch.timer.unref?.();
          }
        },
      };
    },

    subscribe(taskId, listener) {
      let subs = listeners.get(taskId);
      if (!subs) {
        subs = new Set();
        listeners.set(taskId, subs);
      }
      subs.add(listener);
      return () => {
        subs.delete(listener);
        if (subs.size === 0) listeners.delete(taskId);
      };
    },

    flush(taskId) {
      const prefix = `${taskId}`;
      for (const key of batches.keys()) {
        if (!key.startsWith(prefix)) continue;
        flushKey(key, taskId, key.slice(prefix.length));
      }
    },

    async read(taskId, lane, offset = 0) {
      const filePath = path.join(options.dir, `${safeName(taskId)}-${safeName(lane)}.log`);
      const state = fileState(filePath);
      // line up behind pending writes so the read sees everything written so far
      await state.queue;
      let raw: Buffer;
      try {
        raw = await readFile(filePath);
      } catch {
        return { content: '', offset: 0, truncated: false };
      }
      // an offset past EOF (e.g. the file was truncated since) restarts from 0
      const start = offset > 0 && offset <= raw.length ? offset : 0;
      return { content: raw.subarray(start).toString('utf8'), offset: raw.length, truncated: state.truncated };
    },

    streamPath(taskId, lane) {
      return path.join(options.dir, `${safeName(taskId)}-${safeName(lane)}.log`);
    },
  };
}
