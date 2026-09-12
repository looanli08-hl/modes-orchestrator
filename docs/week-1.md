# week-1.md — 第一周任务清单

> 这份文件是什么：立项后第一周（2026-09-12 起）的逐日任务表。
> 什么时候该读：本周每天早上。本周铁律：**不写一行产品代码**——这一周产出的地图、规格书、红色测试，是后面让 AI 大规模写码不翻车的护栏。
> 日期：2026-09-12

---

## Day 1（2026-09-12）— 地基日

- [x] modes 旧仓资产盘点完成，见 `/Users/looanli/Projects/harness/docs/research/modes-inventory.md`（"抢 5 样"清单 + 46–74h 成本估算已入库，见 `docs/research.md` §6）
- [x] fork iOfficeAI/AionUi v2.2.2，分支 `modes/main`，跑通构建
- [x] 创始文档套件入库（本文件 + vision / constitution / research / spec-mvp / AGENTS.md / NOTICE）
- [x] 构建产物验证：`out/AionUi-2.2.2-mac-arm64.dmg` 产出（ad-hoc 签名），应用启动正常；并在打包产物内跑通真实 CLI agent 会话（Kimi Code CLI / K3，ACP 接管）

## Day 2 — 代码库地图 + 竞争复核

**上午：代码库地图补全（AI 做，人审）**

- [x] 让 AI 通读 AionUi fork，产出每目录一行说明，回填根目录 `AGENTS.md` 的代码库地图
- [x] 重点标注：ACP 接管链路、RotatingApiClient、team 模式协作代码、扩展示例——已产出 `docs/seams.md`

**下午：竞争复核（半天，限时）**

- [x] 复核 T3 Code（MIT，~19k 星）的编排层：无 DAG/契约/聚合，结论已写入 research.md §3
- [x] 复核 Paseo 的编排层：编排靠 SKILL.md 提示词非引擎；许可证已更正为 Apache-2.0
- [x] 结论写入 `docs/research.md` §3：空位仍成立

## Day 3–4 — 精读 Orca 编排模块，产出《移植规格书》

- [ ] 精读 `stablyai/orca` 的 `skills/orchestration/`（7 份协议文档）与 `src/cli/handlers/orchestration/`（30+ 处理器）
- [ ] 交叉参考 harness 仓库 `work/moa-recon-2026-08-28.md` 的机制清单（并行扇出 / never-raises 降级 / 全失败跳过合成 / 禁止套娃 / advisory 视图 / guidance 末尾注入 / 按顾问窗口裁剪 / 成本记账）与 hermes `agent/moa_loop.py`（2125 行生产级 MoA）的语义细节
- [ ] 产出《移植规格书》写入 `docs/porting-spec-orca.md`，必须包含三张表：**协议消息类型**（消息、方向、payload schema）、**状态机**（worker/coordinator 各自的状态与迁移条件）、**存储模型**（持久化什么、什么只放内存）
- [ ] 规格书里每个设计决策标注"继承自 Orca/hermes 哪一处"——AI 只做映射，不重新设计（宪法第 6 条）

## Day 5 — 红色验收测试

- [ ] 把 Orca 的 orchestration 契约测试（`orchestration-guide-command-contract.test.mjs` 等）移植/改造为本仓库 `packages/orchestrator/` 的验收测试（宪法第 2 条）
- [ ] 此时没有任何实现，**全部测试必须是红色**——红得具体、红得可读，这就是后面实现的验收标准
- [ ] 测试纳入 `bun run test` 可运行

## 本周里程碑自检（Day 5 结束对照）

- [ ] AGENTS.md 代码库地图已补全
- [ ] T3 Code / Paseo 复核结论已写入 research.md
- [ ] 《移植规格书》存在且三张表齐全
- [ ] 一套红色的契约验收测试在 `bun run test` 里
- [ ] **零行产品实现代码**（多了就是违规）
- [x] 【已关闭】`docs/vision.md` §7 wedge 定义已于 2026-09-12 拍板：交叉验证打头，额度池化 + 国产混编快速跟进；目标用户 = Orca 群体、重心压国产模型
