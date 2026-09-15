/**
 * agentContext/specs — the single source of truth for the modes command surface.
 * Vendored design from Orca's src/cli/specs/* (see /tmp/orca-deep-dive.md §F5):
 * one hand-maintained declarative table describes every CLI command and every
 * console REST endpoint; the --agent-context serializer, --help text, and the
 * drift contract test (tests/agent-context.contract.test.ts) all read this same
 * table, so the three can never disagree with each other. They CAN disagree
 * with the implementation — that drift is what the contract test catches.
 */

export interface CliFlagSpec {
  name: string;
  takesValue?: boolean;
  description: string;
}

export interface CliCommandSpec {
  kind: 'cli';
  /** canonical invocation, e.g. "modes-run --mode compete" */
  command: string;
  summary: string;
  usage: string;
  flags: CliFlagSpec[];
  positionalArgs: string[];
  examples: string[];
  notes: string[];
}

export interface HttpParamSpec {
  type: string;
  required?: boolean;
  description: string;
}

export interface HttpEndpointSpec {
  kind: 'http';
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  summary: string;
  /** true = needs x-modes-token when the console has one configured; /api/health and /api/agent-context are always public */
  requiresToken: boolean;
  /** path and query parameters */
  params?: Record<string, HttpParamSpec>;
  /** JSON request body fields */
  body?: Record<string, HttpParamSpec>;
  examples: string[];
  notes: string[];
}

export type CapabilitySpec = CliCommandSpec | HttpEndpointSpec;

const RUN_USAGE = 'bun packages/orchestrator/scripts/modes-run.ts [--mode <mode>] "<prompt>" [repoPath]';
const RUN_FLAGS: CliFlagSpec[] = [
  { name: '--mode', takesValue: true, description: 'single | compete | brainstorm | cascade | roundtable | auto (default: compete)' },
];
const RUN_POSITIONALS = ['<prompt> (required)', '[repoPath] (optional, defaults to cwd, must be a git repo)'];
const RUN_NOTES = [
  'All modes append run events to a JSONL event log (spec-mvp §5) and print its path.',
  'followup (sending review notes back to a lane) has no CLI entry — use POST /api/tasks/:id/followup on the console.',
];

export const CLI_SPECS: CliCommandSpec[] = [
  {
    kind: 'cli',
    command: 'modes-run --mode compete',
    summary: 'Fan the prompt out to N CLI lanes in isolated worktrees, cross-review the diffs, then ask the human to pick one to merge.',
    usage: RUN_USAGE,
    flags: RUN_FLAGS,
    positionalArgs: RUN_POSITIONALS,
    examples: ['bun packages/orchestrator/scripts/modes-run.ts --mode compete "add a retry to the fetch wrapper" ~/code/myrepo'],
    notes: [
      'Default mode when --mode is omitted. Lanes: kimi (A) + deepseek (B) — qwen when no DeepSeek key is configured — reviewer kimi.',
      'The pick gate is interactive (Pick A / B / neither?); pipe an answer on stdin to script it.',
      ...RUN_NOTES,
    ],
  },
  {
    kind: 'cli',
    command: 'modes-run --mode single',
    summary: 'One CLI (kimi) answers in one shot — merge its diff or don\'t.',
    usage: RUN_USAGE,
    flags: RUN_FLAGS,
    positionalArgs: RUN_POSITIONALS,
    examples: ['bun packages/orchestrator/scripts/modes-run.ts --mode single "fix the typo in README"'],
    notes: ['Interactive Merge? [y/N] gate only when the lane produced a diff.', ...RUN_NOTES],
  },
  {
    kind: 'cli',
    command: 'modes-run --mode brainstorm',
    summary: 'N lanes answer the prompt in parallel, then a synthesizer merges the diversity. No code changes, no pick.',
    usage: RUN_USAGE,
    flags: RUN_FLAGS,
    positionalArgs: RUN_POSITIONALS,
    examples: ['bun packages/orchestrator/scripts/modes-run.ts --mode brainstorm "three ways to structure the billing module"'],
    notes: RUN_NOTES,
  },
  {
    kind: 'cli',
    command: 'modes-run --mode cascade',
    summary: 'Cheap CLI first (qwen), escalate to the next level (kimi) on failure or empty diff; merge the winner or not.',
    usage: RUN_USAGE,
    flags: RUN_FLAGS,
    positionalArgs: RUN_POSITIONALS,
    examples: ['bun packages/orchestrator/scripts/modes-run.ts --mode cascade "bump the timeout default to 30s" ~/code/myrepo'],
    notes: ['Interactive Merge? [y/N] gate when the chain produced a winner.', ...RUN_NOTES],
  },
  {
    kind: 'cli',
    command: 'modes-run --mode roundtable',
    summary: 'N CLIs answer, a reviewer judges consensus; non-consensus triggers a revision round where lanes see each other, then synthesis. No pick, no merge.',
    usage: RUN_USAGE,
    flags: RUN_FLAGS,
    positionalArgs: RUN_POSITIONALS,
    examples: ['bun packages/orchestrator/scripts/modes-run.ts --mode roundtable "is event-sourcing right for this service?"'],
    notes: RUN_NOTES,
  },
  {
    kind: 'cli',
    command: 'modes-run --mode auto',
    summary: 'An AI dispatcher (kimi, with rule fallback) picks the mode from the prompt, prints the decision and reason, then runs the resolved mode exactly as if chosen by hand.',
    usage: RUN_USAGE,
    flags: RUN_FLAGS,
    positionalArgs: RUN_POSITIONALS,
    examples: ['bun packages/orchestrator/scripts/modes-run.ts --mode auto "make the login flow faster"'],
    notes: RUN_NOTES,
  },
  {
    kind: 'cli',
    command: 'modes-run --agent-context',
    summary: 'Print the machine-readable JSON schema of the full CLI + REST capability surface (this mechanism) and exit.',
    usage: 'bun packages/orchestrator/scripts/modes-run.ts --agent-context',
    flags: [],
    positionalArgs: [],
    examples: ['bun packages/orchestrator/scripts/modes-run.ts --agent-context | jq .endpoints[].path'],
    notes: ['Same JSON as GET /api/agent-context on the console server.'],
  },
  {
    kind: 'cli',
    command: 'modes-run --help',
    summary: 'Print human-readable usage generated from the same spec table and exit.',
    usage: 'bun packages/orchestrator/scripts/modes-run.ts --help',
    flags: [],
    positionalArgs: [],
    examples: ['bun packages/orchestrator/scripts/modes-run.ts --help'],
    notes: ['Checked before prompt parsing, so `--help` is never mistaken for a prompt.'],
  },
];

const TOKEN_NOTE = 'Requires the x-modes-token header when the console was started with a token (scripts/modes-console.ts always configures one; tests may run tokenless).';

export const ENDPOINT_SPECS: HttpEndpointSpec[] = [
  {
    kind: 'http',
    method: 'GET',
    path: '/api/health',
    summary: 'Liveness probe — always public, never requires the token.',
    requiresToken: false,
    examples: ['curl http://127.0.0.1:4177/api/health'],
    notes: [],
  },
  {
    kind: 'http',
    method: 'GET',
    path: '/api/agent-context',
    summary: 'This document: the machine-readable capability schema. Always public — it is a public instruction sheet, identical to what --agent-context prints, so no token is required.',
    requiresToken: false,
    examples: ['curl http://127.0.0.1:4177/api/agent-context'],
    notes: [],
  },
  {
    kind: 'http',
    method: 'POST',
    path: '/api/tasks',
    summary: 'Dispatch a task. Returns 201 { id } immediately; the engine runs in the background — follow progress over SSE.',
    requiresToken: true,
    body: {
      mode: { type: "'single'|'compete'|'brainstorm'|'cascade'|'roundtable'|'auto'", required: true, description: 'orchestration mode' },
      prompt: { type: 'string', required: true, description: 'the task prompt, non-empty' },
      repoPath: { type: 'string', description: 'absolute repo path; defaults to the directory the console was started from' },
      clis: { type: 'string[]', description: 'lane CLIs in chip order (letters A, B… for lanes; order = chain for cascade; first entry for single)' },
      chain: { type: '{cli: string, timeoutMs?: number}[]', description: 'cascade-only explicit chain override (takes precedence over clis)' },
    },
    examples: ['curl -X POST http://127.0.0.1:4177/api/tasks -H "x-modes-token: $TOKEN" -H "content-type: application/json" -d \'{"mode":"compete","prompt":"add retries","repoPath":"/abs/repo"}\''],
    notes: [TOKEN_NOTE, "'auto' creates the task under provisional mode 'auto' and resolves the real mode asynchronously via the dispatcher."],
  },
  {
    kind: 'http',
    method: 'GET',
    path: '/api/tasks',
    summary: 'List all tasks known to the registry.',
    requiresToken: true,
    examples: ['curl -H "x-modes-token: $TOKEN" http://127.0.0.1:4177/api/tasks'],
    notes: [TOKEN_NOTE],
  },
  {
    kind: 'http',
    method: 'GET',
    path: '/api/tasks/:id',
    summary: 'Task detail: status, prompt, classification, and per-mode lane/round/attempt data. Pick-time pointers (worktreePath, branch) stay server-side.',
    requiresToken: true,
    params: { id: { type: 'string', required: true, description: 'console task id' } },
    examples: ['curl -H "x-modes-token: $TOKEN" http://127.0.0.1:4177/api/tasks/TASK_ID'],
    notes: [TOKEN_NOTE, 'Status machine: running → awaiting_pick (compete/single/cascade) or done (brainstorm/roundtable) / failed.'],
  },
  {
    kind: 'http',
    method: 'GET',
    path: '/api/tasks/:id/events',
    summary: 'SSE stream of task state. Sends the current state immediately, then an event per status change; interleaved `event: lane_output` batches carry live stdout/stderr chunks. Closes after a terminal status (awaiting_pick / done / failed).',
    requiresToken: true,
    params: {
      id: { type: 'string', required: true, description: 'console task id' },
      token: { type: 'string', description: 'query-param alternative to the header — EventSource cannot set headers' },
    },
    examples: ['curl -N "http://127.0.0.1:4177/api/tasks/TASK_ID/events?token=$TOKEN"'],
    notes: [TOKEN_NOTE, 'Reconnecting readers catch up on lane output via GET /api/tasks/:id/lanes/:lane/output?offset= instead of replaying SSE.'],
  },
  {
    kind: 'http',
    method: 'GET',
    path: '/api/tasks/:id/lanes/:lane/output',
    summary: 'Catch-up read of one lane\'s raw stream file from a byte offset; the response carries content plus the new EOF offset (and truncated: true after tail capping).',
    requiresToken: true,
    params: {
      id: { type: 'string', required: true, description: 'console task id' },
      lane: { type: 'string', required: true, description: 'lane label: A, B… or followup-N' },
      offset: { type: 'number', description: 'byte offset from a previous response (default 0); an offset past EOF restarts from 0' },
    },
    examples: ['curl -H "x-modes-token: $TOKEN" "http://127.0.0.1:4177/api/tasks/TASK_ID/lanes/A/output?offset=0"'],
    notes: [TOKEN_NOTE, '404 when the console runs without a lane stream hub.'],
  },
  {
    kind: 'http',
    method: 'POST',
    path: '/api/tasks/:id/pick',
    summary: 'The human gate: record the pick in the JSONL event log and merge the picked lane\'s branch. "neither" records the gate but keeps the worktrees on disk for inspection.',
    requiresToken: true,
    params: { id: { type: 'string', required: true, description: 'console task id' } },
    body: {
      pick: { type: 'string', required: true, description: "compete: a lane letter (A, B…) or 'neither'; single: 'single' or 'neither'; cascade: 'cascade-N' (the winner's level) or 'neither'" },
    },
    examples: ['curl -X POST -H "x-modes-token: $TOKEN" -H "content-type: application/json" -d \'{"pick":"A"}\' http://127.0.0.1:4177/api/tasks/TASK_ID/pick'],
    notes: [TOKEN_NOTE, '409 unless the task is awaiting_pick. On merge conflict the task stays awaiting_pick with the error surfaced, so the pick can be retried.'],
  },
  {
    kind: 'http',
    method: 'POST',
    path: '/api/tasks/:id/followup',
    summary: 'Send review notes back to a finished lane\'s agent. Resumes the lane\'s kimi session when its stream yielded one, else spawns a fresh kimi with task + diff + notes. Streams under a followup-N label and returns the task to awaiting_pick with the recomputed diff.',
    requiresToken: true,
    params: { id: { type: 'string', required: true, description: 'console task id' } },
    body: {
      lane: { type: 'string', required: true, description: "compete: lane letter; single: 'single'; cascade: 'cascade-N' (winner only)" },
      notes: { type: 'string | {path?: string, line?: number, body: string}[]', required: true, description: 'plain text (one file-scope note) or anchored comments' },
    },
    examples: ['curl -X POST -H "x-modes-token: $TOKEN" -H "content-type: application/json" -d \'{"lane":"A","notes":"extract the retry loop into a helper"}\' http://127.0.0.1:4177/api/tasks/TASK_ID/followup'],
    notes: [TOKEN_NOTE, '202 { followupLane, sessionId, fallback } on accept. 409 while the task is still running or after the lane\'s worktree was cleaned. 501 when follow-ups are not wired.'],
  },
  {
    kind: 'http',
    method: 'POST',
    path: '/api/tasks/:id/annotations',
    summary: 'Replace the task\'s review annotations (whole-list write).',
    requiresToken: true,
    params: { id: { type: 'string', required: true, description: 'console task id' } },
    body: {
      annotations: { type: '{id, lane, path?, line?, body, createdAt?}[]', required: true, description: 'every entry needs id + lane + non-empty body; createdAt defaults to now' },
    },
    examples: ['curl -X POST -H "x-modes-token: $TOKEN" -H "content-type: application/json" -d \'{"annotations":[{"id":"n1","lane":"A","body":"rename this"}]}\' http://127.0.0.1:4177/api/tasks/TASK_ID/annotations'],
    notes: [TOKEN_NOTE],
  },
  {
    kind: 'http',
    method: 'DELETE',
    path: '/api/tasks/:id/worktrees',
    summary: 'Reclaim a finished task\'s workspaces: git worktree remove each .modes-worktrees/<engineTaskId>-* dir and git branch -D each modes/<engineTaskId>-* branch. Per-target failures come back in `failed`.',
    requiresToken: true,
    params: { id: { type: 'string', required: true, description: 'console task id' } },
    examples: ['curl -X DELETE -H "x-modes-token: $TOKEN" http://127.0.0.1:4177/api/tasks/TASK_ID/worktrees'],
    notes: [TOKEN_NOTE, '409 while the task is still running. The task record itself is never touched.'],
  },
  {
    kind: 'http',
    method: 'GET',
    path: '/api/repos',
    summary: 'List registered repos.',
    requiresToken: true,
    examples: ['curl -H "x-modes-token: $TOKEN" http://127.0.0.1:4177/api/repos'],
    notes: [TOKEN_NOTE],
  },
  {
    kind: 'http',
    method: 'POST',
    path: '/api/repos',
    summary: 'Register a repo so the panel can target it.',
    requiresToken: true,
    body: { path: { type: 'string', required: true, description: 'absolute path to a git repo' } },
    examples: ['curl -X POST -H "x-modes-token: $TOKEN" -H "content-type: application/json" -d \'{"path":"/abs/repo"}\' http://127.0.0.1:4177/api/repos'],
    notes: [TOKEN_NOTE],
  },
  {
    kind: 'http',
    method: 'DELETE',
    path: '/api/repos/:path',
    summary: 'Unregister a repo. The directory on disk is deliberately untouched.',
    requiresToken: true,
    params: { path: { type: 'string', required: true, description: 'URL-encoded repo path' } },
    examples: ['curl -X DELETE -H "x-modes-token: $TOKEN" http://127.0.0.1:4177/api/repos/%2Fabs%2Frepo'],
    notes: [TOKEN_NOTE],
  },
  {
    kind: 'http',
    method: 'GET',
    path: '/api/clis',
    summary: 'Probe which orchestratable CLIs are installed (PATH-based). Results are cached in-process; a failed probe is retried on the next request.',
    requiresToken: true,
    examples: ['curl -H "x-modes-token: $TOKEN" http://127.0.0.1:4177/api/clis'],
    notes: [TOKEN_NOTE],
  },
];
