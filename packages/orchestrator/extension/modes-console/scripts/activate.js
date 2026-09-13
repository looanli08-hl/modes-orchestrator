#!/usr/bin/env node
/**
 * modes-console extension — activation lifecycle hook.
 *
 * aioncore executes lifecycle hooks by spawning this file directly (no `node`
 * prefix, no arguments, empty stdin — verified against aioncore 2.2.2: the
 * hook receives NO {extensionName, extensionDir, version} context), so the
 * shebang + executable bit are load-bearing and the extension dir is derived
 * from __dirname. The exported function form stays for the desktop-style
 * require(script)(context) runner and for tests.
 *
 * Plain Node, CommonJS, no deps. Does two things:
 *
 * 1. Sync the panel HTML into ./assets (single source of truth stays at
 *    packages/orchestrator/panel/index.html). The copy gets two globals
 *    injected: MODES_API_BASE pointing straight at the console server
 *    (absolute http://127.0.0.1:4177/api — aioncore 2.2.2 never mounts
 *    extension webui apiRoutes, so the panel talks to the console server
 *    cross-origin) and MODES_TOKEN, the shared bearer token from
 *    packages/orchestrator/.modes-console-token that the console's open CORS
 *    policy relies on for access control.
 *
 * 2. Make sure the console server (the actual engine host) is listening on
 *    127.0.0.1:4177 (via the public /api/health probe). If not, spawn it
 *    detached with bun and unref it, so it survives both this hook and
 *    aioncore itself. State is in-memory per server process, same as running
 *    scripts/modes-console.ts by hand.
 */

const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CONSOLE_HOST = '127.0.0.1';
const CONSOLE_PORT = 4177;
const CONSOLE_BASE_URL = `http://${CONSOLE_HOST}:${CONSOLE_PORT}`;
const CONSOLE_API_URL = `${CONSOLE_BASE_URL}/api`;

// Anchor inside panel/index.html before which the globals are injected.
// If the panel is restructured and this marker disappears, fail loudly here
// instead of silently shipping a panel that calls the wrong API base.
const PANEL_SCRIPT_MARKER = '<script>\n"use strict";';

/**
 * CJS copy of src/server/consoleToken.ts's read-or-create (this file runs
 * under plain Node and cannot import TS) — keep the two in sync.
 */
function ensureConsoleToken(extensionDir) {
  // extensionDir = <repoRoot>/packages/orchestrator/extension/modes-console
  const tokenPath = path.resolve(extensionDir, '../../.modes-console-token');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* missing or unreadable — create below */
  }
  const token = randomUUID();
  fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
  return token;
}

function buildEmbeddedPanel(standaloneHtml, token) {
  if (!standaloneHtml.includes(PANEL_SCRIPT_MARKER)) {
    throw new Error('panel/index.html no longer contains the expected <script> marker; update activate.js');
  }
  const inject =
    `<script>window.MODES_API_BASE = ${JSON.stringify(CONSOLE_API_URL)}; ` +
    `window.MODES_TOKEN = ${JSON.stringify(token)};</script>\n` +
    PANEL_SCRIPT_MARKER;
  return standaloneHtml.replace(PANEL_SCRIPT_MARKER, inject);
}

/** Copy the panel into the extension assets dir; returns the dest path. */
function syncPanelAsset(extensionDir) {
  const panelSrc = path.resolve(extensionDir, '../../panel/index.html');
  const assetsDir = path.join(extensionDir, 'assets');
  const panelDest = path.join(assetsDir, 'index.html');
  const html = buildEmbeddedPanel(fs.readFileSync(panelSrc, 'utf8'), ensureConsoleToken(extensionDir));
  fs.mkdirSync(assetsDir, { recursive: true });
  const current = fs.existsSync(panelDest) ? fs.readFileSync(panelDest, 'utf8') : null;
  if (current !== html) fs.writeFileSync(panelDest, html);
  return panelDest;
}

async function isConsoleRunning(fetchImpl, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // /api/health is public (no token required) by design — it is the probe.
    const res = await fetchImpl(`${CONSOLE_BASE_URL}/api/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Spawn the console server detached; returns the child (or null on spawn error). */
function spawnConsoleServer(extensionDir, spawnImpl = spawn) {
  // extensionDir = <repoRoot>/packages/orchestrator/extension/modes-console
  const repoRoot = path.resolve(extensionDir, '../../..');
  const script = path.join(repoRoot, 'packages/orchestrator/scripts/modes-console.ts');
  try {
    const child = spawnImpl('bun', [script], {
      detached: true,
      stdio: 'ignore',
      // modes-console.ts honors PORT; pin it so a stray inherited PORT can
      // never make the spawned server bind somewhere other than what
      // isConsoleRunning() just probed.
      env: { ...process.env, PORT: String(CONSOLE_PORT) },
    });
    child.unref();
    return child;
  } catch {
    return null;
  }
}

async function activate(extensionDir) {
  const panelPath = syncPanelAsset(extensionDir);
  console.log(`[modes-console] panel synced to ${panelPath}`);

  if (await isConsoleRunning(fetch)) {
    console.log(`[modes-console] console server already listening at ${CONSOLE_BASE_URL}`);
    return;
  }
  const child = spawnConsoleServer(extensionDir);
  console.log(
    child
      ? `[modes-console] spawned console server (pid ${child.pid}) at ${CONSOLE_BASE_URL}`
      : '[modes-console] failed to spawn console server; is bun on PATH?'
  );
}

// scripts/activate.js → extension dir is the parent of this file's dir.
const EXTENSION_DIR = path.resolve(__dirname, '..');

// Desktop-style runner: require(script)(context). aioncore: spawns this file
// as a subprocess, so require.main self-execution below is the real path.
module.exports = function onActivate(context) {
  const dir = context && typeof context.extensionDir === 'string' ? context.extensionDir : EXTENSION_DIR;
  return activate(dir);
};

if (require.main === module) {
  module.exports({}).catch((err) => {
    console.error(`[modes-console] activation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}

// Exported for tests; the extension host only uses the default export.
module.exports.activate = activate;
module.exports.buildEmbeddedPanel = buildEmbeddedPanel;
module.exports.ensureConsoleToken = ensureConsoleToken;
module.exports.syncPanelAsset = syncPanelAsset;
module.exports.isConsoleRunning = isConsoleRunning;
module.exports.spawnConsoleServer = spawnConsoleServer;
module.exports.CONSOLE_BASE_URL = CONSOLE_BASE_URL;
module.exports.CONSOLE_API_URL = CONSOLE_API_URL;
