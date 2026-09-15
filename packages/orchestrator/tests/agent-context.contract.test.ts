/**
 * Contract test: agent-context self-description (Orca port, deep-dive §F5).
 * Orca counterpart: src/cli/agent-context.test.ts + the command-contract drift
 * tests — the spec table is the single source of truth for help, agent-context,
 * and this test.
 *
 * The drift guard: CONSOLE_ROUTES below hardcodes every API route consoleServer
 * registers. The spec table (src/agentContext/specs.ts) must cover each one; a
 * route added/removed/renamed in consoleServer without a matching spec update
 * turns this test red. GET / (the human panel) is deliberately out of scope —
 * it is not an agent capability.
 */

import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { buildAgentContext, formatCliHelp } from '../src/agentContext/agentContext';
import { CLI_SPECS, ENDPOINT_SPECS } from '../src/agentContext/specs';
import { createConsoleServer, type ConsoleDeps } from '../src/server/consoleServer';

// Hardcoded from consoleServer.ts route registrations. Do NOT derive this from
// the implementation — that would defeat the purpose of the drift test.
const CONSOLE_ROUTES = [
  'GET /api/health',
  'GET /api/agent-context',
  'POST /api/tasks',
  'GET /api/tasks',
  'GET /api/tasks/:id',
  'GET /api/tasks/:id/events',
  'GET /api/tasks/:id/lanes/:lane/output',
  'POST /api/tasks/:id/pick',
  'POST /api/tasks/:id/followup',
  'POST /api/tasks/:id/annotations',
  'DELETE /api/tasks/:id/worktrees',
  'GET /api/repos',
  'POST /api/repos',
  'DELETE /api/repos/:path',
  'GET /api/clis',
] as const;

const MODES_RUN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/modes-run.ts');

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

function fakeDeps(token?: string): ConsoleDeps {
  return {
    ...(token ? { token } : {}),
    runCompete: () => new Promise(() => {}),
    runBrainstormTask: () => new Promise(() => {}),
    runCascadeTask: () => new Promise(() => {}),
    runRoundtableTask: () => new Promise(() => {}),
    runSingleTask: () => new Promise(() => {}),
    recordPick: async () => {},
    mergeLane: async () => {},
  };
}

async function startServer(deps: ConsoleDeps): Promise<string> {
  server = createConsoleServer(deps, { panelPath: '/dev/null' });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('agent-context schema', () => {
  it('serializes the spec table deterministically with matching counts', () => {
    const ctx = buildAgentContext();
    expect(ctx.schemaVersion).toBe(1);
    expect(ctx.cliCommandCount).toBe(ctx.cliCommands.length);
    expect(ctx.endpointCount).toBe(ctx.endpoints.length);
    expect(ctx.cliCommandCount).toBe(CLI_SPECS.length);
    expect(ctx.endpointCount).toBe(ENDPOINT_SPECS.length);
    // sorted output, so the JSON diffs cleanly across runs
    expect(ctx.cliCommands.map((c) => c.command)).toEqual(CLI_SPECS.map((c) => c.command).toSorted((a, b) => a.localeCompare(b)));
    expect(ctx.guide).toContain('/api/tasks');
    // same input, byte-identical output
    expect(JSON.stringify(buildAgentContext())).toBe(JSON.stringify(ctx));
  });

  it('the guide teaches the four core moves: dispatch, stream, pick, follow up', () => {
    const { guide } = buildAgentContext();
    expect(guide).toContain('POST /api/tasks');
    expect(guide).toContain('GET /api/tasks/:id/events');
    expect(guide).toContain('POST /api/tasks/:id/pick');
    expect(guide).toContain('POST /api/tasks/:id/followup');
  });
});

describe('agent-context drift guard', () => {
  it('spec table covers every route consoleServer registers', () => {
    const covered = new Set(ENDPOINT_SPECS.map((e) => `${e.method} ${e.path}`));
    for (const route of CONSOLE_ROUTES) {
      expect(covered, `spec table is missing ${route} — add it to src/agentContext/specs.ts`).toContain(route);
    }
    // and nothing in the table describes a route that no longer exists
    for (const entry of covered) {
      expect(CONSOLE_ROUTES, `spec table describes ${entry}, which consoleServer no longer registers`).toContain(entry);
    }
  });

  it('public routes are exactly /api/health and /api/agent-context', () => {
    const publicPaths = ENDPOINT_SPECS.filter((e) => !e.requiresToken).map((e) => e.path);
    expect(publicPaths.toSorted()).toEqual(['/api/agent-context', '/api/health']);
  });

  it('all six modes have a CLI spec', () => {
    const commands = CLI_SPECS.map((c) => c.command);
    for (const mode of ['single', 'compete', 'brainstorm', 'cascade', 'roundtable', 'auto']) {
      expect(commands).toContain(`modes-run --mode ${mode}`);
    }
  });
});

describe('GET /api/agent-context', () => {
  it('serves the same JSON as buildAgentContext(), without a token even when one is configured', async () => {
    const baseUrl = await startServer(fakeDeps('secret-token'));
    const res = await fetch(`${baseUrl}/api/agent-context`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(buildAgentContext())));
  });

  it('still gates other API routes behind the token', async () => {
    const baseUrl = await startServer(fakeDeps('secret-token'));
    const res = await fetch(`${baseUrl}/api/tasks`);
    expect(res.status).toBe(401);
  });
});

describe('modes-run meta flags', () => {
  it('--agent-context prints the schema JSON and exits 0', () => {
    const out = execFileSync('bun', [MODES_RUN, '--agent-context'], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.cliCommandCount).toBe(CLI_SPECS.length);
    expect(parsed.endpointCount).toBe(ENDPOINT_SPECS.length);
  });

  it('--help prints usage generated from the spec table and exits 0 (never treated as a prompt)', () => {
    const out = execFileSync('bun', [MODES_RUN, '--help'], { encoding: 'utf8' });
    expect(out).toBe(formatCliHelp() + '\n');
    expect(out).toContain('usage: bun packages/orchestrator/scripts/modes-run.ts');
  });
});
