/**
 * Unit test: realDeps.spawnProcess timeout must kill the whole process group,
 * not just the direct child. qwen's bin is a launcher script that spawns the
 * real CLI as a grandchild inheriting stdio — killing only the direct child
 * leaves the grandchild alive and holding the pipes, so 'close' never fires
 * and the lane hangs forever (observed 2026-09-14: qwen's 429 retry storm
 * blew straight past the cascade level's 10-min kill and took the eval run
 * down with it).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeRealDeps } from '../src/fanout/realDeps';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

// process groups are POSIX-only; the Windows path falls back to child.kill
describe.skipIf(process.platform === 'win32')('spawnProcess timeout (process-group kill)', () => {
  it('resolves on timeout even when a grandchild survives the launcher and holds stdio open', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-spawn-kill-'));
    tempDirs.push(dir);
    const launcher = path.join(dir, 'launcher.sh');
    const pidFile = path.join(dir, 'grandchild.pid');
    // bash launcher spawns a long sleep as a grandchild, records its pid, then
    // waits — killing bash alone leaves sleep holding the stdout/stderr pipes.
    await writeFile(launcher, `#!/bin/bash\nsleep 300 &\necho $! > "${pidFile}"\nwait\n`, { mode: 0o755 });

    const deps = makeRealDeps(dir, { taskId: 't', timeoutMs: 500 });
    const started = Date.now();
    const result = await deps.spawnProcess('bash', [launcher], { cwd: dir });

    expect(result.timedOut).toBe(true);
    // 500ms timeout + 5s SIGTERM→SIGKILL grace; anything near the test timeout means a hang
    expect(Date.now() - started).toBeLessThan(10_000);

    // the grandchild must be dead too — a leaked lane keeps burning quota
    const grandchildPid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });

  it('still resolves normally for a process that exits on its own', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'modes-spawn-ok-'));
    tempDirs.push(dir);
    const deps = makeRealDeps(dir, { taskId: 't', timeoutMs: 10_000 });
    const result = await deps.spawnProcess('bash', ['-c', 'echo hi'], { cwd: dir });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe('hi');
  });
});
