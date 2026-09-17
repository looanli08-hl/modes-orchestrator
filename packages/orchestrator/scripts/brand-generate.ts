// Generate the static brand mark SVGs (frozen v3 frame at t=1250, calm energy).
// Run: bun packages/orchestrator/scripts/brand-generate.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BARS = 13;
const CFG = { core: 3.1, gap: 6.1, base: 1.9, amp: 2.1, width: 1.7 };

function envelope(s: number): number {
  const n = 0.5 + 0.5 * s;
  return 0.62 * n + 0.38 * Math.pow(n, 2.6);
}

function frame(t: number, ink: number[], accent: number[]): string {
  const w1 = (2 * Math.PI * t) / 5000;
  const w2 = (2 * Math.PI * t) / 11000;
  const drift = (2 * Math.PI * t) / 23000;
  const parts: string[] = [];
  for (let i = 0; i < BARS; i++) {
    const phi = (2 * Math.PI * i) / BARS - Math.PI / 2;
    const env = envelope(Math.sin(phi + Math.PI / 2));
    const wave = 0.5 + 0.5 * Math.sin(phi + w1 + drift);
    const b = Math.max(0, Math.min(1, 0.15 + env * 0.25 + wave * (0.35 + 0.45 * env) * 0.8));
    const len = (CFG.base + CFG.amp * env) * (1 + 0.12 * Math.sin(phi + w1 + w2));
    const r0 = CFG.gap;
    const r1 = CFG.gap + len * (env > 0.9 ? 0.98 : 1);
    const k = Math.pow(b, 2.2) * 0.85;
    const dim = 0.3 + 0.7 * b;
    const c = ink.map((v, j) => Math.round(v * dim + (accent[j] - v) * k));
    const f = (n: number) => n.toFixed(3);
    parts.push(
      `<line x1="${f(12 + r0 * Math.cos(phi))}" y1="${f(12 + r0 * Math.sin(phi))}" x2="${f(12 + r1 * Math.cos(phi))}" y2="${f(12 + r1 * Math.sin(phi))}" stroke="rgb(${c[0]},${c[1]},${c[2]})" stroke-width="${CFG.width}" stroke-linecap="round"/>`
    );
  }
  parts.push(`<circle cx="12" cy="12" r="${(CFG.core * 1.04).toFixed(2)}" fill="rgb(${accent[0]},${accent[1]},${accent[2]})"/>`);
  return parts.join('\n  ');
}

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">\n  ${body}\n</svg>\n`;
}

const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../brand');
mkdirSync(outDir, { recursive: true });

// dark surfaces: light ink + brand teal
writeFileSync(path.join(outDir, 'logo-mark-darkbg.svg'), svg(frame(1250, [230, 237, 243], [124, 193, 175])));
// light surfaces: dark ink + deep teal
writeFileSync(path.join(outDir, 'logo-mark-lightbg.svg'), svg(frame(1250, [34, 29, 24], [61, 122, 103])));

console.log('brand assets written to', outDir);
