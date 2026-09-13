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
| `qwen` 0.23.3 | ⚠️ 已安装，但 **Qwen OAuth 免费额度 2026-04-15 已停用**——需 Coding Plan（付费）或 DashScope API key（`--auth-type openai` + 百炼 key） |
| `iflow` 0.5.19 | ⚠️ key 有效（错 key 报 434，正确 key 报 435）但**账号下所有模型均 "Model not support"**（qwen3-coder-plus / kimi-k2.5 / deepseek-v3.2-chat / glm-5 / minimax-m2.5 全部试过）。`selectedAuthType` 需用 `openai-compatible`（`iflow` 已弃用）。疑似免费 API 政策收紧或需在控制台开通模型——待用户查控制台 |
| `claude` | ❌ OAuth session expired，用户表示国外模型暂不可用，搁置 |
| `codex` 0.137.0 | ❌ models cache 报错（`unknown variant 'max'`），同上搁置 |

**路线决定（2026-09-13 用户拍板）**：MVP 双路全用国产模型。lane A = kimi。lane B 候选（按优先级）：iflow（若控制台能开通模型）→ ModelScope 免费 API（`api-inference.modelscope.cn/v1`，OpenAI 兼容，经 qwen CLI `--auth-type openai` 接入）→ DeepSeek 官方 API（付费但极便宜）→ 百炼 DashScope（新用户有免费额度）。**编排层对 provider 无感——任何 OpenAI 兼容端点都能借 qwen CLI 变成一路 worker。**

未认证/模型不可用报错已录入 `tests/fixtures/`（qwen/iflow auth-missing），钉住"认证失败 = failed，不误判 quota_exhausted"的解析行为。

### 下一步

1. 用户填 iflow API key → 立刻跑 **kimi + iflow 真实双路 fan-out** 端到端验证
2. A4 手动验收：真实仓库上完成一次"选优合并"（需要人）
3. `runTask` 目前 `model: 'unknown'`——真实模型标识从 CLI 配置透传（kimi: `~/.kimi-code/config.toml` 的 default_model；iflow: settings.json 的 modelName）
