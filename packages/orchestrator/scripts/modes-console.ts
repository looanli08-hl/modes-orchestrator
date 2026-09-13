/**
 * modes-console — the MVP as a local web panel (spec-mvp §1 + §2.5, console step).
 *
 * Usage:  bun packages/orchestrator/scripts/modes-console.ts
 *         PORT=4180 bun ...   (default port 4177)
 * Then open the printed URL. Lanes are fixed to kimi + qwen with kimi as
 * reviewer/synthesizer, same as modes-run.ts. State is in-memory only —
 * restarting the console forgets every task (the JSONL event log on disk
 * remains the durable record).
 */

import { createConsoleServer } from '../src/server/consoleServer';
import { mergeLane } from '../src/gate/mergeLane';
import { recordUserPick } from '../src/gate/recordUserPick';
import { runBrainstorm } from '../src/patterns/brainstorm';
import { runTask } from '../src/run/runTask';

const port = Number(process.env.PORT ?? 4177);

const LANES = [
  { lane: 'A', cli: 'kimi' },
  { lane: 'B', cli: 'qwen' },
];

const server = createConsoleServer({
  runCompete: ({ repoPath, prompt }) => runTask({ repoPath, prompt, lanes: LANES, reviewerCli: 'kimi' }),
  runBrainstormTask: ({ workDir, prompt }) =>
    runBrainstorm({ prompt, lanes: LANES, synthesizerCli: 'kimi', workDir }),
  recordPick: (eventsFile, opts) => recordUserPick(eventsFile, opts),
  mergeLane: (opts) => mergeLane(opts),
});

server.listen(port, '127.0.0.1', () => {
  console.log(`modes console listening at http://127.0.0.1:${port}`);
});
