/**
 * modes-console — the MVP as a local web panel (spec-mvp §1 + §2.5, console step).
 *
 * Usage:  bun packages/orchestrator/scripts/modes-console.ts
 *         PORT=4180 bun ...   (default port 4177)
 * Then open the printed URL. The panel's CLI chips pick which CLIs sit at the
 * table (default kimi + deepseek — qwen when no DeepSeek key is configured,
 * kimi as reviewer/synthesizer, same as modes-run.ts); the cascade chain
 * defaults to qwen → kimi (cheap first), overridable per request. Task history
 * is persisted to
 * packages/orchestrator/.modes-console-tasks.json (gitignored) and reloaded on
 * start; tasks caught mid-run by a restart are marked failed. The JSONL event
 * log on disk remains the durable record of the runs themselves.
 *
 * The API is gated by a bearer token shared with the AionUi extension via
 * packages/orchestrator/.modes-console-token (created on first run, 0600).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConsoleServer } from '../src/server/consoleServer';
import { ensureConsoleToken } from '../src/server/consoleToken';
import { createFilePersistence } from '../src/server/filePersistence';
import { CONSOLE_REPOS_PATH, createRepoRegistry } from '../src/server/repoRegistry';
import { createTaskRegistry } from '../src/server/taskRegistry';
import { mergeLane } from '../src/gate/mergeLane';
import { recordUserPick } from '../src/gate/recordUserPick';
import { runBrainstorm } from '../src/patterns/brainstorm';
import { runCascade } from '../src/patterns/cascade';
import { runRoundtable } from '../src/patterns/roundtable';
import { runSingle } from '../src/patterns/single';
import { runTask } from '../src/run/runTask';
import { runFollowup } from '../src/review/followup';
import { createLaneStreamHub } from '../src/spawn/laneStream';
import { getDeepseekApiKey } from '../src/spawn/secrets';

const port = Number(process.env.PORT ?? 4177);
const token = ensureConsoleToken();

const registry = createTaskRegistry({ persistence: createFilePersistence() });
await registry.init();

const repos = createRepoRegistry({ persistence: createFilePersistence(CONSOLE_REPOS_PATH) });
await repos.init();

// live lane output: one raw-text file per (task, lane), tail-capped at 2 MB;
// packages/orchestrator/evals/ is gitignored
const laneStreams = createLaneStreamHub({
  dir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../evals/streams'),
});

const LANES = [
  { lane: 'A', cli: 'kimi' },
  // deepseek when a key is configured (qwen's account is broken) — see modes-run.ts SECOND_CLI
  { lane: 'B', cli: getDeepseekApiKey() ? 'deepseek' : 'qwen' },
];

const server = createConsoleServer({
  token,
  laneStreams,
  runCompete: ({ repoPath, prompt, lanes, stream }) =>
    runTask({ repoPath, prompt, lanes: lanes ?? LANES, reviewerCli: 'kimi', stream }),
  runBrainstormTask: ({ workDir, prompt, lanes, stream }) =>
    runBrainstorm({ prompt, lanes: lanes ?? LANES, synthesizerCli: 'kimi', workDir, stream }),
  // the server applies the default chain (qwen → kimi) when the request omits one
  runCascadeTask: ({ repoPath, prompt, chain, stream }) => runCascade({ repoPath, prompt, chain, stream }),
  runRoundtableTask: ({ workDir, prompt, clis, stream }) => runRoundtable({ prompt, clis, workDir, stream }),
  // the server picks the first lit chip, defaulting to kimi
  runSingleTask: ({ repoPath, prompt, cli, stream }) => runSingle({ repoPath, prompt, cli, stream }),
  // auto uses the server's default: the AI dispatcher (kimi call + rule fallback)
  recordPick: (eventsFile, opts) => recordUserPick(eventsFile, opts),
  mergeLane: (opts) => mergeLane(opts),
  // follow-ups resume the lane's kimi session (or fall back to a fresh kimi)
  // inside the lane's worktree; output streams under the followup-N label
  runFollowup: (opts) => runFollowup(opts),
}, { registry, repos });

server.listen(port, '127.0.0.1', () => {
  console.log(`modes console listening at http://127.0.0.1:${port}`);
});
