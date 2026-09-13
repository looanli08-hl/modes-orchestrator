# spec-mvp.md — MVP 规格（walking skeleton）

> 这份文件是什么：MVP 的唯一权威规格。范围内只有一条 walking skeleton；范围外的东西写得和范围内的一样清楚。
> 什么时候该读：开工写第一行产品代码前；评审任何 MVP 相关 PR 时对照验收标准。
> 日期：2026-09-12

---

## 1. 唯一目标：一条 walking skeleton

```
一个 prompt
  → fan-out 到 2 个 CLI agent（各自独立 git worktree）
  → 交叉评审（两个结果互评 + 结论一致判定）
  → 汇总 diff 给用户挑选合并
```

端到端跑通这一条链路即完成 MVP。链路每一环都可以粗糙，但必须真实、可观察、可测试。

## 2. 本期明确不做（全部进 backlog）

1. **DAG 流水线**（任务拆解、依赖解析、ready 队列）——backlog。
2. **配额状态机**（额度感知路由、冷却调度）——backlog。MVP 只在失败时报错并记录，不自动切换。
3. **免费/付费分层**（免费额度打头阵、付费模型兜底）——backlog。
4. 模型协调者（让模型当 coordinator）——backlog；MVP 的协调者是规则代码 + 人。
5. GUI 美化——沿用 AionUi 既有界面能力，不为 MVP 新增 UI 打磨。

## 2.5 编排模式（2026-09-13 修订）

任务类型决定编排模式，不是每个任务都走"竞争 + 人挑"。模式由调用方显式指定（`--mode`），或交给 `auto` 规则路由。

| 模式 | 适用 | 流程 | 人的角色 |
|---|---|---|---|
| `compete`（默认，已实现） | 产出型任务（写代码/写文档） | 2 路 fan-out → 交叉评审（VERDICT + PICK）→ 人挑一稿合并 | 最终拍板 |
| `brainstorm`（已实现） | 思考型任务（想方案/比思路） | N 路 fan-out（无 worktree、无合并）→ 一路综合多样性 → 呈现全集 + 综合 | 只看不动手 |
| `solo` | 快速问答 | 单路直出 | — |
| `cascade`（已实现） | 省钱优先 | 串行降级链：便宜先上，仅客观信号升级（outcome ≠ success 或 success 但零 diff），直到某级"成功且非空 diff"或链耗尽 → 人决定 merge 或不要 | 最终拍板 |
| `auto`（已实现） | 调用方不确定该用哪个模式 | 规则路由 v1：启发式分类 prompt（compete > brainstorm > cascade，交付物名词压制 brainstorm，无信号兜底 cascade）→ 按 resolved 模式执行；路由决策落 JSONL（task_type=auto:<模式>）。数据攒够后换数据驱动 | 同 resolved 模式 |
| 高风险 gate | 动核心代码 | compete + 测试验证 gate | backlog |

N 路约定：fanOut/settle/JSONL 天然 N 路；评审与 gate 已泛化到 N 路（PICK/pick 为任意 lane 字母，按本场 lanes 校验）；更复杂的 N 路策略（锦标赛/排序）进 backlog。

## 3. 架构约束

- 全部编排代码放 `packages/orchestrator/`（constitution 第 3 条）。
- 两个 CLI agent 只通过各自官方非交互模式调用（如 `qwen -p` / `gemini -p` / `claude -p` / `codex exec`），通过适配层接入，不改 AionUi 核心（constitution 第 11 条）。
- 每个 agent 分配独立 `git worktree` + 独立分支，禁止并行写同一工作区。
- 交叉评审：实现由 worker 模型产出，评审由另外两个模型/端点执行，结论一致才进入"推荐合并"（constitution 第 8 条）。

## 4. 验收标准（可观察、可测试）

| # | 标准 | 验证方式 |
|---|---|---|
| A1 | 给定一个 prompt 和一个 git 仓库，一条命令能同时启动 2 个 CLI agent，各自在独立 worktree 中工作 | 集成测试：临时仓库上跑 fan-out，断言生成 2 个 worktree + 2 个分支 |
| A2 | 每个 agent 的最终产出以结构化形式回收（结论 + 文件变更 diff），TUI 轨迹不进入下游 | 单元测试：输出解析器对录制的 CLI 输出样本出固定 schema |
| A3 | 两份产出进入交叉评审，产出"一致 / 不一致"判定 + 评审意见；不一致时如实标注，不伪造共识 | 契约测试：固定输入对，断言评审输出 schema 与判定字段存在 |
| A4 | 用户面前呈现两份 diff 的对比视图 + 评审结论，可选择其一合并或都放弃 | 手动验收：真实仓库上完成一次"选优合并" |
| A5 | 全链路每一步落 JSONL 埋点（字段见 §5），链路结束后记录完整可查 | 测试：跑一次链路，断言 JSONL 追加 ≥ 预期条数且字段齐全 |
| A6 | 任一 agent 失败（超时/非零退出/额度耗尽）不阻塞另一路，失败如实落库并呈现给用户 | 测试：注入失败端点，断言链路降级而非崩溃 |
| A7 | 上述测试全部纳入 `bun run test`，CI 可复现 | `bun run test` 全绿 |

## 5. JSONL 埋点字段表（constitution 第 7 条）

| 字段 | 类型 | 说明 |
|---|---|---|
| `task_id` | string | 本次 fan-out 的唯一 id |
| `schema_version` | number | 记录 schema 版本（当前 `1`）；未知版本的记录拒写拒读，不静默吞（对应 port-spec §4 `jsonl-schema-version` 契约） |
| `lane` | string | fan-out 内的路标识（如 `"A"` / `"B"` / `"review"`）；同一 task_id 下每路一条记录 |
| `attempt_id` | string | 某一路的一次权威尝试 id；重跑该路产生新 attempt_id，旧 attempt 的结果不得覆盖新结果（对应 Orca 的 stale-dispatch 不变量，见 port-spec §2A） |
| `task_type` | string | 任务分类（MVP 期允许为 `"unknown"`， schema 必须先占位） |
| `model` | string | 实际执行的模型标识 |
| `provider` | string | 端点标识（CLI 名或 API 提供方） |
| `role` | string | `worker` / `reviewer` / `gate` / `synthesizer`（gate = 人类 gate 决策记录，`verifier: "human"`；synthesizer = brainstorm 模式的多样性综合者；2026-09-13 两次修订） |
| `outcome` | string | `success` / `failed` / `timeout` / `quota_exhausted` |
| `score` | number \| null | 评审得分（无评审环节则为 null） |
| `cost` | number \| null | 本次调用成本（免费额度记 0；CLI 未暴露用量时记 null，不伪造） |
| `latency` | number | 端到端毫秒 |
| `verifier` | string | 产出该结论的验证方（评审模型 id 或 `"human"`） |
| `ts` | string | ISO8601 时间戳 |

约束：append-only；禁止原地修改历史记录；定期蒸馏成路由偏好（晋升管线模式，本期只需保证记录存在）。
