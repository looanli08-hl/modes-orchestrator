/**
 * agentContext — serialize the spec table (specs.ts) into the machine-readable
 * capability schema agents consume, plus the human --help text. Same vendored
 * design as Orca's src/cli/agent-context.ts (~60 lines): a dumb serializer over
 * the single-source spec table, so agent discovery cannot drift from the help
 * text. Deterministic ordering so the JSON diffs cleanly across runs.
 */

import { CLI_SPECS, ENDPOINT_SPECS, type CliCommandSpec, type HttpEndpointSpec } from './specs';

const SCHEMA_VERSION = 1;

/**
 * Short instruction sheet read by the agent before the schema itself. Covers the
 * four core moves: dispatch, stream, pick, follow up.
 */
const AGENT_GUIDE = [
  'modes orchestrator capability schema. Two surfaces, one engine: the modes-run CLI (local, interactive pick gates)',
  'and the console REST API on http://127.0.0.1:4177 (async, scriptable — preferred for agents).',
  '',
  'Core moves against the console API:',
  '1. DISPATCH: POST /api/tasks { mode, prompt, repoPath? } → 201 { id }. Modes: single | compete | brainstorm | cascade | roundtable | auto.',
  '2. STREAM: GET /api/tasks/:id/events (SSE; token may ride as ?token= for EventSource). Watch default message events for status,',
  '   and `event: lane_output` batches for live lane stdout/stderr. Catch up after reconnect via GET /api/tasks/:id/lanes/:lane/output?offset=.',
  '3. PICK (the human gate): when status reaches awaiting_pick, POST /api/tasks/:id/pick { pick } — a lane letter (compete),',
  '   "single", "cascade-N", or "neither" (records the gate, merges nothing, keeps worktrees).',
  '4. FOLLOW UP: POST /api/tasks/:id/followup { lane, notes } resumes the lane\'s agent with review notes and returns to awaiting_pick.',
  '',
  'Auth: every /api/* route needs the x-modes-token header when the console was started with a token',
  '(scripts/modes-console.ts always sets one, shared via packages/orchestrator/.modes-console-token).',
  'Exceptions, always public: GET /api/health and GET /api/agent-context (this document — a public instruction sheet).',
].join('\n');

export interface AgentContextSchema {
  schemaVersion: number;
  product: string;
  guide: string;
  cliCommandCount: number;
  endpointCount: number;
  cliCommands: CliCommandSpec[];
  endpoints: HttpEndpointSpec[];
}

export function buildAgentContext(): AgentContextSchema {
  const cliCommands = CLI_SPECS.toSorted((a, b) => a.command.localeCompare(b.command));
  const endpoints = ENDPOINT_SPECS.toSorted((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return {
    schemaVersion: SCHEMA_VERSION,
    product: 'modes orchestrator',
    guide: AGENT_GUIDE,
    cliCommandCount: cliCommands.length,
    endpointCount: endpoints.length,
    cliCommands,
    endpoints,
  };
}

/**
 * Human --help for modes-run.ts, generated from the same CLI spec table so it
 * cannot drift from --agent-context.
 */
export function formatCliHelp(): string {
  const modes = CLI_SPECS.filter((s) => s.command.startsWith('modes-run --mode'));
  const lines = [
    'modes-run — the modes orchestrator as one command.',
    '',
    'usage: bun packages/orchestrator/scripts/modes-run.ts [--mode <mode>] "<prompt>" [repoPath]',
    '       echo A | bun ...modes-run.ts ...   (piped pick, for scripting)',
    '',
    'modes (default: compete):',
    ...modes.map((s) => `  ${s.command.replace('modes-run --mode ', '').padEnd(11)} ${s.summary}`),
    '',
    'flags:',
    '  --mode <mode>    single | compete | brainstorm | cascade | roundtable | auto',
    '  --agent-context  print the machine-readable JSON capability schema (CLI + REST) and exit',
    '  --help           print this text and exit',
    '',
    'args:',
    '  <prompt>   the task prompt (required)',
    '  [repoPath] target git repo (optional; defaults to the current directory)',
    '',
    'The console REST API (bun packages/orchestrator/scripts/modes-console.ts, port 4177) exposes the',
    'same engine for scripts and agents; GET /api/agent-context serves the same JSON as --agent-context.',
  ];
  return lines.join('\n');
}
