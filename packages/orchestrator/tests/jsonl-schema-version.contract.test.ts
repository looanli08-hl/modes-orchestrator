/**
 * Contract test: jsonl-schema-version (port-spec.md §4 row 3)
 * Orca counterpart: src/main/runtime/rpc/orchestration-contract-fence.test.ts
 *   (mutation requests with a missing/wrong contract version are refused BEFORE argument parsing;
 *    effectsApplied: false, handler never invoked)
 * Pinned contract: the JSONL event log only writes/reads records whose schema_version equals the
 *   implementation's current EVENT_LOG_SCHEMA_VERSION. Unknown versions are refused loudly —
 *   never silently swallowed, never partially written.
 * Spec references: docs/port-spec.md §4 row 3, §6 (single-version fence; no multi-version negotiation)
 * Spec gap: spec-mvp §5 has no schema_version field — the store-level version envelope needs a spec
 *   amendment (see week-1 report-back).
 * Red mode: ../src/store/eventLogStore and ../src/schema/eventLog do not exist yet — import failure IS the red state.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EVENT_LOG_SCHEMA_VERSION } from '../src/schema/eventLog';
import { appendEvent, readEvents } from '../src/store/eventLogStore';

let tempDirs: string[] = [];

async function makeLogFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-jsonl-version-'));
  tempDirs.push(dir);
  return path.join(dir, 'events.jsonl');
}

function validRecord() {
  return {
    schema_version: EVENT_LOG_SCHEMA_VERSION,
    task_id: 'task-1',
    lane: 'A',
    attempt_id: 'attempt-1',
    task_type: 'unknown',
    model: 'fake-model',
    provider: 'fake-cli',
    role: 'worker',
    outcome: 'success',
    score: null,
    cost: null,
    latency: 12,
    verifier: 'human',
    ts: new Date(0).toISOString(),
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

describe('jsonl-schema-version: unknown schema versions are refused, not swallowed', () => {
  it('appendEvent refuses a record with an unknown schema_version and writes nothing', async () => {
    const file = await makeLogFile();
    const record = { ...validRecord(), schema_version: EVENT_LOG_SCHEMA_VERSION + 999 };

    await expect(appendEvent(file, record)).rejects.toMatchObject({ code: 'unknown_schema_version' });
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('readEvents throws on a stored line with an unknown schema_version (no silent skip)', async () => {
    const file = await makeLogFile();
    const foreignLine = JSON.stringify({ ...validRecord(), schema_version: EVENT_LOG_SCHEMA_VERSION + 999 });
    await writeFile(file, foreignLine + '\n', 'utf8');

    await expect(readEvents(file)).rejects.toMatchObject({ code: 'unknown_schema_version' });
  });

  it('current-version records round-trip (positive control for when impl lands)', async () => {
    const file = await makeLogFile();
    const record = validRecord();

    await appendEvent(file, record);
    const events = await readEvents(file);
    expect(events).toEqual([record]);
  });
});
