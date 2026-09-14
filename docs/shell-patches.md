# shell-patches.md — 受控壳补丁登记册

> 宪法第 3 条例外条款的配套登记：每一个对上游目录的改动都在这里留痕。
> 规则：只加入口/链接，不改上游既有行为逻辑；diff 保持最小；上游 cherry-pick 时逐条核对本表。
> 日期：2026-09-14 起

| # | 日期 | 文件 | 改动 | 理由 | 上游同步注意点 |
|---|------|------|------|------|----------------|
| 1 | 2026-09-14 | `packages/desktop/src/renderer/components/layout/Sider/index.tsx`、`.../Sider/SiderNav/SiderModesEntry.tsx`（新增）、`.../Sider/SiderNav/index.ts`、`packages/desktop/src/renderer/services/i18n/locales/*/common.json`（13 个 locale，各加 `"modes"` 一行） | 主侧边栏新增 "modes" 入口（Layers 图标，位于"定时任务"项下方），导航到 `/settings/ext/ext-modes-console-modes-console`（modes console 扩展页） | 编排面板需要一等入口，不能永远藏在设置页（扩展机制 v2.2.2 只允许 settings tab 着陆） | 纯新增一个导航项；若上游改了侧边栏结构，把入口项平移到新结构即可，无逻辑耦合 |
| 2 | 2026-09-14 | `packages/desktop/src/renderer/pages/modes/ModesPage.tsx`（新增）、`.../components/layout/Router.tsx`（lazy import + 一条 `/modes` 路由）、`.../components/layout/Sider/index.tsx`（补丁 #1 入口的 navigate 目标与 isActive 改为 `/modes`）、`.../services/feedback/resolveFeedbackModule.ts`（ROUTE_MODULE_MAP 加 `['/modes', 'channel']` 一行） | 新增顶级路由 `/modes`：全尺寸 iframe 页面（h-full，摆脱 ExtensionSettingsPage 写死的 `calc(100vh - 200px)`），src 与扩展页相同（`/api/extensions/modes-console/assets/assets/index.html`，经 `resolveExtensionAssetUrl` 解析，sandbox 属性一致），面板逻辑零复制。扩展 settings tab 路由 `/settings/ext/:tabId` 保留作第二入口。feedback 映射与 `/settings/ext` 同桶（channel），否则上游"每个路由都要有 feedback module"测试会红 | 编排面板从"设置页小 iframe"升级为一等产品页面（补丁 #1 的后续） | 纯新增一个页面文件 + 一条路由 + 一条反馈映射；Router 若被上游改动，把 `/modes` 行平移到新路由表即可；Sider 改动只是补丁 #1 那两行的目标字符串，无上游逻辑耦合 |
