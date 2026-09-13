/**
 * recordUserPick — the human gate decision lands in the JSONL log (port-spec §3:
 * decision_gates → 用户选择结果追加进 JSONL, verifier "human"; spec-mvp §5 role "gate").
 * This is the audit trail of every merge decision — and the training signal for
 * future routing preference (vision: 路由记忆).
 */

import { EVENT_LOG_SCHEMA_VERSION } from '../schema/eventLog';
import { appendEvent } from '../store/eventLogStore';
import type { UserPick } from './userGate';

export interface RecordUserPickOptions {
  taskId: string;
  pick: UserPick;
  /** what the human saw before deciding (e.g. review verdict) — for later analysis */
  reviewVerdict?: 'agreed' | 'disagreed' | 'failed' | null;
}

export async function recordUserPick(eventsFile: string, options: RecordUserPickOptions): Promise<void> {
  await appendEvent(eventsFile, {
    schema_version: EVENT_LOG_SCHEMA_VERSION,
    task_id: options.taskId,
    lane: 'gate',
    attempt_id: `${options.taskId}-gate-1`,
    task_type: 'unknown',
    model: 'none',
    provider: 'human',
    role: 'gate',
    outcome: 'success',
    score: null,
    cost: null,
    latency: 0,
    verifier: `human:${options.pick}`,
    ts: new Date().toISOString(),
  });
}
