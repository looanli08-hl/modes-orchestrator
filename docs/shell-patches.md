# shell-patches.md — 受控壳补丁登记册

> 宪法第 3 条例外条款的配套登记：每一个对上游目录的改动都在这里留痕。
> 规则：只加入口/链接，不改上游既有行为逻辑；diff 保持最小；上游 cherry-pick 时逐条核对本表。
> 日期：2026-09-14 起

| # | 日期 | 文件 | 改动 | 理由 | 上游同步注意点 |
|---|------|------|------|------|----------------|
| 1 | 2026-09-14 | `packages/desktop/src/renderer/components/layout/Sider/index.tsx`、`.../Sider/SiderNav/SiderModesEntry.tsx`（新增）、`.../Sider/SiderNav/index.ts`、`packages/desktop/src/renderer/services/i18n/locales/*/common.json`（13 个 locale，各加 `"modes"` 一行） | 主侧边栏新增 "modes" 入口（Layers 图标，位于"定时任务"项下方），导航到 `/settings/ext/ext-modes-console-modes-console`（modes console 扩展页） | 编排面板需要一等入口，不能永远藏在设置页（扩展机制 v2.2.2 只允许 settings tab 着陆） | 纯新增一个导航项；若上游改了侧边栏结构，把入口项平移到新结构即可，无逻辑耦合 |
