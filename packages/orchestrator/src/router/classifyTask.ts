/**
 * classifyTask — the auto-mode router's pure prompt classifier (spec-mvp §2.5
 * auto row). Rule-based routing v1: heuristics today, swappable for a
 * data-driven model once the JSONL routing data (task_type = auto:<mode>)
 * has accumulated.
 *
 * The core question: does the user want an answer/opinion or a code
 * deliverable?
 *   compete    — code wanted AND an explicit multi-version comparison intent
 *                (compete doubles cost, so only an explicit signal qualifies)
 *   brainstorm — opinion wanted (consult/evaluate signal) AND no deliverable noun
 *   cascade    — executional verb, or the no-signal fallback (cheapest first)
 *
 * Priority: compete > brainstorm > cascade. The rules are data-driven
 * (pattern → mode + user-facing reason) so tuning the router is a table edit.
 */

/**
 * Every mode the auto dispatcher can resolve to. classifyTask itself only ever
 * returns compete/brainstorm/cascade; single and roundtable enter through the
 * AI dispatcher (dispatchTask.ts).
 */
export type RoutedMode = 'single' | 'compete' | 'brainstorm' | 'cascade' | 'roundtable';

export interface TaskClassification {
  mode: RoutedMode;
  /** high = an explicit rule fired; low = pure fallback */
  confidence: 'high' | 'low';
  /** short human-facing note: which rule fired / why the dispatcher picked this mode */
  reason: string;
  /**
   * Who made the call: 'ai' = the AI dispatcher's ROUTE marker parsed cleanly;
   * 'rules-fallback' = the AI dispatcher failed or answered malformed and
   * classifyTask took over. Undefined for a direct classifyTask call.
   */
  dispatchSource?: 'ai' | 'rules-fallback';
}

interface RouteRule {
  pattern: RegExp;
  mode: RoutedMode;
  reason: string;
}

/**
 * Explicit multi-version comparison intent. Ordered first: it beats both
 * consult signals and the execute verbs its own phrasing contains (实现/写).
 */
const COMPETE_RULES: RouteRule[] = [
  { pattern: /两个方案|两种实现/, mode: 'compete', reason: 'explicit multi-version intent (两个方案/两种实现)' },
  { pattern: /各写一版|各来一版/, mode: 'compete', reason: 'explicit per-lane versions (各写一版/各来一版)' },
  { pattern: /对比实现|哪个实现好/, mode: 'compete', reason: 'explicit implementation comparison (对比实现/哪个实现好)' },
  { pattern: /\bcompete\b/i, mode: 'compete', reason: 'explicit "compete"' },
  { pattern: /\btwo (versions|implementations)\b/i, mode: 'compete', reason: 'explicit two versions/implementations' },
];

/** Consult/evaluate signals: the user wants an opinion, not an artifact. */
const BRAINSTORM_RULES: RouteRule[] = [
  { pattern: /怎么看|你觉得|你认为/, mode: 'brainstorm', reason: 'opinion request (怎么看/你觉得/你认为)' },
  { pattern: /分析一下|评估/, mode: 'brainstorm', reason: 'analysis/evaluation request (分析/评估)' },
  { pattern: /值得吗|该不该|靠谱吗|能成吗/, mode: 'brainstorm', reason: 'judgment call (值得吗/该不该/靠谱吗/能成吗)' },
  { pattern: /优缺点|怎么选|如何评价|建议/, mode: 'brainstorm', reason: 'comparison/advice request (优缺点/怎么选/如何评价/建议)' },
  { pattern: /\bwhat do you think\b/i, mode: 'brainstorm', reason: 'opinion request ("what do you think")' },
  { pattern: /\bshould (i|we)\b/i, mode: 'brainstorm', reason: 'judgment call ("should I/we")' },
  { pattern: /\bpros and cons\b/i, mode: 'brainstorm', reason: 'comparison request ("pros and cons")' },
  { pattern: /\b(analy[sz]e|evaluate)\b/i, mode: 'brainstorm', reason: 'analysis/evaluation request (analyze/evaluate)' },
  { pattern: /\btrade.?offs?\b|\bworth it\b/i, mode: 'brainstorm', reason: 'trade-off/worth-it question' },
];

/** Executional verbs: the user wants a change made. */
const CASCADE_RULES: RouteRule[] = [
  { pattern: /写|实现|修复|改|加|创建|翻译|重构|生成|优化/, mode: 'cascade', reason: 'executional verb (写/实现/修复/改/加/创建/翻译/重构/生成/优化)' },
  {
    pattern: /\b(implement|fix|add|create|write|refactor|translate|build|optimi[sz]e)\w*/i,
    mode: 'cascade',
    reason: 'executional verb (implement/fix/add/create/write/refactor/translate/build/optimize)',
  },
];

/** Rules in priority order: compete > brainstorm > cascade. */
const RULES: RouteRule[] = [...COMPETE_RULES, ...BRAINSTORM_RULES, ...CASCADE_RULES];

/**
 * Deliverable nouns: their presence means the user is pointing at an artifact,
 * so a consult signal is about the artifact (act on it), not a request for
 * open-ended opinion — brainstorm is suppressed.
 */
const DELIVERABLE_SIGNALS: RegExp[] = [/文件|代码|函数|脚本|模块|页面|组件/, /\.(js|ts|py|html|css)\b/i, /\bREADME\b/i];

export function classifyTask(prompt: string): TaskClassification {
  const hasDeliverable = DELIVERABLE_SIGNALS.some((p) => p.test(prompt));
  for (const rule of RULES) {
    if (!rule.pattern.test(prompt)) continue;
    if (rule.mode === 'brainstorm' && hasDeliverable) continue; // suppressed: artifact in scope
    return { mode: rule.mode, confidence: 'high', reason: rule.reason };
  }
  return { mode: 'cascade', confidence: 'low', reason: 'no clear signal, cheapest first' };
}
