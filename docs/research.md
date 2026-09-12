# research.md — 生态调研备忘

> 这份文件是什么：竞品与生态的事实清单，每条注明来源与日期。只收最终结论，不收探索过程。
> 什么时候该读：做任何"选型 / 移植 / 差异化"决策前；每月复核上游 changelog 时更新。
> 日期：2026-09-12

---

## 1. Orca（编排协议蓝本）

- 仓库 `stablyai/orca`，MIT 协议，2026-03 发布，YC W2022 背景（Stably AI）。〔来源：Kimi 策略对话存档 [5][7][9] 轮网络调研，2026-09〕
- 星数：约 46k（2026-09 上旬第三方榜单口径）；注意口径冲突——2026-09-11 GitHub API 实时为 66k、周增约 5.5k，增长极快，引用时注明日期。〔对话 [9]〕
- 发版节奏近乎每日（v1.4.199 @2026-09-09），breaking change 是常态。〔对话 [9]〕
- 核心交互是**半自动 fan-out**：同一 prompt 并行派给最多 5 个 agent，各自独立 git worktree，人审 diff 合并。Orca 自己不拆任务。〔对话 [5][7]〕
- 编排是**消息协议驱动的 coordinator-worker 模型**（源码实读）：任务 DAG（`task-create --deps` / `task-list --ready`）、worker 生命周期契约（heartbeat / ask / check / escalation / `worker_done` 三句话结项报告）、consumer fencing（防止两个 agent 认领同一任务）、决策门；完整编排指南由二进制自己 serve，文档永不与实现脱节。〔对话 [15]，实读 `skills/orchestration/` 与 `src/cli/handlers/orchestration/`〕
- **orchestration 契约测试存在**（`orchestration-guide-command-contract.test.mjs` 等），可直接移植为我们的验收测试——这是"移植 > 从零写"的关键支点。〔对话 [15][19]〕
- 软肋：open issues 一个月近翻倍（8 月中约 1,726 → 9-11 合计 5,782），增长债明显；配额有"监控"无"调度"；对比评审纯人工；国产生态荒地。〔对话 [9]〕

## 2. AionUi（本仓库的上游基底）

- 仓库 `iOfficeAI/AionUi`，Apache-2.0，fork 锁定 **v2.2.2（发布于 2026-09-09）**，约 24k 星，中国团队，Electron + TypeScript。〔对话 [11][15]〕
- 双接入模式（源码实读）：**内置引擎**——填 API Key 即用，含 `RotatingApiClient` 多 Key 轮询（401/429/503 自动换 Key 重试）；**ACP 接管**——自动探测本机已登录的 Claude Code / Codex / Qwen Code 等 CLI。〔对话 [13][15]〕
- 团队模式是 Leader + 成员 slot 群聊模型，协作环境以 MCP 注入——**没有 DAG、没有 worker 契约**，这是我们补的空位。〔对话 [15]，实读 team PRD〕
- 已占位（不是我们的差异化）：WebUI 远程 / headless 服务器模式、Telegram / 飞书 / 钉钉 / 微信通知、cron 定时任务、20+ CLI agent 与 30+ 模型适配。〔对话 [11][13]〕

## 3. 编排层空位复核（2026-09-12 已完成，结论：空位成立）

复核方法：浅克隆两仓读编排层源码（非仅文档）。

**T3 Code**（[pingdotgg/t3code](https://github.com/pingdotgg/t3code)，MIT，~18k 星，最后提交 2026-09-12）：定位是"agent harness 控制面"。其 `apps/server/src/orchestration/` 名为编排引擎，实为 event-sourced 的**会话/线程状态机**（decider/projector/reactor），命令全集是 thread 生命周期，无任务间依赖概念。四问全否：无 DAG、无任务级 worker 契约（只有驱动 CLI 进程的 provider 适配层）、无自动交叉评审（review 全由人做）、用量只是 ccusage 式报表不参与调度。**定性：加强版"人盯着的并行终端"。**

**Paseo**（[getpaseo/paseo](https://github.com/getpaseo/paseo)，~14k 星，最后提交 2026-09-12）：**许可证更正——2026-08 已从 AGPL-3.0 relicense 为 Apache-2.0**（issue #2982，全仓无 AGPL 字样），此前的 AGPL 隔离顾虑失效。有 agent 生命周期协议 + worktree 隔离一等公民（`isolation: "worktree"`），委员会/顾问/handoff 以 SKILL.md 提示词形式存在（`skills/paseo-committee/SKILL.md` 等）——但编排智能寄生在调用 MCP 工具的 LLM 的 prompt 里，无 DAG、结果回收是自然语言文本无结构化 schema、无成本感知路由。**定性：daemon 是并行终端 + 生命周期管理，编排靠提示词不靠引擎。**

**结论**：2026-09 没有人占住"有协议的智能编排"。差异锚点一句话：**我们是唯一把"结构化 worker 契约 + 确定性 fan-out/交叉评审/diff 聚合"做成引擎（代码保证）而非提示词（LLM 自觉）的产品**。T3/Paseo 的活跃度反向证明了"多 CLI agent 并行 + worktree 隔离 + 移动 steering"的市场需求已被验证。

## 4. 国产模型现状（2026-09）

- 2026-08 中旬一周内 DeepSeek V4 Pro、GLM-5.3、Kimi K3 三家旗舰齐发，全主打编码 agent、百万级上下文。〔对话 [13]〕
- **三家开放平台均提供官方 Anthropic 兼容端点**，文档直接写明"用 Claude Code 接入"：GLM（open.bigmodel.cn/api/anthropic）、DeepSeek（api.deepseek.com/anthropic，自动按 Claude 档位映射模型）、Kimi（api.moonshot.cn/anthropic，K3 官方 OpenAI + Anthropic 双协议）。〔对话 [13]〕
- 核心认知：**CLI = 壳（harness），模型 = 脑子**，脑子经 Anthropic 兼容端点可随便换。正确抽象是统一端点层——端点背后是国产 API 还是 CLI 免费 OAuth，对上层编排器无区别。〔对话 [13][15]〕
- 额度现状：Qwen Code OAuth 免费 2000 次/天；Gemini CLI 免费 1000 次/天；DeepSeek 仅按量、分时定价；GLM Coding Plan 包月需抢。〔对话 [3][13]〕

## 5. 路由层真空

- **claude-code-router（CCR）已停维**：Claude Code 2.x 改内部认证逻辑，CCR 未适配，最后更新停在 2026-01。"把任意 coding CLI 接到任意模型"的路由层出现真空。〔对话 [11]，x-cmd 页面，2026-01〕
- **cc-switch（farion1231）有 OAuth 热切换 bug**：多官方 OAuth 账号切换后 `claude auth status` 仍显示旧账号，根因是未正确替换 `~/.claude.json` 的 oauthAccount 字段（issue #4850，2026-06-30）。〔对话 [11]〕
- Anthropic 官方明确表态：不认可、不维护、不审计任何把 Claude Code 路由到非 Claude 模型的第三方网关——版本更新随时可能 break。〔对话 [13]〕

## 6. modes 旧仓资产结论（摘要）

- 完整盘点表：`/Users/looanli/Projects/harness/docs/research/modes-inventory.md`（2026-09-12，分支 `modes/v1-goal-stewardship`）。
- **"抢这 5 样"清单**（总成本约 46–74h ≈ 1.5–2 周单人）：
  1. `packages/modes-stewardship` 整包——runtime-neutral 目标托管 + worker 选择，编排器"任务生命周期"的现成域核（直接搬，4–8h）
  2. grounding/judge + outcome_verifier + learning 晋升管线 + session_model_usage——拼成"任务预分类 → 执行 → 成败验证 → 效果落库 → 路由偏好蒸馏"的路由记忆闭环（提炼思想，16–24h）
  3. qa/desktop 的 deterministic-provider + journey-contract 测试模式——fan-out 链路验收测试骨架（提炼思想，16–24h）
  4. dsh-bridge 的 approval/questions/steer/interrupt 四类带外语义——编排协议人机介入通道设计（提炼思想，8–16h）
  5. `evals/coding-parity` 数据集——v0.5 dogfooding 指标的现成基线评测集（直接搬，2h）
- 明确不拿：modes-ui（记录在案等衍生品）、dsh 绑定的所有代码层、context_capsule 同步、spike/work/ 历史材料。

## 7. hermes 的隐藏蓝本

- **hermes 自带 `agent/moa_loop.py`（2125 行）本身就是生产级 MoA 实现**。〔modes-inventory §7 D2，2026-09-12〕
- harness 仓库 `work/moa-recon-2026-08-28.md` 已做逐机制移植分析：并行扇出、顾问 never-raises 降级、全失败跳过合成、禁止套娃、advisory 视图渲染、guidance 末尾注入保 KV 前缀、按顾问窗口裁剪、成本记账——机制清单与实现平台无关，直接作为 MoA 聚合器的 spec 输入。
- 切割声明：recon 的 dsh 落地方案（cordis 插件 + `ctx.llm.stream`）整体失效，本项目底座是 AionUi fork + Orca 协议，不携带 dsh。
- 《移植规格书》阶段有两个蓝本交叉参考：Orca 编排协议（工程结构）+ hermes moa_loop（语义细节）。

## 8. AI 辅助开发的硬数据（支撑 constitution 第 5/8 条）

- Sonar 2026 调查：88% 开发者报告 AI 生成代码产生负面效果，53% 认为"看着正确但不可靠"（"理解债"）。〔对话 [19]〕
- LinearB：AI 生成的 PR 平均 2.6 倍大，合并率不到人工一半。〔对话 [19]〕
- CMU 追踪 806 个团队：采用 AI 编程后静态分析警告 +30%、认知复杂度 +41%。〔对话 [19]〕
- 反面证据同样存在（有同行评审研究发现 AI 代码重复率更低）——结论：**纪律才是自变量，瓶颈在验证和理解，不在生成**。〔对话 [19]〕
