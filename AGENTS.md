# AGENTS.md — modes 智能编排器 · AI 助手导航

> 这份文件是什么：给 AI 编码助手（和人类新成员）的仓库入口地图。
> 什么时候该读：每次开工第一件事，先读本文件，再读 `docs/constitution.md`，任务来自 `docs/spec-mvp.md`。
> 日期：2026-09-12

---

## 项目是什么（一段话）

modes 智能编排器：fork 自 AionUi v2.2.2（Apache-2.0），在其产品壳之上构建**有协议的智能编排**——移植 Orca 的 coordinator-worker 编排协议（任务 DAG + worker 契约），叠加 hermes 记忆思想做路由器长期记忆。差异化只有一条轴：**编排智能**。远程/通知等 AionUi 已有能力不是差异化，不去碰。详见 `docs/vision.md`。

## 代码库地图（2026-09-12 通读补全）

顶层：

| 路径 | 说明 |
|---|---|
| `packages/desktop/` | Electron 桌面端主代码（main/renderer/preload 三进程，~143k LOC），上游核心——**只读，勿改** |
| `packages/web-cli/` | WebUI/headless 模式独立 CLI（bin `aionui-web`，~680 LOC），不依赖 Electron——**只读** |
| `packages/web-host/` | WebUI 宿主库（~3.9k LOC）：spawn aioncore 后端 + 静态托管 SPA + 反向代理，desktop↔web 共享枢纽——**只读** |
| `packages/shared-scripts/` | 跨包构建脚本（prepare-aioncore / 打包资源校验）——**只读** |
| **`packages/orchestrator/`** | **我们的独立包**：全部编排逻辑（fan-out、worker 契约、交叉评审、JSONL 埋点）只许住在这里，经适配层接触 AionUi 核心。已实现：schema/eventLog、eventLogStore、workerStateMachine、spawnWorker、fanOut、settleResult、userGate、effectClassification、workerOutput 解析、crossReview、runTask 端到端流水线 |
| `examples/` | 上游扩展示例（hello-world 全能力演示、acp-adapter-extension 最小 ACP 贡献、e2e-full-extension 测试夹具、ext-feishu、ext-wecom-bot），是适配层参考教材 |
| `docs/` | 上游文档 + 我们的创始文档（vision/constitution/research/spec-mvp/week-1/**seams**） |
| `tests/` | 上游全部测试的家：unit/ 515 个 vitest、e2e/ 121 个 Playwright spec、fixtures/（fake-acp-cli 等） |
| `scripts/` | 35 个构建/发布/冒烟脚本 |
| `mobile/` | Expo/React Native 移动伴侣，远程连桌面端 WebUI，不内嵌 agent 逻辑 |

`packages/desktop/src/` 下一级：

| 路径 | 一行说明 |
|---|---|
| `src/index.ts` | Electron main 总入口：Sentry → 存储/桥接初始化 → 起 aioncore 后端 → 建主窗口 |
| `src/common/` | 三进程共享：adapter（IPC↔HTTP 双栈抽象，**ipcBridge.ts 是 2500 行 API 契约目录**）、api（RotatingApiClient 等 LLM 客户端）、chat、config、types |
| `src/process/` | main 进程业务侧：bridge/（12 个 IPC 桥，renderer→main 唯一入口）、backend/（aioncore spawn）、startup/、services/、pet/（桌宠）、utils/ |
| `src/preload/` | contextBridge 暴露 `electronAPI.emit`，4 文件 |
| `src/renderer/` | React SPA（~128k LOC，桌面窗口和 WebUI 复用）：pages/（conversation 最大、settings 15+ 子页、team、cron）、components/、services/、hooks/、api/ |

**架构一句话**：真正的后端是闭源 Rust 二进制 **aioncore**（acp spawn/CLI 探测/登录态接管都在其内部），TS 壳经 HTTP REST + WS(`/ws`) 驱动它；renderer 一切能力经 `common/adapter` 双栈（桌面走 IPC，WebUI 走 HTTP）。编排层对接前必读 `docs/seams.md`。

## 铁律（详见 `docs/constitution.md`，这三条先记住）

1. **不动 AionUi 核心目录**——编排代码只进 `packages/orchestrator/`，经适配层交互（宪法第 3 条）。唯一例外是登记在 `docs/shell-patches.md` 的受控壳补丁（宪法第 3 条例外条款，2026-09-14 起）。
2. **新代码必须带测试**——无测试不合并；移植协议时先移契约测试再写实现（宪法第 1、2 条）。
3. **先读 docs 再动手**——`docs/vision.md`（做什么不做什么）→ `docs/constitution.md`（怎么做事）→ `docs/spec-mvp.md`（当前唯一任务）。聊天记录、临时想法不进入开发流程。

## 常用命令

```bash
bun install        # 安装依赖（上游 lockfile 为 bun.lock，统一用 bun，不要用 npm——npm 不支持 workspace:* 协议）
bun run dev        # 桌面端开发模式（electron-vite dev）
bun run test       # 全部测试（vitest run）
bun run lint       # lint（oxlint）
bun run package    # 构建桌面安装包（electron-vite build）
```

## 上游同步纪律

- 锁定 AionUi **v2.2.2**，不追 main；
- 每月看一次上游 changelog，按需 cherry-pick 单个修复；
- **永不** `git rebase` / `git merge` 上游 main（宪法第 4 条）。

## 合规红线（一句话版）

只做官方非交互模式 + 跨厂商切换 + BYO 账号；不碰同厂商多账号池、转售、反向代理。详见 `docs/vision.md` §3。
