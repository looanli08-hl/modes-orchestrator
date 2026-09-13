/**
 * JSONL event log schema — the single source of truth matching docs/spec-mvp.md §5.
 * The docs-impl-drift contract test pins this against the spec table field-for-field;
 * change the spec first, then this file, never the other way around.
 */

export const EVENT_LOG_SCHEMA_VERSION = 1;

export interface EventLogField {
  name: string;
  type: 'string' | 'number';
  nullable: boolean;
}

export const EVENT_LOG_FIELDS: readonly EventLogField[] = [
  { name: 'task_id', type: 'string', nullable: false },
  { name: 'lane', type: 'string', nullable: false },
  { name: 'attempt_id', type: 'string', nullable: false },
  { name: 'task_type', type: 'string', nullable: false },
  { name: 'model', type: 'string', nullable: false },
  { name: 'provider', type: 'string', nullable: false },
  { name: 'role', type: 'string', nullable: false },
  { name: 'outcome', type: 'string', nullable: false },
  { name: 'score', type: 'number', nullable: true },
  { name: 'cost', type: 'number', nullable: true },
  { name: 'latency', type: 'number', nullable: false },
  { name: 'verifier', type: 'string', nullable: false },
  { name: 'ts', type: 'string', nullable: false },
];

export const EVENT_LOG_OUTCOME_VALUES = ['success', 'failed', 'timeout', 'quota_exhausted'] as const;
export type EventLogOutcome = (typeof EVENT_LOG_OUTCOME_VALUES)[number];

export const EVENT_LOG_ROLE_VALUES = ['worker', 'reviewer', 'gate', 'synthesizer'] as const;
export type EventLogRole = (typeof EVENT_LOG_ROLE_VALUES)[number];

export interface EventLogRecord {
  schema_version: number;
  task_id: string;
  lane: string;
  attempt_id: string;
  task_type: string;
  model: string;
  provider: string;
  role: EventLogRole;
  outcome: EventLogOutcome;
  score: number | null;
  cost: number | null;
  latency: number;
  verifier: string;
  ts: string;
}
