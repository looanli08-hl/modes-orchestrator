/**
 * consoleServer — local web console for the modes orchestrator ("modes console").
 * Plain node:http on 127.0.0.1, no dependencies: the panel is one static HTML file
 * and the API is a thin JSON wrapper over the engine. Engine calls are injected as
 * narrow deps so tests feed fakes; real wiring lives in scripts/modes-console.ts.
 * Engine runs are async — POST returns immediately and the panel follows progress
 * via SSE (GET /api/tasks/:id/events), falling back to 2s polling.
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
import type { CascadeLevel } from '../patterns/cascade';
import type { ReviewVerdict } from '../review/crossReview';
import type { TaskClassification } from '../router/classifyTask';
import { dispatchTask } from '../router/dispatchTask';
import { detectClis as probeClis, type CliAvailability } from '../spawn/detectClis';
import type { LaneStream, LaneStreamHub } from '../spawn/laneStream';
import type { RepoRegistry } from './repoRegistry';
import { createRepoRegistry } from './repoRegistry';
import { cleanTaskWorktrees, type WorktreeCleanupResult } from './worktreeCleanup';
import {
  createTaskRegistry,
  isUserPick,
  type BrainstormLaneState,
  type CascadeAttemptState,
  type CascadeWinnerState,
  type CompeteLaneState,
  type ConsoleTask,
  type ConsoleTaskMode,
  type RoundtableRoundState,
  type SingleLaneState,
  type TaskRegistry,
} from './taskRegistry';

/** one lit CLI chip = one lane at the table (letters assigned in chip order) */
export interface ConsoleLaneSpec {
  lane: string;
  cli: string;
}

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

export interface CascadeEngineResult {
  taskId: string;
  attempts: CascadeAttemptState[];
  winner: CascadeWinnerState | null;
  eventsFile: string;
}

export interface RoundtableEngineResult {
  taskId: string;
  rounds: RoundtableRoundState[];
  consensus: boolean;
  synthesis: string | null;
  eventsFile: string;
}

export interface SingleEngineResult {
  taskId: string;
  lane: SingleLaneState;
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
  runCompete(options: {
    repoPath: string;
    prompt: string;
    lanes?: ConsoleLaneSpec[];
    stream?: LaneStream;
  }): Promise<CompeteEngineResult>;
  runBrainstormTask(options: {
    workDir: string;
    prompt: string;
    lanes?: ConsoleLaneSpec[];
    stream?: LaneStream;
  }): Promise<BrainstormEngineResult>;
  runCascadeTask(options: {
    repoPath: string;
    prompt: string;
    chain: CascadeLevel[];
    stream?: LaneStream;
  }): Promise<CascadeEngineResult>;
  runRoundtableTask(options: {
    workDir: string;
    prompt: string;
    clis: string[];
    stream?: LaneStream;
  }): Promise<RoundtableEngineResult>;
  runSingleTask(options: { repoPath: string; prompt: string; cli: string; stream?: LaneStream }): Promise<SingleEngineResult>;
  /**
   * Live lane output hub. When set, every task run gets a per-task sink bound
   * to its console id (stdout/stderr chunks stream into per-lane files under
   * the hub's dir), GET /api/tasks/:id/events pushes batched `lane_output`
   * events, and GET /api/tasks/:id/lanes/:lane/output serves catch-up reads.
   */
  laneStreams?: LaneStreamHub;
  /**
   * DELETE /api/tasks/:id/worktrees — remove the task's `.modes-worktrees/`
   * dirs and `modes/<taskId>-*` branches. Injectable for tests; defaults to
   * the real git implementation in worktreeCleanup.ts.
   */
  cleanWorktrees?: (options: { repoPath: string; engineTaskId: string }) => Promise<WorktreeCleanupResult>;
  /**
   * auto-mode dispatcher: resolves the routing decision asynchronously (the
   * default is the AI dispatcher — a kimi call with rule fallback built in).
   * Injectable for tests; the injected version is usually the synchronous rule
   * router so tests stay deterministic.
   */
  dispatch?: (prompt: string, repoPath: string) => Promise<TaskClassification>;
  /**
   * Probe which orchestratable CLIs are installed (GET /api/clis). Injectable
   * for tests; defaults to the PATH-based probe in spawn/detectClis. Results
   * are cached in-process — probing is not cheap and installs rarely change
   * while the console runs.
   */
  detectClis?: () => Promise<CliAvailability[]>;
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
  /** registered repos (POST/GET/DELETE /api/repos); defaults to a fresh in-memory one */
  repos?: RepoRegistry;
}

const BODY_LIMIT_BYTES = 1024 * 1024;
const PANEL_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../panel/index.html');

/** cheapest first — same default as modes-run.ts --mode cascade */
const DEFAULT_CASCADE_CHAIN: CascadeLevel[] = [{ cli: 'qwen' }, { cli: 'kimi' }];

/** default table when a roundtable request omits clis */
const DEFAULT_ROUNDTABLE_CLIS = ['kimi', 'qwen'];

/** single runs one shot: the first lit chip, or kimi (kimi → qwen availability preference) */
const DEFAULT_SINGLE_CLI = 'kimi';

/** lanes are lettered A, B, C… in chip order (same convention as modes-run.ts) */
function laneLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** a request-body clis override must be a non-empty list of CLI names */
function isCliList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((cli) => typeof cli === 'string' && cli.trim());
}

/** a request-body chain override must be a non-empty list of {cli, timeoutMs?} entries */
function isCascadeChain(value: unknown): value is CascadeLevel[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as CascadeLevel).cli === 'string' &&
        ((entry as CascadeLevel).timeoutMs === undefined || typeof (entry as CascadeLevel).timeoutMs === 'number')
    )
  );
}

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

/** statuses at which an SSE stream has delivered its final event and closes */
const SSE_TERMINAL_STATUSES = new Set(['awaiting_pick', 'done', 'failed']);

/**
 * GET /api/tasks/:id/events — Server-Sent Events stream of task state.
 * Sends the current state immediately, then an event on every registry change
 * for this task (status machine granularity; lanes have no mid-run state), and
 * closes the stream after pushing a terminal status (awaiting_pick / done /
 * failed). EventSource cannot send custom headers, so this route also accepts
 * the token as a ?token= query parameter (loopback console, same value as the
 * x-modes-token header; CORS stays open and useless without it).
 *
 * When a lane stream hub is wired, stdout/stderr chunks arrive as separate
 * named events (`event: lane_output`, data { lane, chunk }, batched by the
 * hub) interleaved with the default task-state `message` events. Chunks are
 * also mirrored to per-lane stream files — reconnecting readers catch up via
 * GET /api/tasks/:id/lanes/:lane/output?offset= instead of replaying SSE.
 */
function handleTaskEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  registry: TaskRegistry,
  laneStreams: LaneStreamHub | undefined,
  taskId: string
): void {
  const task = registry.get(taskId);
  if (!task) return sendJson(res, 404, { error: `unknown task ${taskId}` });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const send = (t: ConsoleTask): void => {
    res.write(`data: ${JSON.stringify(taskDetailView(t))}\n\n`);
  };
  const unsubscribeOutput = laneStreams?.subscribe(taskId, (event) => {
    res.write(`event: lane_output\ndata: ${JSON.stringify({ lane: event.lane, chunk: event.chunk })}\n\n`);
  });
  const close = (): void => {
    // drain buffered lane_output batches first so the terminal close never drops output
    laneStreams?.flush(taskId);
    unsubscribeOutput?.();
    unsubscribe();
    res.end();
  };
  const unsubscribe = registry.subscribe((changed) => {
    if (changed.id !== taskId) return;
    send(changed);
    if (SSE_TERMINAL_STATUSES.has(changed.status)) close();
  });
  req.on('close', () => {
    unsubscribe();
    unsubscribeOutput?.();
  });

  send(task);
  // late subscribers to an already-finished task get the final state and a clean close
  if (SSE_TERMINAL_STATUSES.has(task.status)) close();
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
    classification: task.classification,
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
  if (task.mode === 'cascade') {
    const winner = task.cascade?.winner;
    return {
      ...base,
      attempts: task.cascade?.attempts ?? [],
      winner: winner ? { level: winner.level, cli: winner.cli, summary: winner.summary, diff: winner.diff } : null,
    };
  }
  if (task.mode === 'roundtable') {
    return {
      ...base,
      rounds: task.roundtable?.rounds ?? [],
      consensus: task.roundtable?.consensus ?? false,
      synthesis: task.roundtable?.synthesis ?? null,
    };
  }
  if (task.mode === 'single') {
    const lane = task.single?.lane;
    return {
      ...base,
      // pick-time pointers stay server-side, same as compete lanes
      lane: lane ? { cli: lane.cli, outcome: lane.outcome, latency: lane.latency, summary: lane.summary, diff: lane.diff } : null,
    };
  }
  // 'auto' while the dispatch is still in flight: no lane data yet
  if (task.mode === 'auto') {
    return base;
  }
  return {
    ...base,
    lanes: task.brainstorm?.lanes ?? [],
    synthesis: task.brainstorm?.synthesis ?? null,
  };
}

export function createConsoleServer(deps: ConsoleDeps, options: ConsoleServerOptions = {}): http.Server {
  const registry = options.registry ?? createTaskRegistry();
  const repos = options.repos ?? createRepoRegistry();
  const panelPath = options.panelPath ?? PANEL_PATH;
  // probing PATH is not cheap and installs rarely change mid-session; a failed
  // probe is never cached so the next request retries
  let clisCache: CliAvailability[] | null = null;

  const runTaskInBackground = (
    task: ConsoleTask,
    runOptions: { chain?: CascadeLevel[]; clis?: string[]; mode?: ConsoleTaskMode } = {}
  ): void => {
    const { chain, clis } = runOptions;
    // auto tasks run under the mode the dispatcher resolved, not the provisional one
    const mode = runOptions.mode ?? task.mode;
    // the panel only ever sends clis; the mapping onto each mode's engine
    // shape (letters for lanes, order for the cascade chain, first chip for
    // single) lives here
    const lanes = clis?.map((cli, i) => ({ lane: laneLetter(i), cli }));
    // every mode's lane spawns funnel through realDeps' tap into this sink:
    // stdout/stderr chunks stream live under this task's console id
    const stream = deps.laneStreams ? { stream: deps.laneStreams.bind(task.id) } : {};
    const run =
      mode === 'compete'
        ? deps
            .runCompete({ repoPath: task.repoPath, prompt: task.prompt, ...(lanes ? { lanes } : {}), ...stream })
            .then((r) => registry.completeCompete(task.id, r))
        : mode === 'cascade'
          ? deps
              .runCascadeTask({
                repoPath: task.repoPath,
                prompt: task.prompt,
                chain: chain ?? clis?.map((cli) => ({ cli })) ?? DEFAULT_CASCADE_CHAIN,
                ...stream,
              })
              .then((r) => registry.completeCascade(task.id, r))
          : mode === 'roundtable'
            ? deps
                .runRoundtableTask({
                  workDir: task.repoPath,
                  prompt: task.prompt,
                  clis: clis ?? DEFAULT_ROUNDTABLE_CLIS,
                  ...stream,
                })
                .then((r) => registry.completeRoundtable(task.id, r))
            : mode === 'single'
              ? deps
                  .runSingleTask({ repoPath: task.repoPath, prompt: task.prompt, cli: clis?.[0] ?? DEFAULT_SINGLE_CLI, ...stream })
                  .then((r) => registry.completeSingle(task.id, r))
              : deps
                  .runBrainstormTask({ workDir: task.repoPath, prompt: task.prompt, ...(lanes ? { lanes } : {}), ...stream })
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
    const { mode, prompt, repoPath, chain, clis } = (body ?? {}) as Record<string, unknown>;
    if (
      mode !== 'single' &&
      mode !== 'compete' &&
      mode !== 'brainstorm' &&
      mode !== 'cascade' &&
      mode !== 'roundtable' &&
      mode !== 'auto'
    ) {
      return sendJson(res, 400, { error: "mode must be 'single', 'compete', 'brainstorm', 'cascade', 'roundtable' or 'auto'" });
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return sendJson(res, 400, { error: 'prompt must be a non-empty string' });
    }
    if (repoPath !== undefined && typeof repoPath !== 'string') {
      return sendJson(res, 400, { error: 'repoPath must be a string' });
    }
    if (chain !== undefined && !isCascadeChain(chain)) {
      return sendJson(res, 400, { error: 'chain must be a non-empty array of { cli: string, timeoutMs?: number }' });
    }
    if (clis !== undefined && !isCliList(clis)) {
      return sendJson(res, 400, { error: 'clis must be a non-empty array of CLI names' });
    }
    // like modes-run.ts: no repoPath means "the directory the console was started from"
    const resolvedRepoPath = path.resolve((repoPath as string | undefined) ?? process.cwd());
    // validated above by isCascadeChain/isCliList
    const validChain = chain as CascadeLevel[] | undefined;
    const validClis = clis as string[] | undefined;
    if (mode === 'auto') {
      // AI dispatch is async (a real CLI call): the task is created under the
      // provisional mode 'auto' and the routing decision lands via resolveRouting
      // once the dispatcher answers, then the resolved engine starts. The panel
      // shows the decision as "auto → <mode> · <reason>".
      const task = registry.create('auto', prompt, resolvedRepoPath);
      const dispatch = deps.dispatch ?? ((p: string, repo: string) => dispatchTask({ prompt: p, workDir: repo }));
      dispatch(prompt, task.repoPath)
        .then((classification) => {
          registry.resolveRouting(task.id, classification.mode, classification);
          runTaskInBackground(task, { chain: validChain, clis: validClis, mode: classification.mode });
        })
        .catch((err) => registry.fail(task.id, err));
      return sendJson(res, 201, { id: task.id });
    }
    const task = registry.create(mode as ConsoleTaskMode, prompt, resolvedRepoPath);
    runTaskInBackground(task, { chain: validChain, clis: validClis });
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
    if (task.status !== 'awaiting_pick' || !task.eventsFile || !task.engineTaskId) {
      return sendJson(res, 409, { error: `task ${taskId} is not awaiting a pick (status: ${task.status})` });
    }

    // valid picks and the merge target are per-mode: compete is N-lane (validated
    // against this task's lanes, not a hardcoded A/B); cascade has exactly one
    // winner ("cascade-N") or "neither"
    let reviewVerdict: ReviewVerdict['verdict'] | null = null;
    let mergeTarget: { worktreePath: string; branch: string } | null = null;
    if (task.mode === 'compete' && task.compete) {
      const laneLetters = task.compete.lanes.map((l) => l.lane);
      if (!isUserPick(pick, laneLetters)) {
        return sendJson(res, 400, { error: `pick must be one of ${[...laneLetters, 'neither'].join(', ')}` });
      }
      reviewVerdict = task.compete.review?.verdict ?? null;
      if (pick !== 'neither') {
        const lane = task.compete.lanes.find((l) => l.lane === pick);
        if (!lane) throw new Error(`lane ${pick} not found`);
        mergeTarget = lane;
      }
    } else if (task.mode === 'cascade' && task.cascade?.winner) {
      const winnerPick = `cascade-${task.cascade.winner.level}`;
      if (!isUserPick(pick, [winnerPick])) {
        return sendJson(res, 400, { error: `pick must be one of ${winnerPick}, neither` });
      }
      if (pick !== 'neither') mergeTarget = task.cascade.winner;
    } else if (task.mode === 'single' && task.single) {
      // single has exactly one lane: merge its diff, or "neither"
      if (!isUserPick(pick, ['single'])) {
        return sendJson(res, 400, { error: 'pick must be one of single, neither' });
      }
      if (pick !== 'neither') mergeTarget = task.single.lane;
    } else {
      return sendJson(res, 409, { error: `task ${taskId} is not awaiting a pick (status: ${task.status})` });
    }

    try {
      await deps.recordPick(task.eventsFile, {
        taskId: task.engineTaskId,
        pick,
        reviewVerdict,
      });
      // mergeLane only ever runs on an explicit human pick; "neither" keeps the
      // worktrees on disk for inspection, same as modes-run.ts
      if (mergeTarget) {
        await deps.mergeLane({
          repoPath: task.repoPath,
          worktreePath: mergeTarget.worktreePath,
          branch: mergeTarget.branch,
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

  /**
   * GET /api/tasks/:id/lanes/:lane/output?offset=N — catch-up read of a lane's
   * stream file. `offset` is a byte offset from a previous response (default 0);
   * the response carries the content from there plus the new EOF offset. An
   * offset past EOF (e.g. after tail truncation) restarts from 0 and reports
   * `truncated: true` once the file has been capped.
   */
  const handleLaneOutput = async (res: http.ServerResponse, taskId: string, lane: string, url: URL): Promise<void> => {
    if (!deps.laneStreams) return sendJson(res, 404, { error: 'lane streams are not enabled on this console' });
    const task = registry.get(taskId);
    if (!task) return sendJson(res, 404, { error: `unknown task ${taskId}` });
    const offsetParam = url.searchParams.get('offset');
    const offset = offsetParam === null ? 0 : Number(offsetParam);
    if (!Number.isFinite(offset) || offset < 0) {
      return sendJson(res, 400, { error: 'offset must be a non-negative byte offset' });
    }
    const result = await deps.laneStreams.read(taskId, lane, offset);
    sendJson(res, 200, { taskId, lane, ...result });
  };

  const handleCreateRepo = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON body' });
    }
    const { path: repoPath } = (body ?? {}) as Record<string, unknown>;
    if (typeof repoPath !== 'string' || !repoPath.trim()) {
      return sendJson(res, 400, { error: 'path must be a non-empty string' });
    }
    try {
      const repo = await repos.add(repoPath);
      sendJson(res, 201, repo);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  };

  /**
   * DELETE /api/tasks/:id/worktrees — reclaim a finished task's workspaces:
   * `git worktree remove --force` each `.modes-worktrees/<engineTaskId>-*` dir
   * and `git branch -D` each `modes/<engineTaskId>-*` branch. Failures come
   * back per target in `failed`; the task record itself is never touched.
   */
  const handleCleanWorktrees = async (res: http.ServerResponse, taskId: string): Promise<void> => {
    const task = registry.get(taskId);
    if (!task) return sendJson(res, 404, { error: `unknown task ${taskId}` });
    if (task.status === 'running') {
      return sendJson(res, 409, { error: `task ${taskId} is still running — its lanes may still be live` });
    }
    if (!task.engineTaskId) {
      return sendJson(res, 409, { error: `task ${taskId} has no engine task id — no worktrees to clean` });
    }
    const clean = deps.cleanWorktrees ?? cleanTaskWorktrees;
    const result = await clean({ repoPath: task.repoPath, engineTaskId: task.engineTaskId });
    sendJson(res, 200, { taskId: task.id, engineTaskId: task.engineTaskId, ...result });
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
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, x-modes-token',
      });
      return res.end();
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pickMatch = /^\/api\/tasks\/([^/]+)\/pick$/.exec(url.pathname);
    const eventsMatch = /^\/api\/tasks\/([^/]+)\/events$/.exec(url.pathname);
    const laneOutputMatch = /^\/api\/tasks\/([^/]+)\/lanes\/([^/]+)\/output$/.exec(url.pathname);
    const worktreesMatch = /^\/api\/tasks\/([^/]+)\/worktrees$/.exec(url.pathname);
    const repoMatch = /^\/api\/repos\/([^/]+)$/.exec(url.pathname);
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);

    try {
      // public liveness probe (used by the extension's activate.js)
      if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true });

      if (deps.token && url.pathname.startsWith('/api/')) {
        // EventSource cannot set headers, so the SSE route also honors ?token=
        const presented =
          req.headers['x-modes-token'] ?? (eventsMatch ? url.searchParams.get('token') : null);
        if (presented !== deps.token) {
          return sendJson(res, 401, { error: 'unauthorized: missing or wrong x-modes-token header' });
        }
      }

      if (req.method === 'GET' && url.pathname === '/') {
        const html = injectPanelToken(await readFile(panelPath, 'utf8'), deps.token, req.headers.origin);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') return await handleCreateTask(req, res);
      if (req.method === 'GET' && url.pathname === '/api/clis') {
        clisCache ??= await (deps.detectClis ?? probeClis)();
        return sendJson(res, 200, clisCache);
      }
      if (req.method === 'GET' && url.pathname === '/api/tasks') return sendJson(res, 200, registry.list());
      if (req.method === 'GET' && taskMatch) {
        const task = registry.get(decodeURIComponent(taskMatch[1]));
        if (!task) return sendJson(res, 404, { error: `unknown task ${taskMatch[1]}` });
        return sendJson(res, 200, taskDetailView(task));
      }
      if (req.method === 'GET' && eventsMatch) {
        return handleTaskEvents(req, res, registry, deps.laneStreams, decodeURIComponent(eventsMatch[1]));
      }
      if (req.method === 'GET' && laneOutputMatch) {
        return await handleLaneOutput(
          res,
          decodeURIComponent(laneOutputMatch[1]),
          decodeURIComponent(laneOutputMatch[2]),
          url
        );
      }
      if (req.method === 'DELETE' && worktreesMatch) {
        return await handleCleanWorktrees(res, decodeURIComponent(worktreesMatch[1]));
      }
      if (req.method === 'GET' && url.pathname === '/api/repos') return sendJson(res, 200, repos.list());
      if (req.method === 'POST' && url.pathname === '/api/repos') return await handleCreateRepo(req, res);
      if (req.method === 'DELETE' && repoMatch) {
        const removed = repos.remove(decodeURIComponent(repoMatch[1]));
        if (!removed) return sendJson(res, 404, { error: `unknown repo ${repoMatch[1]}` });
        // unregistration only — the directory on disk is deliberately untouched
        return sendJson(res, 200, { removed });
      }
      if (req.method === 'POST' && pickMatch) return await handlePick(req, res, decodeURIComponent(pickMatch[1]));
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
