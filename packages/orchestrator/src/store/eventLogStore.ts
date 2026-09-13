/**
 * Append-only JSONL event store (spec-mvp §5, port-spec §3).
 * Version fence (port-spec §4 row 3): only records whose schema_version equals
 * EVENT_LOG_SCHEMA_VERSION are written or read; unknown versions are refused loudly
 * with code "unknown_schema_version" — never silently swallowed, never partially written.
 */

import { appendFile, readFile } from 'node:fs/promises';

import { OrchestratorError } from '../errors';
import { EVENT_LOG_SCHEMA_VERSION, type EventLogRecord } from '../schema/eventLog';

function assertKnownVersion(record: { schema_version?: unknown }): void {
  if (record.schema_version !== EVENT_LOG_SCHEMA_VERSION) {
    throw new OrchestratorError(
      'unknown_schema_version',
      `event log record has schema_version ${String(record.schema_version)}, expected ${EVENT_LOG_SCHEMA_VERSION}`
    );
  }
}

export async function appendEvent(file: string, record: EventLogRecord): Promise<void> {
  assertKnownVersion(record);
  await appendFile(file, JSON.stringify(record) + '\n', 'utf8');
}

export async function readEvents(file: string): Promise<EventLogRecord[]> {
  const content = await readFile(file, 'utf8');
  const events: EventLogRecord[] = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    const record = JSON.parse(line) as EventLogRecord;
    assertKnownVersion(record);
    events.push(record);
  }
  return events;
}
