# port-spec.md — Orca 编排协议移植规格书

> 这份文件是什么：把 Orca 的 coordinator↔worker 编排协议逐机制映射到 modes MVP（`xxx -p` 非交互 fan-out）的权威清单——哪些移植、哪些精简、哪些不移植，以及对应的契约测试。
> 什么时候该读：在 `packages/orchestrator/` 写任何编排代码之前；写"红色契约测试"时按 §4 清单逐条落地；评审编排相关 PR 时对照表 1–3 的移植判断。
> 日期：2026-09-12 · Orca 证据基于 `stablyai/orca` main @ `403b62a8`（2026-09-12，浅克隆于 `/tmp/orca-ref`）
> 引用约定：本文所有 `src/...`、`skill-guides/...` 路径均指 Orca 仓库；`docs/...`、`packages/...` 指本仓库。

---

## 0. 一处侦察修正

任务描述说协议文档在 `skills/orchestration/`（约 7 份）。实际：`skills/orchestration/SKILL.md` 只是 69 行发现存根，真正的协议文档是 8 份：`skill-guides/orchestration.md`（内核指南）+ `skill-guides/orchestration/references/` 下 7 份条件参考（worker-contract / coordinator-loop / placement-and-remote / messaging-and-gates / recovery-and-cleanup / low-level-topology / legacy-contract-migration）。这套"指南由二进制内置、版本对齐"的设计本身由契约测试钉住（见 §4 第 1 条）。`src/cli/handlers/orchestration/` 实为 23 个文件（非 30+）。

## 1. 表 1：协议消息类型表

Orca 协议分两层：**mailbox 消息类型**（`src/main/runtime/orchestration/types.ts:2-12` 的 `MESSAGE_TYPES`）和 **CLI 命令动词**（`src/cli/specs/orchestration.ts` + `orchestration-worker-specs.ts`）。MVP 的根本差异：我们的 worker 是 `xxx -p` 一次性进程，**不能主动发消息、不能被 steer**——worker→coordinator 的全部信号由"进程退出码 + stdout 解析 + `git diff`"合成。

### 1A. Mailbox 消息类型（9 种）

| 类型 | 方向 | 载荷字段 | 语义 | MVP 判断 |
|---|---|---|---|---|
| `worker_done` | worker→coord | `taskId` `dispatchId` `outcome: succeeded\|failed` `filesModified[]` `reportPath` + 三句总结 body | 终态报告，恰好一次；结算 Task+Dispatch | **精简后需要**。不由 worker 发送，由 orchestrator 在进程退出后合成：exit 0 + 输出可解析 → `succeeded`。三句总结、`outcome` 显式、禁止"把失败藏进散文"这三条语义直接保留（worker-contract.md:60-74） |
| `heartbeat` | worker→coord | `taskId` `dispatchId` `phase` | 活性证明，5min 节拍，证明"活着"而非"完成"（preamble.ts:90-100） | **不需要**。非交互进程活性 = 进程存在；超时由 orchestrator 的 kill 定时器承担 |
| `escalation` | worker→coord | `taskId` `dispatchId` subject/body | 完成前的阻塞上报 | **精简后需要**。映射为失败落库：非零退出 / 额度错误 → JSONL `outcome: failed/quota_exhausted`（spec-mvp §5），如实呈现给用户（A6） |
| `question` / `ask` | worker→coord 阻塞 | `question` `options` `timeout-ms`；超时后 `--resume <message_id>` 续同一问题 | 阻塞式问答；禁止本地 TUI 提问 | **不需要**。`-p` 进程无人可答；prompt 必须自包含（Task-spec 五要素契约，orchestration.md:155-161） |
| `status` | 双向 | 自由文本 | 状态通报 | **不需要**。进度观察 = tail 进程输出，MVP 甚至可先不做 |
| `dispatch` | coord→worker | Task/Dispatch ID + preamble | 任务下发 | **精简后需要**。形式变为 spawn 参数：preamble 文本拼进 `-p` prompt，worktree 经 `cwd` 绑定 |
| `decision_gate` | coord 内部 | `task` `question` `options[]` → `resolution` | coordinator 拥有的 DAG 决策点 | **精简后需要**。MVP 唯一 gate = 交叉评审后"用户挑选 diff"，resolution 由人做出 |
| `merge_ready` | worker→coord | — | 合并就绪信号 | **不需要**。MVP 合并决策永远在人手里（spec-mvp §1） |
| `handoff` | coord/worker | — | 所有权移交 | **不需要**。属 orca-cli 全权移交场景，与"监督式编排"互斥（SKILL.md:6-14） |

消息公共字段（`MessageRow`，types.ts:233-253）：`id run_id from_handle to_handle subject body type priority thread_id payload read sequence created_at delivered_at`。MVP 只保留 `task_id`、类型、时间戳进入 JSONL；mailbox、thread、sequence 整套不移植。

### 1B. CLI 命令动词（31 个）

| 命令 | 语义 | MVP 判断 |
|---|---|---|
| `run-create` / `run-use` / `run-current` / `run-list` / `run-show` | Run = 持久命名空间 + coordinator 收件箱 | **精简后需要**。Run 退化为 spec-mvp §5 的 `task_id`（一次 fan-out 一个 id）；无绑定、无收件箱 |
| `worker-start` | 核心原语：placement + worktree + preamble 注入 + 监督所有权，一次调用完成（orchestration-worker-specs.ts:4-48） | **需要**。映射为 `git worktree add` + `spawn(cli, ['-p', prompt], {cwd})`；拒绝回执语义保留（见 §4 第 3 条） |
| `task-create` / `task-list` / `task-update` | Task CRUD + DAG deps | **精简后需要**。MVP 一个 prompt = 一个 task，deps/parent 进 backlog（spec-mvp §2.1） |
| `check`（`--wait` `--ack` `--peek` `--types`） | FIFO Delivery 消费，ack 前重放同批 | **不需要**。`Promise.allSettled` 替代等待；无 mailbox 即无 ack |
| `send` / `reply` / `inbox` | 通用邮件 | **不需要**（理由同 1A 各行） |
| `dispatch`（`--inject`） | 低级拓扑：把 prompt 注入已有终端，刻意不监督（low-level-topology.md:16-20） | **不需要**。我们从来就是"自己 spawn 进程"，无注入场景 |
| `worker-show` / `worker-read` / `worker-list` | 单 worker 检视 / 有界输出读取 / 车队活性枚举（liveness: `live`/`unverifiable`/`exited`） | **精简后需要**。观察性 = JSONL + 进程状态 + `git diff`；三值活性语义压缩成进程是否存在 |
| `worker-stop` | fence + 关闭受监督终端 | **精简后需要**。= 超时 `SIGTERM/SIGKILL`，只杀自己 spawn 的进程、不动 worktree（继承"stop 永不删 worktree"语义，recovery-and-cleanup.md:131-132） |
| `worker-abandon` / `worker-retain` / `worker-release` | 终端资源记账（放弃/保留/释放） | **不需要**。worktree 默认保留等用户合并，无终端资源概念 |
| `ask` | 见 1A `question` | **不需要** |
| `gate-create` / `gate-resolve` / `gate-list` | 见 1A `decision_gate` | **精简后需要**（唯一 gate = 人选 diff） |
| `request-show` / `--retry-request` | 变更幂等键：丢响应后查 `completed/pending/absent` 再决定重放（recovery-and-cleanup.md:76-94） | **不需要**。单机进程调用无网络分区；重复执行的防护由"失败不自动重试"承担 |
| `dispatch-show` | 查 Task 的 Dispatch 上下文 | **精简后需要**。合并进任务状态查询 |
| `reset` | 破坏性状态清除 | **不需要**。MVP 无持久编排状态可清 |
| `coordinator-start` / `coordinator-stop` | 已退役调度器，仅存留作迁移路标（orchestration.ts:224-251） | **不需要** |

## 2. 表 2：状态机

### 2A. Orca 原版（三实体，证据：`src/main/runtime/orchestration/db/lifecycle-transition.ts:70-98`）

| 实体 | 状态集合 | 关键迁移 |
|---|---|---|
| Task | `pending ready dispatched completed failed blocked` | 公共 `task-update` 接受任意迁移，守卫在调用侧 |
| Dispatch（一次权威尝试） | `pending dispatched completed failed circuit_broken` | 终态无出边；`failure_count ≥ 3` 熔断为 `circuit_broken`（dispatch-circuit-breaker.ts:2） |
| WorkerDispatch（监督资源） | `starting ready start_unknown failed succeeded stopping stop_unknown stopped abandoned` | `start_unknown`/`stop_unknown` 是一等状态：**观察缺席 ≠ 失败** |

worker_done 结算的 5 种拒绝码（types.ts:26-37，实现在 db/dispatch-context/worker-report-settlement.ts）：`unknown_task` / `unknown_dispatch` / `task_dispatch_mismatch` / `inactive_dispatch` / `stale_dispatch`。核心不变量：**结算必须同时携带 task_id + dispatch_id，旧 attempt 的迟到报告不能完成当前 attempt**。

### 2B. MVP 简化版（`-p` 非交互，无 steer/interrupt）

每路 worker 的状态即子进程状态，**单向无环、无 unknown 态**——这是非交互模式的红利：退出码是确定性终态信号，Orca 为"活性不可证"准备的 `start_unknown`/`unverifiable` 整层可以删掉。

| 状态 | 判定方式 | 迁移到 |
|---|---|---|
| `spawning` | `spawn()` 已调用 | 成功 → `running`；spawn 报错（CLI 不存在等）→ `failed` |
| `running` | 进程存活 | exit 0 且输出解析成功 → `succeeded`；exit 非 0 → `failed`；超时 kill → `timeout`；输出匹配额度耗尽特征 → `quota_exhausted` |
| `succeeded` | 终态。产出 = 解析后的结论 schema + `git diff` | — |
| `failed` / `timeout` / `quota_exhausted` | 终态，如实落 JSONL（spec-mvp §5 `outcome` 枚举），**不自动重试**（A6：降级不崩溃） | — |

fan-out 任务级状态：`pending → fanning_out → reviewing → awaiting_user_pick → done`；两路全失败 → 跳过评审直接 `awaiting_user_pick`（呈现双失败），对应 hermes"全顾问失败跳过合成"（§5）。评审路状态：`pending → running → agreed | disagreed | failed`；`disagreed` 如实标注，不伪造共识（A3）。

明确删除的 Orca 机制：`start_unknown`/`stop_unknown`/`unverifiable`（无观察不确定性）、心跳与 stale 检测（进程活性即答案）、`circuit_broken`（MVP 无重试，熔断进 backlog）、`consumer_fenced`（无 mailbox 重挂）。

## 3. 表 3：存储模型

| Orca 持久化（SQLite `orchestration.db`，schema v40，db/schema/create-*-tables-sql.ts） | 用途 | MVP 对应物 |
|---|---|---|
| `runs` / `run_coordinator_handles` | Run 命名空间 + coordinator 绑定 | `task_id` 一个字段，无表 |
| `tasks` / `dispatch_contexts` | Task + 每次尝试的权威记录（含 `retry_of`、`depth`、`capability_hash`） | **task 记录**（建议单个 JSON 或 JSONL 头行）：`task_id prompt worktree×2 branch×2 状态 时间戳` |
| `messages` / `deliveries` / `question_threads` | mailbox + FIFO 送达 + 阻塞问答 | 不持久化（无 mailbox） |
| `worker_dispatches` / `worker_terminal_resources` / `worker_terminal_archives` | 终端资源记账与输出归档 | **worktree 本身就是产物存储**——diff 现取现算，不归档输出 |
| `mutation_receipts` / `mutation_caller_identities` | 变更幂等回执 | 不需要（单机） |
| `attempt_observation_facts` | 尝试级观察事实 | 由 JSONL 埋点吸收 |
| `decision_gates` | DAG 决策点 | 用户选择结果追加进 JSONL（`verifier: "human"`） |
| federation/legacy/coordinator_runs 系列 | 远程执行、旧契约迁移、退役调度器 | 不移植（§6） |
| —（Orca 无对应） | — | **JSONL 效果记录（我们独有，spec-mvp §5）**：`task_id task_type model provider role outcome score cost latency verifier ts`，append-only，禁原地改，供未来蒸馏成路由偏好 |

结论：**MVP 不建 SQLite**。全部持久化 = 1 个 JSONL（效果记录）+ 可选 1 个任务 JSON（worktree/分支映射，供"选优合并"定位）。这个判断如有变化（例如要做历史任务列表 UI），再评估升级。

## 4. 契约测试清单（红色契约测试的输入）

移植原则：契约测试先于实现落地（constitution 第 1、2 条）。下表验收测试均放 `packages/orchestrator/tests/`。

| Orca 契约测试 | 它钉住的行为契约 | 我们的验收测试 |
|---|---|---|
| `config/scripts/orchestration-guide-command-contract.test.mjs` | 协议文档里出现的每个 verb + flag 必须被 CLI spec 接受——**文档与实现永不漂移**（扫描 8 份 guide 中所有 `ORCA orchestration <verb> <flags>` 对 `ORCHESTRATION_COMMAND_SPECS` 求包含） | `docs-impl-drift.contract.test.ts`：若 port-spec/spec-mvp 中出现命令式接口描述，断言实现 spec 覆盖；MVP 期可简化为"JSONL 字段表（spec-mvp §5）与埋点实现 schema 一致" |
| `src/shared/orchestration-dispatch-refusal-contract.test.ts` | 前置拒绝回执的 `code/message/data.nextSteps` 是**已发布字符串**，重构不得改写；`nextSteps` 按拒绝原因分派（retry/deps/占用/状态） | `spawn-refusal.contract.test.ts`：仓库无效 / CLI 不存在 / prompt 超限 → 稳定 `error.code` + 可操作提示，且**零副作用**（不建 worktree、不起进程） |
| `src/main/runtime/rpc/orchestration-contract-fence.test.ts` | 缺/错契约版本的变更请求在**参数解析之前**被拒，`effectsApplied: false`，handler 零调用 | `jsonl-schema-version.contract.test.ts`：未知 schema 版本的记录拒写/拒读，不静默吞 |
| `src/main/runtime/rpc/methods/orchestration/worker/worker-start-prompt-contract.test.ts` | 恰好一次提交（1 次 Enter、0 次提前提交）；`start_unknown` 不盲目重试不拆除；8 MiB spec 在任何 Task/Dispatch/终端效果**之前**被拒；早到的 worker_done 能更正 stall 误判 | `fanout-exactly-once.contract.test.ts`：一次 fan-out 恰好 spawn 2 进程、建 2 worktree；失败不自动重试（A6）；prompt 大小上限在 `git worktree add` 之前校验 |
| `src/main/runtime/orchestration/db/lifecycle-transition.test.ts` + `lifecycle-transition-boundary.test.ts` | 状态机非法迁移抛 `lifecycle_conflict`；终态无出边；投影列白名单 | `worker-state-machine.contract.test.ts`：§2B 状态机非法迁移抛错；终态不可再迁移 |
| `src/main/runtime/orchestration/db-task-dispatch-lifecycle-guards.test.ts` / `db-task-dispatch-races.test.ts` / `db-task-dispatch-invariant.test.ts` | worker_done 结算守卫：5 拒绝码、恰好一次结算、并发竞态下不双结算；**stale dispatch 的迟到报告不能完成当前 attempt** | `result-settlement.contract.test.ts`：结果落库幂等；重跑某一路时旧结果不得覆盖新结果（需要 attempt 维度 ID，见 §7 意外事实 1） |
| `src/main/runtime/orchestration/coordinator-decision-gates.test.ts` + `db/decision-gate-lifecycle.test.ts` | gate 生命周期 `pending → resolved/timeout`，resolution 必须来自 options | `user-gate.contract.test.ts`：评审结论呈现后，只有用户选择（A 或 B 或都放弃）能将任务推出 `awaiting_user_pick` |
| `src/shared/orchestration-rpc-contract.test.ts` | mutation 与只读操作的显式分类；退役方法显式列出而非静默消失 | `effect-classification.contract.test.ts`：orchestrator 公开操作的效果/只读分类表（写 JSONL、建 worktree、spawn = 效果） |

不移植的 Orca 测试族：mailbox/delivery/fencing（`dispatch-mailbox-consumer-fencing.test.ts` 等）、federation 全部、legacy migration 全部、structured pointer 全部——对应机制本身不移植（§6）。

## 5. 与 hermes MoA 语义的对照（基于 moa-recon-2026-08-28.md §3）

| hermes 机制（moa-recon §3 结论） | Orca 协议里的对应物 | 谁补缺口 |
|---|---|---|
| **never-raises 降级**：顾问失败变 `[failed: …]` 哨兵，主流程不抛 | 哲学同源但形态不同：Orca 的 "safe failure = 保留工作、报 unknown/unverifiable，只有阳性证据授权动作"（orchestration.md:33-36）+ 拒绝回执零副作用。我们的 `Promise.allSettled` + 终态落库即 MoA 哨兵的进程版 | Orca 有对应，直接用；降级不崩溃已由 A6 钉住 |
| **全失败跳过合成，主模型单独行动** | **无对应**。Orca 无"合成"步骤——coordinator（人/模型）直接读各 worker_done | **自己补**：两路全失败 → 跳过交叉评审，双失败如实呈现（已写入 §2B 任务级状态机） |
| **禁止套娃**（配置校验拒绝 MoA 指向自身） | **有直接对应**：`nested_worker_depth_exceeded` + Dispatch `depth` 列（types.ts:297）+ preamble 按 `canDispatchSubWorkers` 整段省略 sub-dispatch 说明（preamble.ts:187-191——"被告知'通常不能'委派的 worker 仍会尝试"） | Orca 对应物完整；MVP 更简单：`-p` worker 物理上无法再 fan-out，深度上限 = 1 由构造保证 |
| **guidance 末尾注入保 KV cache 前缀** | **部分对应**：preamble 的注入设计（preamble.ts:44-48——规则写成示例旁注释而非末尾散文，因为"LLM 读者锚定示例"）+ `=== TASK ===` 永远在最后（preamble.ts:139-142） | 注入点设计可直接抄（preamble 在前、TASK 在尾）；但 KV cache 动机不适用——我们每路都是全新一次性进程，无前缀可保 |
| **成本记账**（`_RefAccounting` 按 provider/model 计价） | **无对应**。Orca 全程不管 LLM 成本 | **自己补**：spec-mvp §5 `cost` 字段；非交互 CLI 的成本可得性待验证（订阅 CLI 未必报 token 用量，不确定处——允许先记 0 或 null 的妥协需回 spec-mvp 确认，目前 schema 里 `cost` 是必填 number） |

## 6. 明确不移植的部分

| Orca 机制 | 证据位置 | 一句话理由 |
|---|---|---|
| Federation（远程 execution host、relay 序列号、ack checkpoints、`--on` 部署） | `federation-*.ts`、types.ts:177-231 | MVP 单机，无远程执行语义 |
| Legacy contract migration（`[LEGACY …]` 标签、adoption、compatibility receipts） | references/legacy-contract-migration.md、db/schema/migrate-legacy-contract-storage.ts | 我们没有历史数据库和旧客户端要兼容 |
| Structured mailbox pointer delivery（指针投递、repoint 调度） | `structured-*-pointer-*.ts`、`mailbox-pointer-delivery-contract.ts` | 桌面终端 UI 的投递机制，我们无 mailbox |
| 终端资源生命周期（retain/release、terminal archive、PTY liveness 分层） | `worker-terminal-*.ts`、references/placement-and-remote.md | Electron 终端所有权语义；我们的"资源"只是子进程 + worktree |
| 心跳 / stale 检测 / drift probe | preamble.ts:38-42、`coordinator-drift-probe-coalescing.test.ts` | 进程存在性替代活性证明 |
| 契约版本 fence 的多版本协商（`client_contract_missing` 等 4 种 reason） | orchestration-contract-fence.ts、shared/orchestration-rpc-contract.ts:3-7 | 单一实现无版本错配；只保留"已知 schema 版本才写"的降级 |
| 变更幂等回执（`--retry-request`、`request-show`） | recovery-and-cleanup.md:76-94、types.ts:126-135 | 防的是 RPC 丢响应，单机进程调用无此故障模式 |
| agent 进程识别与 `--inject` | shared/orchestration-dispatch-refusal-contract.ts:69-82 | 向他人终端注入的修补路径；我们始终自己 spawn |
| WSL/Windows/移动端适配 | AGENTS.md 跨平台节、mobile/ | 平台壳问题，与编排语义无关，需要时从 AionUi 壳继承 |
| Group 地址（`@all` `@claude` 等）与 Run 邮箱路由 | references/messaging-and-gates.md:42-53 | 多 agent 群聊语义，MVP 只有 2 路点对点 |

## 7. 附：诚实标注的不确定处

1. spec-mvp §5 的 `task_id` 是"一次 fan-out"粒度，没有 attempt/路维度；要落实"旧结果不覆盖新结果"契约（§4 第 6 行），JSONL 可能需要补 `attempt_id` 或 `lane` 字段——这是对 spec-mvp 的修订建议，需回评审确认。
2. `cost` 字段在 CLI 非交互模式下的可得性未验证（§5 第 5 行）；若订阅 CLI 不暴露用量，需要么解析 stderr 的 usage 行（厂商各异、脆），要么向 spec-mvp 申请允许 `null`。
3. 交叉评审的"评审由另外两个模型/端点执行"（spec-mvp §3）与 MVP 只有 2 个 CLI 的关系：若就是这两家互评，则"一致才推荐合并"的判定方身份（`verifier` 字段）已够；若未来要第三方仲裁，属 backlog，本文未展开。
4. Orca 的 8 MiB spec 上限是针对其 RPC 通道的；我们的 prompt 经 argv 传递，实际约束是 OS 的 ARG_MAX（macOS ~256KB 的 getenv 限制经 spawn 参数）——prompt 上限值需实测后写入实现，本文不定具体数字。
