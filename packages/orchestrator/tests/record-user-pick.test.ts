/**
 * Unit test: recordUserPick (port-spec §3 decision_gates row — user pick appended to JSONL)
 * Pinned behavior: the human pick is a first-class JSONL record with role "gate" and the
 * pick encoded in verifier ("human:A" | "human:B" | "human:neither") — the audit trail of
 * every merge decision, and future routing-preference training signal.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { recordUserPick } from '../src/gate/recordUserPick';
import { readEvents } from '../src/store/eventLogStore';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

describe('recordUserPick: human gate decision is a first-class JSONL record', () => {
  it('appends a gate record with verifier "human:<pick>"', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-user-pick-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'events.jsonl');

    await recordUserPick(file, { taskId: 'task-1', pick: 'A', reviewVerdict: 'agreed' });

    const events = await readEvents(file);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      task_id: 'task-1',
      lane: 'gate',
      role: 'gate',
      provider: 'human',
      outcome: 'success',
      verifier: 'human:A',
    });
  });
});
