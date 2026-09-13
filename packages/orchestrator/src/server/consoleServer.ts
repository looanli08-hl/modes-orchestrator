/**
 * consoleServer — local web console for the modes orchestrator ("modes console").
 * Plain node:http on 127.0.0.1, no dependencies: the panel is one static HTML file
 * and the API is a thin JSON wrapper over the engine. Engine calls are injected as
 * narrow deps so tests feed fakes; real wiring lives in scripts/modes-console.ts.
 * Engine runs are async — POST returns immediately and the panel polls for state.
 *
 * Security: when deps.token is set (the scripts/modes-console.ts default, shared
 * via packages/orchestrator/.modes-console-token), all /api/* routes require a
 * matching x-modes-token header; CORS is fully open so the AionUi-embedded panel
 * (served from aioncore's origin) can call the API cross-origin — the token, not
 * CORS, is the access control. GET /api/health is public for liveness probes.
 */

import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { UserPick } from '../gate/userGate';
import type { ReviewVerdict } from '../review/crossReview';
import {
  createTaskRegistry,
  isUserPick,
  type BrainstormLaneState,
  type CompeteLaneState,
  type ConsoleTask,
  type TaskRegistry,
} from './taskRegistry';

export interface CompeteEngineResult {
  taskId: string;
  state: string;
  lanes: CompeteLaneState[];
  review: ReviewVerdict | null;
  eventsFile: string;
}

export interface BrainstormEngineResult {
  taskId: string;
  lanes: BrainstormLaneState[];
  synthesis: string | null;
  eventsFile: string;
}

export interface ConsoleDeps {
  /**
   * Bearer token gating /api/* (header: x-modes-token). When set, every API
   * route requires it; GET /api/health stays public for liveness probes and
   * GET / stays public (it serves the panel, with the token injected for
   * same-origin/loopback readers only). Unset = legacy open behavior.
   */
  token?: string;
  runCompete(options: { repoPath: string; prompt: string }): Promise<CompeteEngineResult>;
  runBrainstormTask(options: { workDir: string; prompt: string }): Promise<BrainstormEngineResult>;
  recordPick(
    eventsFile: string,
    options: { taskId: string; pick: UserPick; reviewVerdict: ReviewVerdict['verdict'] | null }
  ): Promise<void>;
  mergeLane(options: { repoPath: string; worktreePath: string; branch: string; taskId: string; pick: string }): Promise<void>;
}

export interface ConsoleServerOptions {
  /** override the panel HTML path (tests); defaults to packages/orchestrator/panel/index.html */
  panelPath?: string;
  /** injectable registry (tests); defaults to a fresh in-memory one */
  registry?: TaskRegistry;
}

const BODY_LIMIT_BYTES = 1024 * 1024;
const PANEL_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../panel/index.html');

// Anchor inside panel/index.html before which the token is injected when the
// panel is served. Shared convention with the AionUi extension's activate.js
// (embedded copy injection) — if the panel is restructured, both fail loudly.
const PANEL_SCRIPT_MARKER = '<script>\n"use strict";';

/**
 * Inject window.MODES_TOKEN into the panel HTML. Cross-origin browser readers
 * (arbitrary webpages — reachable because we serve permissive CORS, see below)
 * must NOT receive the token, so injection is skipped when the request carries
 * a non-loopback Origin header. Same-origin panel loads and curl send no (or a
 * loopback) Origin and get the token.
 */
export function injectPanelToken(html: string, token: string | undefined, origin: string | undefined): string {
  if (!token) return html;
  if (origin && !isLoopbackOrigin(origin)) return html;
  if (!html.includes(PANEL_SCRIPT_MARKER)) {
    throw new Error('panel/index.html no longer contains the expected <script> marker; update consoleServer.ts');
  }
  return html.replace(PANEL_SCRIPT_MARKER, `<script>window.MODES_TOKEN = ${JSON.stringify(token)};</script>\n${PANEL_SCRIPT_MARKER}`);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Public view of a task: pick-time pointers (worktreePath/branch) stay server-side. */
function taskDetailView(task: ConsoleTask): Record<string, unknown> {
  const base = {
    id: task.id,
    engineTaskId: task.engineTaskId,
    mode: task.mode,
    prompt: task.prompt,
    repoPath: task.repoPath,
    status: task.status,
    createdAt: task.createdAt,
    error: task.error,
  };
  if (task.mode === 'compete') {
    return {
      ...base,
      lanes: task.compete?.lanes.map(({ lane, outcome, summary, diff }) => ({ lane, outcome, summary, diff })) ?? [],
      review: task.compete?.review ?? null,
    };
  }
  return {
    ...base,
    lanes: task.brainstorm?.lanes ?? [],
    synthesis: task.brainstorm?.synthesis ?? null,
  };
}

export function createConsoleServer(deps: ConsoleDeps, options: ConsoleServerOptions = {}): http.Server {
  const registry = options.registry ?? createTaskRegistry();
  const panelPath = options.panelPath ?? PANEL_PATH;

  const runTaskInBackground = (task: ConsoleTask): void => {
    const run =
      task.mode === 'compete'
        ? deps.runCompete({ repoPath: task.repoPath, prompt: task.prompt }).then((r) => registry.completeCompete(task.id, r))
        : deps
            .runBrainstormTask({ workDir: task.repoPath, prompt: task.prompt })
            .then((r) => registry.completeBrainstorm(task.id, r));
    run.catch((err) => registry.fail(task.id, err));
  };

  const handleCreateTask = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON body' });
    }
    const { mode, prompt, repoPath } = (body ?? {}) as Record<string, unknown>;
    if (mode !== 'compete' && mode !== 'brainstorm') {
      return sendJson(res, 400, { error: "mode must be 'compete' or 'brainstorm'" });
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return sendJson(res, 400, { error: 'prompt must be a non-empty string' });
    }
    if (repoPath !== undefined && typeof repoPath !== 'string') {
      return sendJson(res, 400, { error: 'repoPath must be a string' });
    }
    // like modes-run.ts: no repoPath means "the directory the console was started from"
    const task = registry.create(mode, prompt, path.resolve(repoPath ?? process.cwd()));
    runTaskInBackground(task);
    sendJson(res, 201, { id: task.id });
  };

  const handlePick = async (req: http.IncomingMessage, res: http.ServerResponse, taskId: string): Promise<void> => {
    const task = registry.get(taskId);
    if (!task) return sendJson(res, 404, { error: `unknown task ${taskId}` });

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON body' });
    }
    const { pick } = (body ?? {}) as Record<string, unknown>;
    if (task.mode !== 'compete' || task.status !== 'awaiting_pick' || !task.compete || !task.eventsFile || !task.engineTaskId) {
      return sendJson(res, 409, { error: `task ${taskId} is not awaiting a pick (status: ${task.status})` });
    }
    // validated against this task's lanes, not a hardcoded A/B — compete is N-lane
    const laneLetters = task.compete.lanes.map((l) => l.lane);
    if (!isUserPick(pick, laneLetters)) {
      return sendJson(res, 400, { error: `pick must be one of ${[...laneLetters, 'neither'].join(', ')}` });
    }

    try {
      await deps.recordPick(task.eventsFile, {
        taskId: task.engineTaskId,
        pick,
        reviewVerdict: task.compete.review?.verdict ?? null,
      });
      // mergeLane only ever runs on an explicit human pick; "neither" keeps the
      // worktrees on disk for inspection, same as modes-run.ts
      if (pick !== 'neither') {
        const lane = task.compete.lanes.find((l) => l.lane === pick);
        if (!lane) throw new Error(`lane ${pick} not found`);
        await deps.mergeLane({
          repoPath: task.repoPath,
          worktreePath: lane.worktreePath,
          branch: lane.branch,
          taskId: task.engineTaskId,
          pick,
        });
      }
    } catch (err) {
      // e.g. merge_conflict: the task stays awaiting_pick so the human can retry
      registry.setError(task.id, err);
      return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }

    registry.markDone(task.id);
    sendJson(res, 200, taskDetailView(task));
  };

  return http.createServer(async (req, res) => {
    // Permissive CORS on every response: the AionUi-embedded panel is served
    // from aioncore's origin and calls this server cross-origin. Safe here
    // only because the token gates /api/* — CORS controls what browsers may
    // READ, not what they may do; without a matching x-modes-token header a
    // cross-origin page gets 401s. (GET / is the exception and deliberately
    // withholds the injected token from non-loopback Origins.)
    res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-modes-token',
      });
      return res.end();
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pickMatch = /^\/api\/tasks\/([^/]+)\/pick$/.exec(url.pathname);
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);

    try {
      // public liveness probe (used by the extension's activate.js)
      if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true });

      if (deps.token && url.pathname.startsWith('/api/') && req.headers['x-modes-token'] !== deps.token) {
        return sendJson(res, 401, { error: 'unauthorized: missing or wrong x-modes-token header' });
      }

      if (req.method === 'GET' && url.pathname === '/') {
        const html = injectPanelToken(await readFile(panelPath, 'utf8'), deps.token, req.headers.origin);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') return await handleCreateTask(req, res);
      if (req.method === 'GET' && url.pathname === '/api/tasks') return sendJson(res, 200, registry.list());
      if (req.method === 'GET' && taskMatch) {
        const task = registry.get(decodeURIComponent(taskMatch[1]));
        if (!task) return sendJson(res, 404, { error: `unknown task ${taskMatch[1]}` });
        return sendJson(res, 200, taskDetailView(task));
      }
      if (req.method === 'POST' && pickMatch) return await handlePick(req, res, decodeURIComponent(pickMatch[1]));
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
