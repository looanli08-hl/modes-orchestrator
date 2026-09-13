/**
 * Effect classification of every public operation — port-spec §4 row 8
 * (Orca counterpart: explicit mutation vs read-only RPC classification).
 * Anything that writes the JSONL log, creates/removes worktrees, or spawns/kills
 * processes is an effect; pure observation is readonly. Retired operations are
 * listed explicitly rather than silently disappearing.
 */

export const OPERATION_EFFECTS: Record<string, 'effect' | 'readonly'> = {
  spawnWorker: 'effect',
  fanOut: 'effect',
  killWorker: 'effect',
  appendEvent: 'effect',
  settleResult: 'effect',
  recordUserPick: 'effect',
  readEvents: 'readonly',
  getTaskState: 'readonly',
  getWorkerState: 'readonly',
  diffWorktree: 'readonly',
};

export const PUBLIC_OPERATIONS: readonly string[] = Object.keys(OPERATION_EFFECTS);

// Orca operations deliberately not ported (port-spec §6): no mailbox, no federation,
// no terminal resource accounting, no heartbeat. Listed so removal is auditable.
export const RETIRED_OPERATIONS: readonly string[] = [
  'sendMailboxMessage',
  'checkMailbox',
  'workerRetain',
  'workerRelease',
  'heartbeat',
];
