/**
 * Unit test: classifyTask — the auto-mode router's pure prompt classifier
 * (spec-mvp §2.5 auto row). The core question is "does the user want an
 * answer/opinion or a code deliverable":
 *   compete    — code wanted AND an explicit multi-version comparison intent
 *   brainstorm — opinion wanted (consult/evaluate signal) AND no deliverable noun
 *   cascade    — executional verb, or the no-signal fallback (cheapest first)
 * Priority is compete > brainstorm > cascade; a deliverable noun suppresses
 * brainstorm; the pure fallback reports confidence "low".
 */

import { describe, expect, it } from 'vitest';

import { classifyTask } from '../src/router/classifyTask';

function expectMode(prompt: string, mode: 'compete' | 'brainstorm' | 'cascade') {
  expect(classifyTask(prompt).mode).toBe(mode);
}

describe('classifyTask: compete (explicit multi-version intent only)', () => {
  it.each([
    '给我两个方案实现用户登录',
    '两种实现各写一版，我来挑',
    '各来一版试试',
    '哪个实现好：递归还是迭代',
    '对比实现：乐观锁 vs 悲观锁',
    'write two versions of the parser',
    'compare two implementations of a rate limiter',
  ])('routes %j to compete with high confidence', (prompt) => {
    const c = classifyTask(prompt);
    expect(c.mode).toBe('compete');
    expect(c.confidence).toBe('high');
    expect(c.reason.length).toBeGreaterThan(0);
  });
});

describe('classifyTask: brainstorm (opinion wanted, no deliverable)', () => {
  it.each([
    '你怎么看这个创业方向',
    '你觉得这个功能值得做吗',
    '分析一下这个方案的优缺点',
    '该不该从单体迁到微服务',
    '如何评价这个新框架，靠谱吗',
    '这个产品方向能成吗',
    '给我一些选型建议',
    'should I use SQLite or Postgres for this app',
    'what do you think about GraphQL',
    'pros and cons of remote work',
    'evaluate the trade-offs of SSR versus CSR',
  ])('routes %j to brainstorm with high confidence', (prompt) => {
    const c = classifyTask(prompt);
    expect(c.mode).toBe('brainstorm');
    expect(c.confidence).toBe('high');
    expect(c.reason.length).toBeGreaterThan(0);
  });
});

describe('classifyTask: a deliverable noun suppresses brainstorm', () => {
  it('consult signal + deliverable noun + execute verb → cascade, high', () => {
    // 你觉得 (consult) is suppressed by 函数 (deliverable); 写 (execute) decides
    const c = classifyTask('你觉得这个函数写得怎么样，帮我改一下');
    expect(c.mode).toBe('cascade');
    expect(c.confidence).toBe('high');
  });

  it('consult signal + deliverable noun, no execute verb → cascade fallback, low', () => {
    const c = classifyTask('分析一下这段代码为什么慢');
    expect(c.mode).toBe('cascade');
    expect(c.confidence).toBe('low');
    expect(c.reason).toContain('no clear signal');
  });

  it('evaluate + README → suppressed to cascade fallback', () => {
    expectMode('评估一下这个 README 的质量', 'cascade');
    expect(classifyTask('评估一下这个 README 的质量').confidence).toBe('low');
  });

  it('file extensions count as deliverables (.ts)', () => {
    const c = classifyTask('what do you think about the types in api.ts');
    expect(c.mode).toBe('cascade');
  });
});

describe('classifyTask: cascade (executional verbs)', () => {
  it.each([
    '实现一个 LRU 缓存',
    '修复登录页的样式错位',
    '给这个模块加日志',
    '创建一个 git hook 脚本',
    '把 wc.py 翻译成 wc.js',
    '重构 sumNumbers',
    '生成一份周报模板',
    '优化这个查询',
    'Create a file util.js with a clamp function',
    'fix the off-by-one in fib.js',
    'add a README for this repo',
    'refactor the parser into a pure function',
    'translate this script to Python',
    'build a small CLI for renaming photos',
  ])('routes %j to cascade with high confidence', (prompt) => {
    const c = classifyTask(prompt);
    expect(c.mode).toBe('cascade');
    expect(c.confidence).toBe('high');
  });
});

describe('classifyTask: no-signal fallback is cascade with low confidence', () => {
  it.each(['', '   ', '随便聊聊', 'hello world', '？？？'])(
    'routes %j to cascade, low confidence, honest reason',
    (prompt) => {
      const c = classifyTask(prompt);
      expect(c.mode).toBe('cascade');
      expect(c.confidence).toBe('low');
      expect(c.reason).toBe('no clear signal, cheapest first');
    }
  );
});

describe('classifyTask: priority', () => {
  it('compete beats brainstorm when both signals are present', () => {
    // 两个方案 (compete) + 你觉得 (consult) → compete wins
    expectMode('你觉得哪个实现好？给我两个方案', 'compete');
  });

  it('brainstorm beats cascade when only consult + verb-ish noise is present', () => {
    // consult signal present, no deliverable noun → brainstorm even though the
    // topic mentions building things abstractly (no execute verb hit)
    expectMode('你觉得我们应该怎么选数据库', 'brainstorm');
  });
});
