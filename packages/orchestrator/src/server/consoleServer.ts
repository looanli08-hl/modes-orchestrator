/**
 * consoleServer — local web console for the modes orchestrator ("modes console").
 * Plain node:http on 127.0.0.1, no dependencies: the panel is one static HTML file
 * and the API is a thin JSON wrapper over the engine. Engine calls are injected as
 * narrow deps so tests feed fakes; real wiring lives in scripts/modes-console.ts.
 * Engine runs are async — POST returns immediately and the panel polls for state.
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
    if (!isUserPick(pick)) {
      return sendJson(res, 400, { error: "pick must be 'A', 'B', or 'neither'" });
    }
    if (task.mode !== 'compete' || task.status !== 'awaiting_pick' || !task.compete || !task.eventsFile || !task.engineTaskId) {
      return sendJson(res, 409, { error: `task ${taskId} is not awaiting a pick (status: ${task.status})` });
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
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pickMatch = /^\/api\/tasks\/([^/]+)\/pick$/.exec(url.pathname);
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        const html = await readFile(panelPath);
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
