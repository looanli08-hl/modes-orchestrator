/**
 * Unit test: the workspace session health layer (feasibility §五 修正 #1) and
 * the workspace name generator.
 *
 * sessionHealth: parseSessionId takes the LAST `kimi -r session_*` hint;
 * assessSessionHealth flags sessionRenewed only when a RESUMED run comes back
 * under a different id (kimi silently opens a fresh session for unknown ids —
 * the failure mode this layer exists to make visible).
 *
 * generateWorkspaceName: adjective-animal format, unique against the taken set,
 * deterministic under an injected rng.
 */

import { describe, expect, it } from 'vitest';

import { generateWorkspaceName, WORKSPACE_NAME_PATTERN } from '../src/server/workspaceRegistry';
import { assessSessionHealth, parseSessionId, supportsResume } from '../src/workspace/sessionHealth';

describe('parseSessionId', () => {
  it('returns the last resume hint in the output', () => {
    const output = 'noise\nTo resume this session: kimi -r session_aaa-1\nmore\nkimi -r session_bbb-2\n';
    expect(parseSessionId(output)).toBe('session_bbb-2');
  });

  it('returns null when there is no hint', () => {
    expect(parseSessionId('no session here')).toBeNull();
    expect(parseSessionId('')).toBeNull();
  });
});

describe('assessSessionHealth', () => {
  it('a fresh run parses and stores the new id, never a renewal', () => {
    const r = assessSessionHealth(null, 'To resume this session: kimi -r session_new-1');
    expect(r).toEqual({ sessionId: 'session_new-1', sessionRenewed: false });
  });

  it('a fresh run with no parseable id stores nothing', () => {
    expect(assessSessionHealth(null, 'silence')).toEqual({ sessionId: null, sessionRenewed: false });
  });

  it('a resumed run whose output carries the SAME id is healthy', () => {
    const r = assessSessionHealth('session_abc-1', 'output\nTo resume this session: kimi -r session_abc-1\n');
    expect(r).toEqual({ sessionId: 'session_abc-1', sessionRenewed: false });
  });

  it('a resumed run whose output carries a DIFFERENT id is a silent renewal (kimi opened a fresh session)', () => {
    const r = assessSessionHealth('session_dead-9', 'To resume this session: kimi -r session_fresh-1');
    expect(r).toEqual({ sessionId: 'session_fresh-1', sessionRenewed: true });
  });

  it('a resumed run with no parseable id conservatively keeps the old session', () => {
    const r = assessSessionHealth('session_abc-1', 'truncated stream, no hint');
    expect(r).toEqual({ sessionId: 'session_abc-1', sessionRenewed: false });
  });
});

describe('supportsResume', () => {
  it('only kimi has a verified non-interactive resume in this stack', () => {
    expect(supportsResume('kimi')).toBe(true);
    expect(supportsResume('qwen')).toBe(false);
    expect(supportsResume('deepseek')).toBe(false);
  });
});

describe('generateWorkspaceName', () => {
  it('generates adjective-animal names that pass the workspace name pattern', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateWorkspaceName(new Set())).toMatch(/^[a-z]+-[a-z]+$/);
    }
  });

  it('never returns a taken name', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const name = generateWorkspaceName(taken);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
    expect(taken.size).toBe(500);
  });

  it('is deterministic under an injected rng and skips collisions', () => {
    // first draw lands on a taken name, second draw must be returned instead
    const draws = [0.0, 0.0, 0.5, 0.5];
    let i = 0;
    const rng = () => draws[i++ % draws.length];
    const first = generateWorkspaceName(new Set(), rng);
    const second = generateWorkspaceName(new Set([first]), rng);
    expect(second).not.toBe(first);
    expect(WORKSPACE_NAME_PATTERN.test(second)).toBe(true);
  });

  it('falls back to a numeric suffix when the pool is exhausted', () => {
    // rng always draws the same combination, which is already taken
    const constant = generateWorkspaceName(new Set(), () => 0);
    const name = generateWorkspaceName(new Set([constant, `${constant}-2`]), () => 0);
    expect(name).toBe(`${constant}-3`);
  });
});
