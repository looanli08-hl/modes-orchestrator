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
4. ~~【backlog 决策点】评审加推荐路输出~~ ✅ 2026-09-13 完成：评审 prompt 升级为双标记——`VERDICT` 判对错 + `PICK: A/B/TIE` 判优劣；缺 PICK 标记 = null 不伪造（8 新测试）。真实复跑鹦鹉任务：评审给出 "PICK: A" 且理由细化到解剖结构/车架合理性。modes-run 展示"评审推荐"行
5. ~~【backlog】recordUserPick 手动触发~~ ✅ `scripts/modes-run.ts` 交互命令已串起全流程：fan-out → 展示双路 diff + 评审 → 问 pick → `recordUserPick` + `mergeLane`（含 merge 冲突自动 abort 回滚，2 测试）。验证：piped pick B 端到端跑通，git log 留 merge 痕，JSONL 4 条记录齐（worker×2 / reviewer / gate）
6. 【backlog】任务状态持久化（task JSON，port-spec §3）——modes-run 单进程内闭环已成立，持久化的价值变成"跨会话恢复/历史列表"，优先级下降

## Day 1 续 2 — 编排模式落地（spec-mvp §2.5）

- [x] spec-mvp 修订：模式表（compete 默认 / brainstorm / solo / cascade / 高风险 gate）+ N 路约定（fanOut/settle/JSONL 天然 N 路，评审与 gate 的 A/B 二态是 compete 的 MVP 简化）
- [x] role 枚举 +`synthesizer`（spec-mvp §5 第二次同日修订，drift 契约同步）
- [x] `patterns/brainstorm`：N 路并行回答（**无 worktree 无合并**——思考型任务不碰 git）→ 一路综合多样性；单路失败降级照跑，全失败跳过综合不伪造（3 集成测试）
- [x] `modes-run --mode brainstorm` 接线
- [x] 真实双路验证（"付费主题商店能成吗"）：综合器保留了双路多样性、裁决了 lane B 的内部矛盾、升级了结论。**观察到的毛病**：kimi 综合器自作主张在 workDir 写了一个分析文档——brainstorm 语义上是纯思考，lane 该不该禁写文件，留作设计问题（候选：prompt 里声明 / 跑在隔离 scratch 目录）

## Day 1 续 3 — brainstorm 物理隔离 + modes console（产品化第一步）

- [x] **brainstorm lane 物理隔离**：lane/综合器 cwd 改为 `mkdtemp` scratch 目录（结束即删），流氓写文件不再污染 workDir（新增测试：rogue lane 写文件只落 scratch）。真实复跑（苹果发布会总结）：workDir 仅余 `.modes/`，综合器正确裁定"lane B 前提过时"冲突
- [x] **扩展机制摸底**（explore 结论）：AionUi 扩展加载器在闭源 aioncore 里；`contributes.webui`（apiRoutes + staticAssets）= 万能后门，settings tab iframe 同源可 fetch 自有 apiRoutes——**不用碰 packages/desktop 就能嵌面板**。卡点：入口只能在设置页深处、无 WS 只能轮询
- [x] **modes console**：`src/server/consoleServer.ts`（node:http，deps 注入）+ `taskRegistry.ts`（running → awaiting_pick/done/failed）+ `panel/index.html`（单文件面板）+ `scripts/modes-console.ts`（`bun packages/orchestrator/scripts/modes-console.ts`，默认 4177）。16 测试；同套资产未来可原样搬进扩展的 webui 贡献
- [x] **真实端到端（HTTP API 驱动）**：POST compete（写秋天诗）→ 双路成功 → 评审 agreed + 推荐 A（理由细致到"B 第二句'日渐长'与秋天矛盾且与自己的摘要自相矛盾、末句重字、缺尾换行"）→ POST pick A → 合并落盘，git log 留痕，状态 done
- 设计取舍：console id 与引擎 taskId 双轨（引擎 id 跑完才有）；pick 失败不回终态留人工解冲突；worktreePath/branch/eventsFile 不下发前端

### 下一步（更新）

1. 把 console 资产包成 AionUi 扩展（webui staticAssets + apiRoutes + settingsTab 着陆），验证 aioncore 扩展加载链路
2. backlog 照旧：model 字段透传、kimi 报错 exit 0 解析防御、N 路 compete、cascade
3. console 状态持久化（重启即丢，目前可接受）

## Day 1 续 4 — 三线并行：扩展封装 + 两个 backlog 清偿

- [x] **modes-console 扩展**（`extension/modes-console/`）：薄壳 + 代理架构。无头实测真实 aioncore 2.2.2：扩展加载 ✓、settings tab 渲染 panel ✓、onActivate 幂等拉起 console server ✓。**发现上游坑：v2.2.2 不挂载 webui apiRoutes**（上游示例同样 404，详见 seams.md §6）→ 改为内嵌面板直连 127.0.0.1:4177
- [x] **token 防护**：直连意味着任意网页本可 CSRF 驱动"能改代码能 merge 的 agent"→ consoleServer 加 loopback token（`.modes-console-token` 0600，server/activate 共享）+ CORS；子代理还多堵了一个洞：GET / 对非 loopback Origin 不注入 token，防恶意网页回读。+10 测试
- [x] **kimi exit-0 报错防御**：输出开头 `error:` → failed（quota 检测优先级不变），4 参数化用例 + 反误伤用例
- [x] **model 字段透传**：`spawn/modelResolution.ts`，kimi←config.toml default_model、qwen←.env OPENAI_MODEL，绝不抛异常（元数据不能搞挂运行）+ 进程内缓存。runTask/brainstorm 四处接线
- 测试总数 127 全绿。console server 新版在 4177 跑着

### 下一步（更新）

1. 用户实测 AionUi 桌面端里的扩展面板（无头链路已全通，桌面端 iframe 渲染是最后一厘米）
2. console 状态持久化（重启即丢）
3. backlog：N 路 compete（锦标赛）、cascade 模式

### 踩坑：dev 模式起不来的根因（21:47 启动失败）

`bun run dev` 报"AionCore 启动失败"，日志 `stage: resolve_binary`：dev 模式 `process.resourcesPath` 指向 Electron 内部目录，bundled 查找必然落空 → 走 PATH 也找不到。解法：显式指二进制——

```bash
AIONUI_EXTENSIONS_PATH=$PWD/packages/orchestrator/extension \
AIONUI_BACKEND_BIN=$PWD/resources/bundled-aioncore/darwin-arm64/aioncore \
bun run dev
```

带两个变量重启后实测：aioncore 起在 51296、`/api/extensions` 列出 modes-console（enabled）、settings tab 注册、面板 HTML 里 `MODES_API_BASE`/`MODES_TOKEN` 注入齐全。

## Day 1 续 5 — modes-eval 场景评测器（e2e 回归套件）

- [x] `src/eval/`（scenarios + runEval，deps 注入）+ `scripts/modes-eval.ts`：5 个真实 CLI 场景（simple-create / modify-existing / impossible-task / review-disagree / brainstorm-basic），自动 pick（跟评审推荐 → 第一成功路 → neither）+ merge 验证，结果追加 `evals/eval-runs.jsonl`（gitignored）。15 单测
- [x] **首次全量实跑 5/5 通过（~4.8 min）**；首跑 impossible-task 的 FAIL 是验证逻辑校准（空 diff merge = git no-op），非假期望
- [x] **评测器首功**：抓到 runTask 评审失败分支缺 `pick` 字段（已修）
- [x] 调研结论：promptfoo/deepeval 评的是模型输出质量，不认识编排协议语义（merge 落盘/JSONL 契约/gate 流转）——协议回归套件必须自建；模型质量评测未来可 leverage promptfoo
- 观察：`review-disagree` 两轮 kimi 均稳定胜出 qwen —— 路由记忆数据开始积累

## Day 1 续 6 — N 路 compete（锦标赛第一步）

- [x] **N 路泛化**：`parseReviewVerdict(text, knownLanes?)`（PICK 任意 lane 字母，指向场外 lane = null 不伪造）；`createTaskLifecycle(taskId, {lanes})`（pick ∈ lanes ∪ neither，默认 A/B 向后兼容）；console pick 端点/panel 按钮/modes-run 提示/eval decidePick 全部 lane 感知；spec-mvp §2 措辞更新
- [x] eval 新场景 `three-lane`（kimi/qwen/kimi 二次尝试当 lane C）：真实跑 PASS，事件流 3 worker + reviewer + gate 齐
- [x] **评测器第二功**：three-lane 最初 5 次全报 quota_exhausted——查实为误报：prompt 让写"rate limiter"，CLI 回显关键词即被 quota 检测误判（exit 0 也查全量输出）。修复：exit 0 时仅当输出 < 300 字符（纯道歉无产出）才判 quota_exhausted；短输出真 quota（如 "rate limit hit, stopped early"）行为不变。TDD 红→绿
- [x] three-lane 场景 prompt 改回 rate limiter 题材，兼任该 bug 的真实回归
- 测试总数 154 全绿

## Day 1 续 7 — console 任务持久化

- [x] taskRegistry 加 persistence 适配器注入 + `filePersistence.ts`（原子写 `.modes-console-tasks.json`，gitignored）；僵尸 running 任务 load 时如实标 failed；修剪最近 100 条；pick 指针（worktreePath/branch）一并持久化，重启后 awaiting_pick 仍可 pick。12 新测试，总数 166 全绿
- [x] 冒烟：server 重启后任务历史和详情完整恢复（4299 端口实测）
- [x] 4177 的 console 已重启为最新版（持久化 + token + N 路），旧内存实例已清
