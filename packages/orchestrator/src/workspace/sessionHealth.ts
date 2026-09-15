/**
 * sessionHealth — the session health layer for persistent workspaces
 * (feasibility report 2026-09-15 §五 修正 #1: this is a CORE feature, not an
 * edge-case fallback — it is the technical watershed between "persistent
 * sessions work" and "persistent sessions silently rot").
 *
 * Three known failure modes, three answers:
 *
 * 1. Concurrent resume corrupts the session record (Claude double-writes the
 *    JSONL transcript; Codex errors "active writer") → the workspace-level busy
 *    lock in workspaceRegistry (beginRun throws, the endpoint 409s). Not here.
 * 2. Session is bound to cwd (Claude keys sessions by project dir; Codex --last
 *    only searches cwd) → immune by construction: every run spawns with
 *    cwd = the workspace's own worktreePath. Not here.
 * 3. Sessions silently expire (Claude deletes transcripts after 30 days; kimi
 *    opens a FRESH session for an unknown `-r <id>` without any error) → THIS
 *    module: after every resumed run, verify the output still carries the same
 *    session id. A different id means the CLI silently renewed the session —
 *    the run is flagged sessionRenewed so the panel can say "会话已续期"
 *    instead of pretending continuity.
 */

/** the last `kimi -r session_<id>` hint in a run's output — the resumable session */
export function parseSessionId(output: string): string | null {
  let last: string | null = null;
  for (const match of output.matchAll(/kimi -r (session_[\w-]+)/g)) last = match[1];
  return last;
}

export interface SessionAssessment {
  /** the session id to store on the workspace after this run (null = unknown) */
  sessionId: string | null;
  /**
   * true only when we RESUMED a known session and the output came back under a
   * different id — kimi silently opened a new session for the unknown id
   * (feasibility §二 坑 3). A fresh first run is never a "renewal".
   */
  sessionRenewed: boolean;
}

/**
 * Assess one finished run's output against the session id it was launched with.
 * resumedWith = the workspace's stored sessionId at spawn time (null = fresh run).
 *
 * Edge case: a resumed run whose output yields NO parseable id keeps the old
 * one (conservative — a truncated stream proves nothing either way).
 */
export function assessSessionHealth(resumedWith: string | null, output: string): SessionAssessment {
  const parsed = parseSessionId(output);
  if (resumedWith === null) return { sessionId: parsed, sessionRenewed: false };
  if (parsed === null) return { sessionId: resumedWith, sessionRenewed: false };
  return { sessionId: parsed, sessionRenewed: parsed !== resumedWith };
}

/**
 * Whether this CLI supports `-r <sessionId>` resume at all. Only kimi's
 * non-interactive `-p` + `-r` combination is verified (feasibility §二 坑 4,
 * kimi.com docs 2026-09-14); qwen/gemini resume flags exist but are unverified
 * in this stack, so other CLIs always spawn fresh.
 *
 * TODO(v2): when a session is found dead, inject a summary of the old session
 * into the fresh run's prompt ("同 worktree 新会话 + 旧会话摘要注入",
 * feasibility §五 修正 #1) instead of starting blank.
 */
export function supportsResume(cli: string): boolean {
  return cli === 'kimi';
}
