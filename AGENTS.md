# AGENTS.md — modes 智能编排器 · AI 助手导航

> 这份文件是什么：给 AI 编码助手（和人类新成员）的仓库入口地图。
> 什么时候该读：每次开工第一件事，先读本文件，再读 `docs/constitution.md`，任务来自 `docs/spec-mvp.md`。
> 日期：2026-09-12

---

## 项目是什么（一段话）

modes 智能编排器：fork 自 AionUi v2.2.2（Apache-2.0），在其产品壳之上构建**有协议的智能编排**——移植 Orca 的 coordinator-worker 编排协议（任务 DAG + worker 契约），叠加 hermes 记忆思想做路由器长期记忆。差异化只有一条轴：**编排智能**。远程/通知等 AionUi 已有能力不是差异化，不去碰。详见 `docs/vision.md`。

## 代码库地图（AionUi 原始结构，顶层一行说明）

| 路径 | 说明 |
|---|---|
| `packages/desktop/` | Electron 桌面端主代码（main/renderer/preload 三进程），上游核心——**只读，勿改** |
| `packages/web-cli/` | WebUI/headless 模式的 CLI 入口，上游核心——**只读，勿改** |
| `packages/web-host/` | WebUI 服务器宿主，上游核心——**只读，勿改** |
| `packages/shared-scripts/` | 跨包共享脚本，上游核心——**只读，勿改** |
| **`packages/orchestrator/`** | **我们的独立包**：全部编排逻辑（fan-out、worker 契约、交叉评审、JSONL 埋点）只许住在这里，经适配层接触 AionUi 核心 |
| `examples/` | 上游扩展示例（ext-feishu、ext-wecom-bot、acp-adapter-extension 等），是我们的适配层参考教材 |
| `docs/` | 上游文档 + 我们的创始文档（vision/constitution/research/spec-mvp/week-1） |
| `tests/`、`scripts/`、`resources/`、`public/` | 上游测试、构建脚本、应用资源、静态资源 |
| `mobile/` | 上游移动端伴侣 |

> 上游 AionUi 的原始开发约定（代码风格、i18n、测试、提交格式）保留在 `docs/upstream/AGENTS.aionui.md`，在其核心目录**只读**的前提下仍适用于我们新增代码的风格对齐。
>
> TODO(Day 2)：让 AI 通读 fork 后把每个顶层目录的一行说明补全细化（见 `docs/week-1.md`）。

## 铁律（详见 `docs/constitution.md`，这三条先记住）

1. **不动 AionUi 核心目录**——编排代码只进 `packages/orchestrator/`，经适配层交互（宪法第 3 条）。
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
