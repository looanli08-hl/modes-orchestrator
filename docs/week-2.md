# week-2.md — 第二周：红灯变绿

> 这份文件是什么：实现周的逐日记录。上周的 8 个红色契约测试是验收标准，本周逐个让它们转绿。
> 什么时候该读：每天早上；评审实现 PR 时对照。
> 日期：2026-09-13 起

---

## Day 1（2026-09-13）— MVP 原语全部落地，walking skeleton 跑通

- [x] `bun install` 注册 `@modes/orchestrator` 进 workspace（上周遗留）
- [x] 按依赖序实现 6 个原语，8 个红色契约测试全部转绿（33 测试）：
  `schema/eventLog` → `store/eventLogStore` → `worker/workerStateMachine` →
  `spawn/spawnWorker`（`PROMPT_MAX_BYTES = 128KiB`，ARG_MAX 推导，port-spec §7.4 定案）→
  `fanout/fanOut` → `settlement/settleResult` → `gate/userGate` → `operations/effectClassification`
- [x] A2 输出解析器 `parse/workerOutput`（9 测试，含真实 `kimi -p` 录制夹具）：
  quota 特征识别（rate limit / 429 / insufficient_quota / 额度…）→ `quota_exhausted`，与普适 failed 区分
- [x] A3 交叉评审 `review/crossReview`（7 测试）：`VERDICT: AGREE|DISAGREE` 末尾标记解析，
  无标记 = `failed`，不伪造共识
- [x] 真实 deps `fanout/realDeps`：`git worktree add` + 分支、spawn + 超时 kill（SIGTERM→SIGKILL）、
  `diffWorktree` 用一次性 GIT_INDEX_FILE 保证 readonly 分类不破（effect-classification 契约）
- [x] `run/runTask` 端到端流水线 + 3 个集成测试（fake CLI + 真实临时 git 仓库）：
  A1（2 worktree + 2 分支）、A5（JSONL ≥3 条且 §5 字段齐全）、A6（单路失败降级）、
  双路全失败跳过评审直接进 `awaiting_user_pick`
- [x] 验证：orchestrator 52 测试全绿；全量 `bun run test` 5013 通过 0 失败；oxlint 0 警告

### 环境实况（2026-09-13 探测，影响真实 fan-out 验证）

| CLI | 状态 |
|---|---|
| `kimi` 0.42.0 | ✅ `-p` 非交互可用（夹具来源），当前模型 `kimi-code/k3` |
| `qwen` 0.23.3 | ✅ **已打通 = lane B**。OAuth 免费额度 2026-04-15 停用 → 改走 ModelScope 免费推理 API：`~/.qwen/.env` 配 `OPENAI_API_KEY/BASE_URL/MODEL`（`api-inference.modelscope.cn/v1`，模型 `Qwen/Qwen3-Coder-30B-A3B-Instruct`，settings `selectedType: openai`） |
| `iflow` 0.5.19 | ⚠️ key 有效（错 key 报 434，正确 key 报 435）但**账号下所有模型均 "Model not support"**（qwen3-coder-plus / kimi-k2.5 / deepseek-v3.2-chat / glm-5 / minimax-m2.5 全部试过）。`selectedAuthType` 需用 `openai-compatible`（`iflow` 已弃用）。疑似免费 API 政策收紧，搁置 |
| `claude` | ❌ OAuth session expired，用户表示国外模型暂不可用，搁置 |
| `codex` 0.137.0 | ❌ models cache 报错（`unknown variant 'max'`），同上搁置 |

**路线决定（2026-09-13 用户拍板）**：MVP 双路全用国产模型。**lane A = kimi（K3），lane B = qwen CLI → ModelScope（Qwen3-Coder-30B）**。iflow 等免费政策明朗再入池。**编排层对 provider 无感——任何 OpenAI 兼容端点都能借 qwen CLI 变成一路 worker。**

未认证/模型不可用报错已录入 `tests/fixtures/`（qwen/iflow auth-missing），钉住"认证失败 = failed，不误判 quota_exhausted"的解析行为。

## Day 1 续 — 真实双路 fan-out 打通（MVP 链路全线验证）

- [x] ModelScope token 配置进 qwen CLI（OpenAI 兼容模式），`qwen -p` 跑通
- [x] **CLI 适配层 `spawn/cliAdapters`**（5 测试）：qwen/iflow 需 `--yolo` 否则"exit 0 但零产出"；
  kimi `-p` 与 `--auto` 互斥（`Cannot combine --prompt with --auto`），裸 `-p` 本就无人值守——两条都是实测踩出来的
- [x] `scripts/manual-fanout.ts`（A4 验收工具）：一条命令真实 fan-out + 打印双路 diff + 评审结论
- [x] **真实端到端三次迭代**：① kimi ✅ / qwen 零产出（发现 --yolo 需求）→ ② qwen ✅ / kimi 被拒（发现 --auto 互斥）→ ③ **双双成功，diff 一致（同 blob hash），kimi 评审 "agreed" 且理由具体**；JSONL 三条记录 latency 真实（并行两路各 ~9.4s，评审 12.4s），状态停在 `awaiting_user_pick`

### 下一步

1. ~~A4 手动验收~~ ✅ 2026-09-13 完成：鹦鹉骑车 SVG 任务，kimi（精致场景）vs qwen/ModelScope（要素齐全但糙），
   评审 agreed，**用户选 A 合并**，gate 记录 `verifier: "human:A"` 落 JSONL——MVP 全链路（fan-out → 评审 → 人拍板 → 合并）闭环
2. `runTask` 目前 `model: 'unknown'`——真实模型标识从 CLI 配置透传（kimi: `~/.kimi-code/config.toml` 的 default_model；qwen: `~/.qwen/.env` 的 OPENAI_MODEL）
3. kimi 报错时 exit 0 的怪癖（`error: Cannot combine...` 也是 exit 0）——解析器后续需要"stdout 以 error: 开头视为 failed"的防御（已观察，未实现）
4. 【backlog 决策点】评审目前只判对错不判优劣：两路都"对"但质量悬殊时 agreed 无区分度。是否给评审加"推荐哪路"输出，待讨论
5. 【backlog】`recordUserPick` 已能落账，但 runTask 的 lifecycle 还在内存里——pick 动作目前是脚本手动触发。持久化任务状态（task JSON，port-spec §3 提过）后再串成一条命令
