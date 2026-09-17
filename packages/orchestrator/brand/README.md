# modes 品牌资产

**标识**：放射浪（13 根圆角柱 + 中心圆），明度潮水——纵深用明暗表达（俯瞰海面，峰亮谷暗），不用位移。

- `logo-mark-darkbg.svg` — 深色底用（浅墨 + 青碧 #7cc1af）
- `logo-mark-lightbg.svg` — 浅色底用（深墨 + 深青碧 #3d7a67）
- 静态帧取自 v3 动效的 t=1250ms（上亮下暗、波峰居顶）；动效参数见面板 `panel/index.html` 的 `brandFrame`（5s 亮波 / 11s 调制 / 23s 漂移，永不精确重复；4s 吸 / 6s 呼不对称柔光）
- 重新生成：`bun packages/orchestrator/scripts/brand-generate.ts`

**色**：品牌青碧固定，不随 UI 主题 accent 变。深色底 #7cc1af，浅色底 #3d7a67。

**动效是状态语言**：空状态/陪伴 = 舒缓档（5s 亮波，±12% 柱长）；agent 干活 = 活力档（3.4s，±22%）。两档共用同一形态。

**构造纪律**：24×24 viewBox；柱子不接触中心圆（环形缺口）；中心圆 +4% overshoot；包络为尖峰圆谷（Gerstner 启发，波峰收缩、波谷展宽）。
