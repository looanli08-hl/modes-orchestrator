# seams.md — AionUi 接缝分析（适配层设计输入）

> 这份文件是什么：packages/orchestrator 与 AionUi 核心之间适配层的设计依据——四条关键接缝的现状、可复用性与缺口。
> 什么时候该读：写 `packages/orchestrator/` 任何代码之前。
> 日期：2026-09-12 · 基于 v2.2.2 源码只读分析

---

## 0. 架构前提（影响所有结论）

v2.2.2 是**三层架构**：TS 壳（Electron / web-host+web-cli）→ **`aioncore` Rust 二进制后端**（从 `iOfficeAI/AionCore` releases 下载的**闭源**二进制，v0.2.2，`resources/bundled-aioncore/`）→ CLI agent 进程。

- **本仓库没有任何 ACP spawn 代码**：`@agentclientprotocol/sdk` 声明在根 package.json 但源码零引用；ACP handshake、CLI 探测、登录态接管全在 aioncore 内部，**不可见不可控**
- TS ↔ aioncore 之间是 **HTTP REST + 单个 WebSocket（`/ws`）**，契约目录集中在 `packages/desktop/src/common/adapter/ipcBridge.ts`（2500 行 endpoint 目录）
- TS 侧类型文件是 Rust 类型的镜像（"Mirror of aionui-api-types/src/*.rs"）

**战略含义**：fork 拿到的是壳和 UI，agent 管理核心在闭源二进制里。这强化了 spec-mvp 的选择——MVP 的 fan-out 走官方非交互 CLI 模式（`xxx -p`），**完全不经过 aioncore**。

## 1. ACP 接管链路

调用链：aioncore 探测 `$PATH` 上的 CLI 落 `agent_metadata` 表（TS 侧只读 `GET /api/agents/management`）→ 渲染层 `useGuidSend.ts` → `POST /api/conversations`（`{type:'acp', assistant, extra:{workspace}}`，见 `apiModelMapper.ts:56`）→ `POST /api/conversations/{id}/runtime/ensure`（aioncore 惰性拉起 CLI、完成 handshake，全程 Rust 内部）→ `POST .../messages` 发 prompt，WS `/ws` 收 `message.stream` + `turn.completed`（含 `last_message`，`ipcBridge.ts:447`）。

**可复用性：半能。** aioncore 的 HTTP+WS 接口本身就是无 UI 的 programmatic 通道（任何 HTTP 客户端都能驱动），但 TS 侧没有可 import 的封装（ipcBridge 依赖渲染层环境）。
**缺口**：aioncore 闭源；WebUI 模式有 JWT cookie + CSRF 认证成本；没有"prompt→Promise<结果>"的现成封装。

## 2. Headless 派发能力

存在，最近的是 **cron 通道**：`POST /api/cron/jobs`（`schedule:{kind:'at'}` + `execution_mode:'new_conversation'` + `agent_config` 指定 CLI/model/workspace）→ `POST /api/cron/jobs/{id}/run` 立即触发返回 `{conversation_id}` → WS `cron.job-executed` 报状态 → 从该 conversation 读回结果。契约清晰、全程 headless、aioncore 执行。

**可复用性：半能（备选通道）。** 实质是"headless 派任务给已登录 CLI + 独立 workspace + 收结果"，省掉自己管 CLI 认证；但走 ACP 常驻会话语义，每次执行在 DB 留 conversation 记录，多路并行的聚合/超时/结构化解析要自己写。
**缺口**：不是官方非交互模式（`claude -p` 式一次性进程）。MVP 主路径不用它，留作备选。

## 3. RotatingApiClient / 多 Key 轮询

`packages/desktop/src/common/api/`：`RotatingApiClient.ts:49` 抽象基类（401/429/503/5xx 重试，多 key 先 rotate 再重试）+ `ApiKeyManager.ts:14`（多 key 解析、失败拉黑 90s、**轮换时写 `process.env`**——为多 CLI 子进程设计，并行场景有竞态）+ 三个厂商实现。服务对象是内置引擎的**裸 API 调用**，不覆盖 CLI agent 路径。

**可复用性：能，但仅作参考实现**（纯 TS、有单测）。它管 API key 不管 CLI 订阅账号，对 fan-out CLI 场景基本不适用；可用于未来"裸 API 评审员"端点。
**缺口**：与 vision 的"额度感知路由"差距大——无配额状态机、无跨厂商 fallback、90s 黑名单是写死启发式。

## 4. Team 模式

`TTeam`（`common/types/team/teamTypes.ts:58`）= 1 个 leader slot + N 个 teammate slot，各有独立 conversation_id 和 ACP runtime；workspace 支持 `shared | isolated`；成员间经 mailbox 通信；`ITeamTaskItem`（`{subject, status, owner, blocked_by[], blocks[]}`）——**DAG 形状的数据结构已存在**。

**关键判断：编排智能在 leader agent 的 prompt 里，不在代码里。** 消息怎么拆给谁由 leader 自由发挥；无交叉评审协议；`blocked_by/blocks` 只是数据字段无依赖调度器；结果聚合无 schema。这正是 vision §2 说的"AionUi 协作停留在 Leader 群聊水平"。
**可借鉴**：REST+WS 契约完整可 programmatic 驱动；`ITeamTaskItem` 的字段形状可作任务契约命名参考。

## 5. MVP 最短路径（1 prompt → 2 CLI agent 独立 worktree → 收结果）

**完全不经过 aioncore**，五步全部自写但每步都小：

1. worktree 准备：`git worktree add` × 2 + 独立分支
2. fan-out 派发：`child_process.spawn('gemini', ['-p', prompt], {cwd: worktree})` × 2 + `Promise.allSettled` + 超时（几十行）
3. 结果回收：CLI 输出解析成固定 schema；diff 直接 `git diff` 拿，不依赖 CLI 输出格式
4. 交叉评审：A 的产出喂给 B 的评审 prompt（同样 `-p` 模式），解析"一致/不一致"
5. JSONL 埋点：按 spec-mvp §5 字段表追加写

现成可借：aioncore cron 通道（备选）；RotatingApiClient（未来裸 API 评审端参考）；ITeamTaskItem 字段形状（命名参考）。

**待验证风险**：若改用 aioncore 通道，先验证 WebUI 模式的 JWT/CSRF 握手成本（`web-cli/src/ensureAdminPassword.ts` 是唯一现成样板）和 `turn.completed.last_message.content` 是否承载完整最终文本（类型显示是）。
