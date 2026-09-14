/**
 * abQuality — blind A/B eval: roundtable (multi-CLI debate) vs a single model.
 *
 * Each question is answered twice: once by a lone CLI (arm "single", no debate
 * machinery — a plain spawn like a roundtable round-1 lane) and once by
 * runRoundtable (arm "roundtable", synthesis as its answer). A judge CLI then
 * grades both answers anonymized as X/Y, twice per question with the X/Y order
 * swapped, so a judge that merely prefers the first answer it sees cancels out.
 *
 * Honesty rules (same lineage as roundtable's "consensus is never fabricated"):
 *  - a missing/malformed WINNER marker is "undecidable", never credited to a side;
 *  - the two judgments must agree before a win is counted; disagreement — or any
 *    undecidable judgment — is "unstable", not a win for anyone;
 *  - an arm that failed to answer is recorded as such; the question is not judged
 *    on a fabricated empty answer.
 * Nothing here asserts or assumes which arm should win.
 */

import type { SpawnedProcessResult } from '../fanout/fanOut';
import { parseWorkerOutput } from '../parse/workerOutput';
import type { RoundtableOptions, RoundtableResult } from '../patterns/roundtable';
import { buildWorkerArgs } from '../spawn/cliAdapters';

export interface AbQuestion {
  id: string;
  question: string;
  /** optional judging-dimension hints; folded into the judge prompt */
  criteria?: string[];
}

/**
 * Six Chinese decision/trade-off questions — no single right answer, so quality
 * differences (depth of reasoning, trade-off coverage, actionability) can show.
 */
export const AB_QUESTIONS: AbQuestion[] = [
  {
    id: 'mvp-stack',
    question:
      '一个 5 人初创团队要在 3 个月内上线一个内容社区 MVP。后端应该选 NestJS + PostgreSQL 自建，还是直接用 Supabase / Firebase 这类 BaaS？给出你的推荐和理由。',
    criteria: ['权衡覆盖（短期速度 vs 长期可控性）', '对团队规模约束的敏感度', '建议的可执行性', '风险识别'],
  },
  {
    id: 'monolith-vs-micro',
    question:
      '一家公司的内部运营系统（约 20 个使用者，2 名兼职开发）目前是一个单体 Rails 应用，有声音提议拆成微服务"为未来扩展做准备"。你支持拆还是不拆？为什么？',
    criteria: ['是否识别出真实规模', '对"为未来扩展"这种论点的处理', '运维成本考量', '结论是否明确'],
  },
  {
    id: 'features-vs-debt',
    question:
      '产品团队下个季度只有一个迭代的余量：是优先做用户呼声最高的新功能（导出报表），还是还掉拖慢开发速度的技术债（混乱的权限模块）？给出你的优先级判断和决策框架。',
    criteria: ['决策框架是否清晰', '是否量化或具体化了取舍', '对利益相关方的覆盖', '可执行性'],
  },
  {
    id: 'build-vs-buy-observability',
    question:
      '一个 30 人的 SaaS 团队在纠结可观测性方案：自建 ELK + Prometheus 全家桶，还是直接买 Datadog？请给出推荐，并说明在什么条件下你的答案会反转。',
    criteria: ['总拥有成本意识（含人力）', '反转条件是否具体', '权衡覆盖', '建议的可执行性'],
  },
  {
    id: 'rewrite-vs-refactor',
    question:
      '一个跑了 8 年的 Java 遗留系统，文档缺失、只有原作者留下的注释，团队抱怨"每次改动都踩雷"。有人提议重写。你建议重写还是渐进式重构？给出路线和判断依据。',
    criteria: ['对重写风险的认识', '路线是否具体可落地', '对业务连续性的考虑', '判断依据是否明确'],
  },
  {
    id: 'ai-tooling-policy',
    question:
      '一家金融公司的工程负责人在犹豫要不要全面放开 AI 编程助手（如 Copilot 类工具）给全体工程师使用。安全团队担心代码泄露，工程师抱怨效率受限。你会给出什么政策建议？',
    criteria: ['对安全顾虑的实质性回应', '政策是否可操作（而非口号）', '权衡覆盖', '分级/分阶段思维'],
  },
];

/** what the judge literally said, before mapping X/Y back to real arms */
export type JudgePick = 'X' | 'Y' | 'TIE' | 'INVALID';

/** a judgment with X/Y mapped back to the real arm; 'undecidable' = missing/malformed marker or judge failure */
export type MappedJudgment = 'single' | 'roundtable' | 'tie' | 'undecidable';

export type AbWinner = 'single' | 'roundtable' | 'tie' | 'unstable';

export interface AbJudgeCall {
  /** which arm was shown as X in this call */
  mapping: { X: 'single' | 'roundtable'; Y: 'single' | 'roundtable' };
  pick: JudgePick;
  mapped: MappedJudgment;
  /** the judge's full output text */
  rawOutput: string;
}

export interface AbQuestionResult {
  questionId: string;
  /** 'arm_failed' when an arm produced no usable answer — no judging was run on it */
  status: 'ok' | 'arm_failed';
  winner: AbWinner | null;
  singleAnswer: string;
  roundtableAnswer: string;
  judgments: AbJudgeCall[];
  failures: string[];
  durationMs: number;
}

export interface AbQualityDeps {
  spawnProcess: (cli: string, args: string[], opts: { cwd: string }) => Promise<SpawnedProcessResult>;
  runRoundtable: (options: RoundtableOptions) => Promise<RoundtableResult>;
}

export interface RunAbQualityOptions {
  workDir: string;
  /** judge CLI (default kimi) — also the roundtable synthesizer */
  judgeCli?: string;
  /** the lone answerer for arm "single" (default kimi) */
  singleCli?: string;
  /** roundtable seats (default kimi + qwen) */
  roundtableClis?: string[];
  timeoutMs?: number;
}

const WINNER_PATTERN = /WINNER:\s*(X|Y|TIE)\s*$/gim;

/**
 * The LAST WINNER marker wins: a judge that quotes the format instructions while
 * reasoning gets its final verdict, not its echo. The marker must run to the end of
 * its line — trailing junk ("WINNER: X Y") is malformed. Missing/malformed → INVALID —
 * a win is never fabricated from a sloppy judge.
 */
export function parseJudgePick(text: string): JudgePick {
  const matches = [...text.matchAll(WINNER_PATTERN)];
  if (matches.length === 0) return 'INVALID';
  return matches[matches.length - 1][1].toUpperCase() as JudgePick;
}

/** map an anonymized pick back to the real arm; INVALID stays undecidable */
export function mapPickToArm(pick: JudgePick, mapping: AbJudgeCall['mapping']): MappedJudgment {
  if (pick === 'INVALID') return 'undecidable';
  if (pick === 'TIE') return 'tie';
  return mapping[pick];
}

/**
 * Two-judgment aggregation: a side wins only when both judgments name it;
 * double-tie is a tie; anything else (opposite winners, winner-vs-tie, any
 * undecidable) is unstable — never silently credited to a side.
 */
export function aggregateJudgments(first: MappedJudgment, second: MappedJudgment): AbWinner {
  if (first === 'tie' && second === 'tie') return 'tie';
  if (first === second && (first === 'single' || first === 'roundtable')) return first;
  return 'unstable';
}

export function buildJudgePrompt(
  question: AbQuestion,
  answerX: string,
  answerY: string
): string {
  const criteria =
    question.criteria && question.criteria.length > 0
      ? question.criteria.join('; ')
      : 'depth of reasoning; coverage of trade-offs; actionability; risk awareness';
  return `You are judging an anonymous A/B comparison. Two answers (X and Y) to the same
decision question are shown below. Judge which answer is BETTER overall for someone who
must act on it.

Evaluation dimensions: ${criteria}

Do not guess which system produced which answer. Judge only the content. If they are
genuinely equivalent in quality, declare a tie rather than forcing a winner.

=== QUESTION ===
${question.question}

=== ANSWER X ===
${answerX}

=== ANSWER Y ===
${answerY}

=== YOUR VERDICT ===
Give a brief rationale (2-4 sentences), then end your response with exactly one final line:
WINNER: X  |  WINNER: Y  |  WINNER: TIE`;
}

/** arm "single": a plain one-shot answer, no debate machinery (same spawn shape as a roundtable lane) */
async function answerSingle(
  question: AbQuestion,
  deps: AbQualityDeps,
  cli: string,
  workDir: string
): Promise<{ answer: string; failure: string | null }> {
  const raw = await deps.spawnProcess(cli, buildWorkerArgs(cli, question.question), { cwd: workDir });
  const parsed = parseWorkerOutput(raw);
  if (parsed.outcome !== 'success' || parsed.summary === '') {
    return { answer: '', failure: `single arm (${cli}) outcome=${parsed.outcome}` };
  }
  return { answer: parsed.summary, failure: null };
}

/** arm "roundtable": the debate's synthesis; falls back to the last round's answers when synthesis failed */
async function answerRoundtable(
  question: AbQuestion,
  deps: AbQualityDeps,
  options: RunAbQualityOptions
): Promise<{ answer: string; failure: string | null }> {
  const clis = options.roundtableClis ?? ['kimi', 'qwen'];
  const result = await deps.runRoundtable({
    prompt: question.question,
    clis,
    synthesizerCli: options.judgeCli ?? 'kimi',
    workDir: options.workDir,
    timeoutMs: options.timeoutMs,
    taskType: `ab:${question.id}`,
  });
  if (result.synthesis !== null && result.synthesis !== '') {
    return { answer: result.synthesis, failure: null };
  }
  const lastRound = result.rounds[result.rounds.length - 1];
  const survivors = (lastRound?.lanes ?? []).filter((l) => l.outcome === 'success' && l.answer !== '');
  if (survivors.length > 0) {
    return { answer: survivors.map((l) => l.answer).join('\n\n---\n\n'), failure: null };
  }
  return { answer: '', failure: `roundtable arm produced no synthesis and no surviving answers` };
}

async function judgeOnce(
  question: AbQuestion,
  deps: AbQualityDeps,
  options: RunAbQualityOptions,
  mapping: AbJudgeCall['mapping'],
  singleAnswer: string,
  roundtableAnswer: string,
  failures: string[]
): Promise<AbJudgeCall> {
  const judgeCli = options.judgeCli ?? 'kimi';
  const answerX = mapping.X === 'single' ? singleAnswer : roundtableAnswer;
  const answerY = mapping.Y === 'single' ? singleAnswer : roundtableAnswer;
  const raw = await deps.spawnProcess(judgeCli, buildWorkerArgs(judgeCli, buildJudgePrompt(question, answerX, answerY)), {
    cwd: options.workDir,
  });
  const parsed = parseWorkerOutput(raw);
  if (parsed.outcome !== 'success') {
    failures.push(`judge (${judgeCli}) outcome=${parsed.outcome}`);
  }
  const pick = parsed.outcome === 'success' ? parseJudgePick(parsed.summary) : 'INVALID';
  return { mapping, pick, mapped: mapPickToArm(pick, mapping), rawOutput: parsed.summary };
}

export async function runAbQuestion(
  question: AbQuestion,
  deps: AbQualityDeps,
  options: RunAbQualityOptions
): Promise<AbQuestionResult> {
  const started = Date.now();
  const failures: string[] = [];

  const single = await answerSingle(question, deps, options.singleCli ?? 'kimi', options.workDir);
  if (single.failure) failures.push(single.failure);
  const roundtable = await answerRoundtable(question, deps, options);
  if (roundtable.failure) failures.push(roundtable.failure);

  const base = {
    questionId: question.id,
    singleAnswer: single.answer,
    roundtableAnswer: roundtable.answer,
    failures,
    durationMs: Date.now() - started,
  };

  // A missing arm means there is nothing to blind-compare — no judging on a
  // fabricated empty answer.
  if (single.failure !== null || roundtable.failure !== null) {
    return { ...base, status: 'arm_failed', winner: null, judgments: [] };
  }

  // Judgment 1 shows single as X; judgment 2 swaps — a judge biased toward the
  // first answer cancels out instead of systematically favoring one arm.
  const first = await judgeOnce(
    question,
    deps,
    options,
    { X: 'single', Y: 'roundtable' },
    single.answer,
    roundtable.answer,
    failures
  );
  const second = await judgeOnce(
    question,
    deps,
    options,
    { X: 'roundtable', Y: 'single' },
    single.answer,
    roundtable.answer,
    failures
  );

  return {
    ...base,
    status: 'ok',
    winner: aggregateJudgments(first.mapped, second.mapped),
    judgments: [first, second],
    durationMs: Date.now() - started,
  };
}

/** questions run sequentially: real CLIs share the user's accounts and rate limits */
export async function runAbQuality(
  questions: AbQuestion[],
  deps: AbQualityDeps,
  options: RunAbQualityOptions
): Promise<AbQuestionResult[]> {
  const results: AbQuestionResult[] = [];
  for (const question of questions) {
    // oxlint-disable-next-line no-await-in-loop -- sequential by design: real CLIs share rate limits
    results.push(await runAbQuestion(question, deps, options));
  }
  return results;
}

export interface AbTotals {
  single: number;
  roundtable: number;
  tie: number;
  unstable: number;
  armFailed: number;
}

export function summarizeAbResults(results: AbQuestionResult[]): AbTotals {
  const totals: AbTotals = { single: 0, roundtable: 0, tie: 0, unstable: 0, armFailed: 0 };
  for (const r of results) {
    if (r.status === 'arm_failed') {
      totals.armFailed += 1;
    } else if (r.winner !== null) {
      totals[r.winner] += 1;
    }
  }
  return totals;
}

export function formatAbReport(results: AbQuestionResult[], totals: AbTotals): string {
  const lines: string[] = ['──── A/B BLIND EVAL: roundtable vs single ────'];
  for (const r of results) {
    const verdict = r.status === 'arm_failed' ? 'arm_failed (not judged)' : (r.winner ?? 'unknown');
    const failures = r.failures.length > 0 ? `\n    failures: ${r.failures.join('; ')}` : '';
    lines.push(`${r.questionId.padEnd(28)} ${verdict}${failures}`);
  }
  lines.push('──── TOTALS ────');
  lines.push(
    `roundtable ${totals.roundtable} win(s) / single ${totals.single} win(s) / tie ${totals.tie} / unstable ${totals.unstable}` +
      (totals.armFailed > 0 ? ` / arm_failed ${totals.armFailed}` : '')
  );
  return lines.join('\n');
}
