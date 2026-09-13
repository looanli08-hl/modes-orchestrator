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
 *    packages/orchestrator/panel/index.html). The copy gets an API-base
 *    override injected: standalone the panel calls /api/* on the console
 *    server itself; embedded in aioncore it must call the extension's own
 *    proxy routes at /modes-console/api/*.
 *
 * 2. Make sure the console server (the actual engine host) is listening on
 *    127.0.0.1:4177. If not, spawn it detached with bun and unref it, so it
 *    survives both this hook and aioncore itself. State is in-memory per
 *    server process, same as running scripts/modes-console.ts by hand.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CONSOLE_HOST = '127.0.0.1';
const CONSOLE_PORT = 4177;
const CONSOLE_BASE_URL = `http://${CONSOLE_HOST}:${CONSOLE_PORT}`;

// Anchor inside panel/index.html where the API-base override is injected.
// If the panel is restructured and this marker disappears, fail loudly here
// instead of silently shipping a panel that calls the wrong API base.
const PANEL_SCRIPT_MARKER = '<script>\n"use strict";';
const PANEL_API_BASE_INJECT =
  `<script>window.MODES_API_BASE = "/modes-console/api";</script>\n` + PANEL_SCRIPT_MARKER;

function buildEmbeddedPanel(standaloneHtml) {
  if (!standaloneHtml.includes(PANEL_SCRIPT_MARKER)) {
    throw new Error('panel/index.html no longer contains the expected <script> marker; update activate.js');
  }
  return standaloneHtml.replace(PANEL_SCRIPT_MARKER, PANEL_API_BASE_INJECT);
}

/** Copy the panel into the extension assets dir; returns the dest path. */
function syncPanelAsset(extensionDir) {
  const panelSrc = path.resolve(extensionDir, '../../panel/index.html');
  const assetsDir = path.join(extensionDir, 'assets');
  const panelDest = path.join(assetsDir, 'index.html');
  const html = buildEmbeddedPanel(fs.readFileSync(panelSrc, 'utf8'));
  fs.mkdirSync(assetsDir, { recursive: true });
  const current = fs.existsSync(panelDest) ? fs.readFileSync(panelDest, 'utf8') : null;
  if (current !== html) fs.writeFileSync(panelDest, html);
  return panelDest;
}

async function isConsoleRunning(fetchImpl, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${CONSOLE_BASE_URL}/api/tasks`, { signal: controller.signal });
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
module.exports.syncPanelAsset = syncPanelAsset;
module.exports.isConsoleRunning = isConsoleRunning;
module.exports.spawnConsoleServer = spawnConsoleServer;
module.exports.CONSOLE_BASE_URL = CONSOLE_BASE_URL;
