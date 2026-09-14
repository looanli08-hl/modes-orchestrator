/**
 * modes-console — the MVP as a local web panel (spec-mvp §1 + §2.5, console step).
 *
 * Usage:  bun packages/orchestrator/scripts/modes-console.ts
 *         PORT=4180 bun ...   (default port 4177)
 * Then open the printed URL. The panel's CLI chips pick which CLIs sit at the
 * table (default kimi + qwen, kimi as reviewer/synthesizer, same as
 * modes-run.ts); the cascade chain defaults to qwen → kimi (cheap first),
 * overridable per request. Task history is persisted to
 * packages/orchestrator/.modes-console-tasks.json (gitignored) and reloaded on
 * start; tasks caught mid-run by a restart are marked failed. The JSONL event
 * log on disk remains the durable record of the runs themselves.
 *
 * The API is gated by a bearer token shared with the AionUi extension via
 * packages/orchestrator/.modes-console-token (created on first run, 0600).
 */

import { createConsoleServer } from '../src/server/consoleServer';
import { ensureConsoleToken } from '../src/server/consoleToken';
import { createFilePersistence } from '../src/server/filePersistence';
import { createTaskRegistry } from '../src/server/taskRegistry';
import { mergeLane } from '../src/gate/mergeLane';
import { recordUserPick } from '../src/gate/recordUserPick';
import { runBrainstorm } from '../src/patterns/brainstorm';
import { runCascade } from '../src/patterns/cascade';
import { runRoundtable } from '../src/patterns/roundtable';
import { runTask } from '../src/run/runTask';

const port = Number(process.env.PORT ?? 4177);
const token = ensureConsoleToken();

const registry = createTaskRegistry({ persistence: createFilePersistence() });
await registry.init();

const LANES = [
  { lane: 'A', cli: 'kimi' },
  { lane: 'B', cli: 'qwen' },
];

const server = createConsoleServer({
  token,
  runCompete: ({ repoPath, prompt, lanes }) =>
    runTask({ repoPath, prompt, lanes: lanes ?? LANES, reviewerCli: 'kimi' }),
  runBrainstormTask: ({ workDir, prompt, lanes }) =>
    runBrainstorm({ prompt, lanes: lanes ?? LANES, synthesizerCli: 'kimi', workDir }),
  // the server applies the default chain (qwen → kimi) when the request omits one
  runCascadeTask: ({ repoPath, prompt, chain }) => runCascade({ repoPath, prompt, chain }),
  runRoundtableTask: ({ workDir, prompt, clis }) => runRoundtable({ prompt, clis, workDir }),
  recordPick: (eventsFile, opts) => recordUserPick(eventsFile, opts),
  mergeLane: (opts) => mergeLane(opts),
}, { registry });

server.listen(port, '127.0.0.1', () => {
  console.log(`modes console listening at http://127.0.0.1:${port}`);
});
