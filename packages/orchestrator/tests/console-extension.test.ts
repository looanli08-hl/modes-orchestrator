/**
 * Unit test: the modes-console AionUi extension shell
 * (packages/orchestrator/extension/modes-console).
 *
 * The extension is plain CommonJS run by aioncore's Node extension host, so
 * these tests require() the scripts directly. Covered: manifest shape
 * (route paths, entry points, asset dir), the panel globals injection done
 * by onActivate (single source of truth stays panel/index.html), the panel
 * contract the injection relies on, the shared token file read-or-create,
 * and the apiRoute proxy handlers' mapping onto the console server's REST
 * API (with an injected fake fetch).
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const EXT_DIR = path.resolve(__dirname, '../extension/modes-console');
const PANEL_PATH = path.resolve(__dirname, '../panel/index.html');

const activate = require('../extension/modes-console/scripts/activate.js');
const { forward } = require('../extension/modes-console/webui/forward.js');
const tasksHandler = require('../extension/modes-console/webui/tasks.js');
const taskHandler = require('../extension/modes-console/webui/task.js');
const pickHandler = require('../extension/modes-console/webui/pick.js');

interface Manifest {
  name: string;
  lifecycle?: { onActivate?: string };
  contributes: {
    webui: {
      apiRoutes: Array<{ path: string; entryPoint: string; auth: boolean }>;
      staticAssets: Array<{ urlPrefix: string; directory: string }>;
    };
    settingsTabs: Array<{ id: string; entryPoint: string }>;
  };
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('modes-console extension manifest', () => {
  const manifest = JSON.parse(readFileSync(path.join(EXT_DIR, 'aion-extension.json'), 'utf8')) as Manifest;

  it('is named modes-console with an onActivate hook that exists', () => {
    expect(manifest.name).toBe('modes-console');
    expect(manifest.lifecycle?.onActivate).toBe('scripts/activate.js');
  });

  it('scopes every webui route and asset prefix to /modes-console/', () => {
    for (const route of manifest.contributes.webui.apiRoutes) {
      expect(route.path.startsWith('/modes-console/')).toBe(true);
      expect(readFileSync(path.join(EXT_DIR, route.entryPoint), 'utf8')).toBeTruthy();
    }
    for (const asset of manifest.contributes.webui.staticAssets) {
      expect(asset.urlPrefix.startsWith('/modes-console/')).toBe(true);
    }
  });

  it('points the settings tab at the synced panel copy under assets/', () => {
    const tab = manifest.contributes.settingsTabs.find((t) => t.id === 'modes-console');
    expect(tab?.entryPoint).toBe('assets/index.html');
  });
});

describe('panel embedding contract', () => {
  it('panel/index.html keeps the script marker and the MODES_API_BASE/MODES_TOKEN hooks', () => {
    const html = readFileSync(PANEL_PATH, 'utf8');
    expect(html).toContain('<script>\n"use strict";');
    expect(html).toContain('window.MODES_API_BASE');
    expect(html).toContain('window.MODES_TOKEN');
    expect(html).toContain('"x-modes-token"');
  });

  it('buildEmbeddedPanel injects the direct console API base and the shared token', () => {
    const html = readFileSync(PANEL_PATH, 'utf8');
    const embedded = activate.buildEmbeddedPanel(html, 'tok-123') as string;
    expect(embedded).toContain('window.MODES_API_BASE = "http://127.0.0.1:4177/api";');
    expect(embedded).toContain('window.MODES_TOKEN = "tok-123";');
    expect(embedded).toContain('"use strict";');
    expect(embedded.length).toBeGreaterThan(html.length);
  });

  it('buildEmbeddedPanel fails loudly when the marker drifts', () => {
    expect(() => activate.buildEmbeddedPanel('<html>no marker</html>', 't')).toThrow(/marker/);
  });
});

describe('syncPanelAsset', () => {
  let sandbox = '';

  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = '';
  });

  function makeLayout(): string {
    // mirror the repo layout: <root>/packages/orchestrator/{extension/modes-console,panel}
    const root = mkdtempSync(path.join(tmpdir(), 'modes-ext-'));
    const extDir = path.join(root, 'packages/orchestrator/extension/modes-console');
    const panelDir = path.join(root, 'packages/orchestrator/panel');
    mkdirSync(extDir, { recursive: true });
    mkdirSync(panelDir, { recursive: true });
    writeFileSync(path.join(panelDir, 'index.html'), readFileSync(PANEL_PATH, 'utf8'));
    sandbox = root;
    return extDir;
  }

  it('copies the panel into assets/ with the API-base override and token applied', () => {
    const extDir = makeLayout();
    const dest = activate.syncPanelAsset(extDir) as string;
    expect(dest).toBe(path.join(extDir, 'assets/index.html'));
    const written = readFileSync(dest, 'utf8');
    expect(written).toContain('window.MODES_API_BASE = "http://127.0.0.1:4177/api";');
    expect(written).toMatch(/window\.MODES_TOKEN = "[0-9a-f-]{36}";/);
  });

  it('is idempotent and refreshes a stale copy', () => {
    const extDir = makeLayout();
    activate.syncPanelAsset(extDir);
    const dest = path.join(extDir, 'assets/index.html');
    writeFileSync(dest, 'stale');
    activate.syncPanelAsset(extDir);
    expect(readFileSync(dest, 'utf8')).toContain('window.MODES_API_BASE');
  });
});

describe('console server discovery and spawn', () => {
  it('isConsoleRunning is true only when the console answers OK', async () => {
    const okFetch = vi.fn().mockResolvedValue(jsonResponse(200, []));
    await expect(activate.isConsoleRunning(okFetch)).resolves.toBe(true);
    expect(okFetch.mock.calls[0][0]).toBe('http://127.0.0.1:4177/api/health');

    const failFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(activate.isConsoleRunning(failFetch)).resolves.toBe(false);
  });

  it('spawnConsoleServer launches scripts/modes-console.ts detached via bun', () => {
    const unref = vi.fn();
    const spawnImpl = vi.fn().mockReturnValue({ unref, pid: 1234 });
    const child = activate.spawnConsoleServer(EXT_DIR, spawnImpl);
    expect(child.pid).toBe(1234);
    expect(unref).toHaveBeenCalled();
    const [cmd, args, opts] = spawnImpl.mock.calls[0];
    expect(cmd).toBe('bun');
    expect(args[0]).toBe(path.resolve(EXT_DIR, '../../../packages/orchestrator/scripts/modes-console.ts'));
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(opts.env.PORT).toBe('4177');
  });

  it('spawnConsoleServer returns null instead of throwing when spawn fails', () => {
    const spawnImpl = vi.fn(() => {
      throw new Error('ENOENT');
    });
    expect(activate.spawnConsoleServer(EXT_DIR, spawnImpl)).toBeNull();
  });
});

describe('apiRoute proxy handlers', () => {
  it('tasks: forwards to /api/tasks and mirrors status + JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { id: 't1' }));
    const res = makeRes();
    await tasksHandler({ method: 'POST', body: { mode: 'compete', prompt: 'x' } }, res, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4177/api/tasks');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ mode: 'compete', prompt: 'x' });
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ id: 't1' });
  });

  it('forward sends no body for GET', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, []));
    const res = makeRes();
    await forward({ method: 'GET' }, res, '/api/tasks', undefined, fetchImpl);
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
  });

  it('forward returns 502 when the console server is down', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const res = makeRes();
    await forward({ method: 'GET' }, res, '/api/tasks', undefined, fetchImpl);
    expect(res.statusCode).toBe(502);
    expect(String((res.body as { error: string }).error)).toContain('127.0.0.1:4177');
  });

  it('task: requires ?id= and forwards to /api/tasks/<id> (encoded)', async () => {
    const res = makeRes();
    await taskHandler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(400);

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'a/b' }));
    const res2 = makeRes();
    await taskHandler({ method: 'GET', query: { id: 'a/b' } }, res2, fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:4177/api/tasks/a%2Fb');
    expect(res2.statusCode).toBe(200);
  });

  it('pick: validates {id, pick} and strips id from the forwarded body', async () => {
    const missing = makeRes();
    await pickHandler({ method: 'POST', body: { pick: 'A' } }, missing);
    expect(missing.statusCode).toBe(400);

    const badJson = makeRes();
    await pickHandler({ method: 'POST', body: '{nope' }, badJson);
    expect(badJson.statusCode).toBe(400);

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: 't1', status: 'done' }));
    const res = makeRes();
    await pickHandler({ method: 'POST', body: { id: 't1', pick: 'A' } }, res, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4177/api/tasks/t1/pick');
    expect(JSON.parse(init.body as string)).toEqual({ pick: 'A' });
    expect(res.statusCode).toBe(200);
  });

  it('forward attaches the shared token as x-modes-token (env override path)', async () => {
    process.env.MODES_CONSOLE_TOKEN = 'env-tok';
    try {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, []));
      const res = makeRes();
      await forward({ method: 'GET' }, res, '/api/tasks', undefined, fetchImpl);
      expect(fetchImpl.mock.calls[0][1].headers['x-modes-token']).toBe('env-tok');
    } finally {
      delete process.env.MODES_CONSOLE_TOKEN;
    }
  });
});

describe('ensureConsoleToken (activate.js CJS copy)', () => {
  let sandbox = '';

  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = '';
  });

  function makeExtDir(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'modes-tok-'));
    const extDir = path.join(root, 'packages/orchestrator/extension/modes-console');
    mkdirSync(extDir, { recursive: true });
    sandbox = root;
    return extDir;
  }

  it('creates the token file (0600) on first call and reuses it after', () => {
    const extDir = makeExtDir();
    const token = activate.ensureConsoleToken(extDir) as string;
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    const tokenPath = path.resolve(extDir, '../../.modes-console-token');
    expect(readFileSync(tokenPath, 'utf8').trim()).toBe(token);
    if (process.platform !== 'win32') {
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    }
    expect(activate.ensureConsoleToken(extDir)).toBe(token);
  });
});
