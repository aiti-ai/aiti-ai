---
title: aiti-ai-usage 独立积分（credits）维度
date: 2026-11-26
tags: ["方案/评审中", 方案, aiti-ai-usage, 用量报表, credits, 多agent]
---

# aiti-ai-usage 独立积分（credits）维度

## 1. 背景与现状

Qoder 系外部 agent（`~/.qoder-cn`）的会话 JSONL 逐条 assistant 消息写
`message.usage.credits`（计费积分，非金额），但 AI 用量报表当前完全看不到积分：

| 层 | 现状 |
|---|---|
| 摄入 `lib/ext-session-usage.ts` | 已解析 `credits` 并写入 `ext_usage.credits`（agent=`qodercn`） |
| 视图 `usage_caliber` | 已带 `credits` 列（pi 行恒 0） |
| 汇总 `daily_model` | **无 credits 列** |
| API `server/api.ts` | overview / models / matrix / trend 均未 SELECT credits |
| 前端 `client/src/report.tsx` | 无积分展示 |

结果：qoder 行 token=0、cost=0，在按 token 排序的报表中不可见
（部署库实测：dev `SUM(ext_usage.credits)=36.72`，prod `=1295.44`，
模型 `dfmodel` / `qfmodel` / `auto` 全部 token=0）。

## 2. 目标

- 报表新增**独立 credit 维度**（与 token 并列、不并入金额 cost）。
- 覆盖：总览固定窗口卡片、Top 模型、模型表、维度透视（含 CSV 导出）、趋势页。
- 按 `agent` / `provider` / `model` 筛选均可用；多 agent 积分可分开或合并查看。
- agent 中立：任何来源只要能提供逐轮积分，映射 `ExtUsageRow.credits` 即可，下游零改动。

### 非目标

- 不做账号余额展示（属 provider-usage 的「剩余额度」，是 `get_usage` 快照，不是台账）。
- 不改总览顶部 provider 堆叠图（保持 token 口径）。
- 不做外部 agent 会话在「会话」页的积分聚合（`sessions` 表仅含 pi 会话）。
- 不改 CodeBuddy（`rawUsage.credit` 为账号余额语义）、Codex/OpenCode/Cursor（model-only 无计费数据）。
- ZCode `cost` 字段的积分语义核对列为遗留跟进。

## 3. 方案

### A. 数据层

1. `lib/db.ts`
   - 新建库：`daily_model` 建表加 `credits REAL DEFAULT 0`。
   - 旧库：`PRAGMA table_info(daily_model)` 探测缺列 → `ALTER TABLE ... ADD COLUMN credits REAL DEFAULT 0`
     → 写 `meta.daily_rebuild=1` 触发一次全量重算（沿用既有机制）。
   - `hasAgent=false` 的重建分支同步补 credits 列。
2. `lib/ingest.ts` `flushDaily`
   - 外层聚合与两个 UNION 分支加 `SUM(credits)`（`msg_usage` 分支 `0 AS credits`）。
   - 历史积分已在 `ext_usage`，重算即回填，**无需重扫文件**。
3. `lib/ext-ingest.ts` 不改（已写 credits）。

### B. API（server/api.ts）

4. `overview`：totals / series / topModels / kpiRow↔win 加 credits；
   Top 模型 `ORDER BY tokens DESC, credits DESC`（防零 token 行沉底）。
5. `models`：加 `SUM(credits) credits`，排序同样加 credits 次序。
6. `matrix`（会话口径）：加 `COALESCE(SUM(m.credits),0) AS credits`（代理口径无）。
7. `trend`：`MSG_TREND_EXPRS` 加 `credits`。
8. `sessions` / `keys`：不改。

### C. 前端与 i18n

9. `report.tsx` 新增 `fmtCredits()`：`◈ 12.34`；`0<|v|<1` 显示 3 位小数，其余 2 位 + 千分位；
   `fmtMetric` 增加 credits 分支。
10. 总览固定卡片：cost 行下加 `◈ N 积分`（N>0 才显示）。
11. Top 模型行尾：credits>0 时显示积分。
12. 模型表：tokens 后新增「积分」列（表头 tooltip 说明非金额），空态 colSpan 10→11。
13. 维度透视：`SESSION_METRICS` 加 `credits`（CSV 导出自动多一列）。
14. 趋势：指标列表自动含积分；`fmtMetric` 格式化。
15. 筛选修复：`PivotTab` / `TrendTab` 补传 `filters.agent`；`TrendTab` 的 `dim=agent`
    值选项改取 `facets.agents`。
16. `index.ts` i18n（en / zh-CN）：`au.metric.credits`、`au.credits`、`au.credits.note`。

### D. 测试与交付

17. `ext-ingest.test.mjs`：flushDaily 后断言 `daily_model.credits`。
18. 新增旧库迁移测试：手工建无 credits 的 `daily_model` → `ensure()` 后断言列与 `daily_rebuild`
    → `flushDaily` 后积分回填。
19. 新代码注释用英文；i18n 仅 `en` / `zh-CN`（该扩展只有这两个 locale）。
20. 部署：`node tools/deploy.mjs`（写 `~/.pi/web{,-dev}/extensions/`）→ `POST /api/extensions/reload`；
    该步需单独确认后执行。

## 4. 多 agent 适配矩阵

| 源 | 计费字段 | 结论 |
|---|---|---|
| QoderCN | `message.usage.credits` | 本次直接暴露 |
| Claude Code | 无 credits（claude-like 解析器已通用） | 源将来写 `usage.credits` 自动入库 |
| ZCode | `d.cost`（语义待核） | 遗留跟进：若为额度/积分则映射 |
| CodeBuddy | `rawUsage.credit` = 账号余额 | 不入台账（余额归 provider-usage） |
| Codex / OpenCode / Cursor | model-only | 无计费数据，不适用 |
| pi 原生会话 | SDK usage 无 credits | 若将来提供：`msg_usage` 加列即可，报表层已就绪 |

## 5. 影响面

- 仅 `extensions/aiti-ai-usage`：db / ingest / api / 前端 / i18n / 测试。
- 不动 pi-web 核心与 provider-usage；cost / token 现有数字逻辑不变。
- DB 为增量迁移；`daily_model` 是可重算缓存，迁移后自动重建一次。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 旧库迁移 | PRAGMA 探测 + ALTER；`daily_rebuild` 全量重算走现有分批事务（20 天/让步） |
| 积分被误当金额 | 独立列 + 「积分/credits」标注 + tooltip 说明；cost 不混算 |
| 零 token 行排序沉底 | Top 模型 / 模型表排序补 credits 次序；agent 筛选可单独看 |
| 筛选缺失 | Pivot / Trend 补传 agent（本次修复） |
| 数据新鲜度 | 外部 agent 摄入只在启动/手动 Rescan 触发（无 watch）；报表积分为批级新鲜度，与 provider-usage 的实时余额不同，文档与 tooltip 说明 |
| 迁移耗时 | 全量重建分批 + 让步，一次性成本 |

## 7. 验证计划

1. 单测：`node --test extensions/aiti-ai-usage/ext-ingest.test.mjs extensions/aiti-ai-usage/ingest.test.mjs`。
2. API 对账：`overview/models/matrix/trend?agent=qodercn` 的 credits 之和 == `SUM(ext_usage.credits)`。
3. UI：总览卡片、Top 模型、模型表、透视（agent+qodercn）、趋势（metric=积分、dim=agent）、CSV 列。
4. 迁移演练：旧库副本 → 列出现 + daily 重建 + 积分回填 + 无锁错误。

## 8. 实施记录

- [x] 方案文档落盘
- [x] A 数据层（`lib/db.ts` 建表 + 旧库 ALTER/`daily_rebuild`；`lib/ingest.ts` flushDaily 汇总 credits）
- [x] B API（overview totals/series/topModels/kpi、models、matrix、trend 增加 credits）
- [x] C 前端与 i18n（fmtCredits、总览卡片、Top 模型、模型表列、透视/趋势指标、agent 筛选修复、en/zh-CN 文案）
- [x] D 测试与验证（见下）
- [ ] 部署（待确认）

### 验证结果（本地）

- 单测：`node --experimental-strip-types --test` 全扩展 27 个用例全绿
  （含新增：daily_model credits 聚合断言、旧库迁移 + 重建 + 历史积分回填用例）。
- 客户端构建：vite 构建成功；`_shared/check-client.mjs` 无 TS 残留。
- 旧库迁移演练（dev 库副本）：`daily_model` 补列成功、`daily_rebuild` 标记写入并在 flushDaily 后消费；
  `SUM(ext_usage.credits)=36.72` 与 `SUM(daily_model.credits)=36.72` 一致。
- 旧库迁移演练（prod 库副本）：`1295.44` 一致；按模型拆分
  `dfmodel 1211.85 / auto 46.86 / qfmodel 36.72`。
- API 口径 SQL 对账（dev 副本，agent=qodercn）：overview credits=36.72、models 行、
  trend(dim=agent)=36.72、matrix(dim=provider)=36.72 全部一致。

## 9. 总结

（实施完成后补充：改动清单、验证结果、遗留事项与后续建议。）