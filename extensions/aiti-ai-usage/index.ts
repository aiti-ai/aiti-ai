/**
 * aiti-ai-usage 扩展入口 —— AI token 用量统计（provider / model / key / session 四维）。
 *
 * 数据三路汇入（全事件驱动，零轮询）：
 *   1. 启动/手动 sync：增量扫描活跃会话 JSONL + session-manager .pwarc 归档
 *   2. server.agent.onAgentSession → subscribeEvent("message_end") 实时摄入
 *   3. pi-models-combo v0.2.1+ 的 key 日志：fs.watch tail（含 client→sessionId 归因）
 *
 * 独立 SQLite（node:sqlite）：明细（幂等 PK）+ 日汇总分区重算，月视图查询时上卷。
 */
import { init, runtime } from "./server/runtime.ts";
import { handleApi } from "./server/api.ts";

let initialized = false;

export default {
  id: "aiti-ai-usage",
  name: "AI Usage",
  version: "0.1.0",
  icon: "icon.svg",
  client: "dist/aiti-ai-usage.mjs",

  // AI 自管理清单：AI 能帮用户解读用量报表 / 排查费用异常
  ai: {
    manage: true,
    intro: "AI 能帮我解读 AI 用量统计（token/费用/模型/key 维度）",
    skills: "skills",
  },

  server: {
    api: handleApi,

    async startup(ctx) {
      init(ctx.configDir);
      initialized = true;
    },

    async shutdown() {
      if (initialized) {
        try { runtime().stop(); } catch { /* already closed */ }
        initialized = false;
      }
    },

    agent: {
      onAgentSession(info) {
        const rt = runtime();
        const db = rt.usage.db;
        // 会话上线：占位行（running），内容字段由文件扫描补齐
        db.prepare(`
          INSERT INTO sessions (id, cwd, state, started_at, last_ts)
          VALUES (?, ?, 'running', ?, ?)
          ON CONFLICT(id) DO UPDATE SET state='running', end_reason=NULL,
            cwd=COALESCE(NULLIF(sessions.cwd,''), excluded.cwd)`).run(
          info.sessionId, info.cwd ?? null, Date.now(), Date.now());
        try {
          info.subscribeEvent?.((event: { type: string; message?: any }) => {
            if (event.type === "message_end" && event.message?.role === "assistant") {
              // 动态取当前 runtime：热重载(shutdown→close db→startup→新 db)后，
              // 旧回调若持有闭包里的陈旧 rt 会在已关闭的 db 上报错。每次现取，reload 后自动用新 db。
              let cur;
              try { cur = runtime(); } catch { return; } // runtime 未初始化（shutdown 窗口）→ 跳过该条
              try {
                liveIngest(cur, info.sessionId, event.message);
              } catch (e) {
                console.error("[aiti-ai-usage] live ingest:", e instanceof Error ? e.message : e);
              }
            }
          });
        } catch { /* subscribeEvent 不可用时仅靠启动同步 */ }
      },

      onAgentSessionEnd(info) {
        const rt = runtime();
        const stateByReason: Record<string, string> = {
          shutdown: "ended",
          fork: "forked",
          idle: "idle",
        };
        rt.usage.db.prepare(
          "UPDATE sessions SET state = COALESCE(?, state), end_reason = ? WHERE id = ?")
          .run(stateByReason[info.reason ?? ""] ?? null, info.reason ?? null, info.sessionId);
      },
    },
  },

  ui: {
    // [懒加载 v2] 纯报表面板：开页不拉 client bundle（82KB）——toolbar 静态按钮点击经
    // meta.onClick 物化打开；sessionStats 是交互插槽（打开会话信息时自动物化）。
    clientImmediately: false,
    toolbar: [{ id: "usage", label: "用量", title: "AI 用量报表", icon: "icons/chart-column.svg" }],
    sessionStats: [{ id: "report-entry", label: "用量报表按钮", title: "会话统计下拉内「用量报表」入口" }],
    dialogs: [{ id: "report", label: "AI 用量报表" }],
    i18n: {
      en: {
        "au.title": "AI Usage Report",
        "au.entry": "Usage Report",
        "au.tabOverview": "Overview",
        "au.tabModels": "Models",
        "au.tabKeys": "Keys",
        "au.tabPivot": "Pivot",
        "au.tabTrend": "Trend",
        "au.tabSessions": "Sessions",
        "au.range.today": "Today",
        "au.range.7d": "7 days",
        "au.range.30d": "30 days",
        "au.range.month": "This month",
        "au.range.all": "All",
        "au.range.custom": "Custom",
        "au.range.from": "From date",
        "au.range.to": "To date",
        "au.range.pick": "Pick a start and end date above",
        "au.filter": "Filter",
        "au.filter.allProviders": "All providers",
        "au.filter.allModels": "All models",
        "au.filter.allAgents": "All agents",
        "au.filter.clear": "Clear filters",
        "au.refresh": "Refresh",
        "au.sync": "Rescan",
        "au.close": "Close",
        "au.tokens": "Tokens",
        "au.cost": "Cost",
        "au.msgs": "Messages",
        "au.requests": "Requests",
        "au.rateLimit": "429",
        "au.rateLimitPct": "%429",
        "au.state.running": "Running",
        "au.state.active": "Active",
        "au.state.idle": "Idle",
        "au.state.ended": "Ended",
        "au.state.forked": "Forked",
        "au.state.archived": "Archived",
        "au.empty": "No data yet",
        "au.all": "All",
        "au.trend.byDay": "Daily trend",
        "au.trend.byMonth": "Monthly trend",
        "au.trend.stackNote": "stacked by provider",
        "au.trend.chart": "Chart",
        "au.trend.table": "Table",
        "au.trend.date": "Date",
        "au.trend.month": "Month",
        "au.trend.total": "Total",
        "au.trend.totalNote": "Sum of all providers (incl. beyond top 8)",
        "au.trend.dim": "Dimension",
        "au.trend.valuesHint": "Select values…",
        "au.trend.pickValues": "Pick values to plot (up to 12 lines)",
        "au.trend.selected": "Selected",
        "au.trend.search": "Search…",
        "au.trend.noMatch": "No match",
        "au.trend.selectAll": "Select all",
        "au.trend.clear": "Clear",
        "au.trend.maxValues": "max 12",
        "au.trend.lines": "lines",
        "au.trend.needTwo": "Need at least 2 time buckets to draw a line",
        "au.trend.hide": "Hide this line",
        "au.trend.show": "Show this line",
        "au.trend.invert": "Invert",
        "au.trend.invertTitle": "Invert selection — hide shown, show hidden",
        "au.trend.allHiddenHint": "All hidden — click a legend item to show",
        "au.trend.autoTop": "No values selected — showing top 8 by total",
        "au.pivot.row": "Row",
        "au.pivot.col": "Column",
        "au.pivot.metric": "Metric",
        "au.pivot.none": "None",
        "au.pivot.addDim": "Add dimension",
        "au.pivot.removeDim": "Remove this dimension",
        "au.pivot.view.matrix": "Matrix",
        "au.pivot.view.table": "Table",
        "au.pivot.view.sankey": "Sankey",
        "au.pivot.export": "Export CSV",
        "au.pivot.allMetrics": "All",
        "au.pivot.matrixSingle": "Matrix view shows the first selected metric: ",
        "au.pivot.needTwoDims": "Needs ≥2 dimensions",
        "au.pivot.rows": "rows",
        "au.pivot.rowsTruncated": "Showing first 500 rows only — export CSV for the full result",
        "au.pivot.sort": "click to sort",
        "au.pivot.truncCols": "Many column values — showing top 12 by flow, rest merged into \"Other\"",
        "au.pivot.truncSankey": "Nodes show top 10 by flow per layer, rest merged into \"Other\"",
        "au.pivot.other": "Other",
        "au.pivot.localTime": "local time",
        "au.dim.workspace": "Workspace",
        "au.dim.provider": "Provider",
        "au.dim.model": "Model",
        "au.dim.agent": "Agent",
        "au.dim.key": "Key",
        "au.dim.hour": "Hour of day",
        "au.dim.day": "Day",
        "au.metric.tokens": "Tokens",
        "au.metric.cost": "Cost",
        "au.metric.msgs": "Messages",
        "au.metric.reqs": "Requests",
        "au.metric.err429": "429s",
        "au.metric.ok": "OK",
        "au.metric.input": "Input",
        "au.metric.output": "Output",
        "au.metric.cacheRead": "Cache read",
        "au.caliber.session": "Session scope: exact tokens/cost from session JSONL",
        "au.caliber.proxy": "Proxy scope: only requests via multi-key rotation proxy",
        "au.cnyBilling": "Billed in CNY (USD shown is catalog-converted)",
        "au.tabInput": "Input",
        "au.input.total": "User messages",
        "au.input.quoted": "With quotes",
        "au.input.quoteRate": "Quote rate",
        "au.input.quoteLines": "Quote lines",
        "au.input.byDay": "Messages per day",
        "au.input.kinds": "Quote formats",
        "au.input.workspaces": "Top workspaces",
        "au.input.chars": "Characters",
        "au.input.avgChars": "Avg length",
        "au.input.sessions": "Sessions",
        "au.input.human": "Human",
        "au.input.agent": "Auto sessions",
        "au.input.external": "Imported",
        "au.input.note": "Source: session JSONL role=user messages; fork copies deduped by message id. Quote formats detected from text patterns (Markdown >, nested >>, Discord >>>, BBCode [quote], email attribution, @file mention).",
        "au.input.short": "input",
        "au.input.quotedShort": "quoted",
        "au.quote.gt": "Markdown / email >",
        "au.quote.gtnested": "Nested >>",
        "au.quote.gt3": "Discord >>>",
        "au.quote.bbcode": "BBCode [quote]",
        "au.quote.attrib": "Email attribution",
        "au.quote.fileref": "@file mention",
      },
      "zh-CN": {
        "au.title": "AI 用量报表",
        "au.entry": "用量报表",
        "au.tabOverview": "总览",
        "au.tabModels": "模型",
        "au.tabKeys": "Keys",
        "au.tabPivot": "维度",
        "au.tabTrend": "趋势",
        "au.tabSessions": "会话",
        "au.range.today": "今天",
        "au.range.7d": "近7天",
        "au.range.30d": "近30天",
        "au.range.month": "本月",
        "au.range.all": "全部",
        "au.range.custom": "自定义",
        "au.range.from": "起始日期",
        "au.range.to": "结束日期",
        "au.range.pick": "先在上方选择起止日期",
        "au.filter": "筛选",
        "au.filter.allProviders": "全部 provider",
        "au.filter.allModels": "全部模型",
        "au.filter.allAgents": "全部 agent",
        "au.filter.clear": "清除筛选",
        "au.refresh": "刷新",
        "au.sync": "重新扫描",
        "au.close": "关闭",
        "au.tokens": "Tokens",
        "au.cost": "费用",
        "au.msgs": "消息数",
        "au.requests": "请求数",
        "au.rateLimit": "限流",
        "au.rateLimitPct": "限流%",
        "au.state.running": "运行中",
        "au.state.active": "活跃",
        "au.state.idle": "闲置",
        "au.state.ended": "已结束",
        "au.state.forked": "已分叉",
        "au.state.archived": "已归档",
        "au.empty": "暂无数据",
        "au.all": "全部",
        "au.trend.byDay": "按天趋势",
        "au.trend.byMonth": "按月趋势",
        "au.trend.stackNote": "堆叠 = provider",
        "au.trend.chart": "图",
        "au.trend.table": "表",
        "au.trend.date": "日期",
        "au.trend.month": "月份",
        "au.trend.total": "合计",
        "au.trend.totalNote": "全部 provider 总和（含未进 Top-8 的长尾）",
        "au.trend.dim": "维度",
        "au.trend.valuesHint": "选择值…",
        "au.trend.pickValues": "选择要画线的值（最多 12 条线）",
        "au.trend.selected": "已选",
        "au.trend.search": "搜索…",
        "au.trend.noMatch": "无匹配",
        "au.trend.selectAll": "全选",
        "au.trend.clear": "清除",
        "au.trend.maxValues": "最多 12",
        "au.trend.lines": "条线",
        "au.trend.needTwo": "至少需要 2 个时间点才能画线",
        "au.trend.hide": "隐藏该线",
        "au.trend.show": "显示该线",
        "au.trend.invert": "反选",
        "au.trend.invertTitle": "反选 — 隐藏当前显示的，显示当前隐藏的",
        "au.trend.allHiddenHint": "已全部隐藏 — 点击图例恢复",
        "au.trend.autoTop": "未选值 — 默认显示总量 Top 8",
        "au.pivot.row": "行",
        "au.pivot.col": "列",
        "au.pivot.metric": "指标",
        "au.pivot.none": "无",
        "au.pivot.addDim": "添加维度",
        "au.pivot.removeDim": "移除该维度",
        "au.pivot.view.matrix": "交叉",
        "au.pivot.view.table": "列表",
        "au.pivot.view.sankey": "桑基",
        "au.pivot.export": "导出 CSV",
        "au.pivot.allMetrics": "全选",
        "au.pivot.matrixSingle": "交叉视图显示第一个选中值：",
        "au.pivot.needTwoDims": "需 ≥2 个维度",
        "au.pivot.rows": "行",
        "au.pivot.rowsTruncated": "大结果集仅显示前 500 行，导出 CSV 可查看全部",
        "au.pivot.sort": "点击排序",
        "au.pivot.truncCols": "列值较多，按流量取前 12，其余并入「其他」列",
        "au.pivot.truncSankey": "每层节点按流量取前 10，其余并入「其他」节点",
        "au.pivot.other": "其他",
        "au.pivot.localTime": "本地时区",
        "au.dim.workspace": "工作区",
        "au.dim.provider": "Provider",
        "au.dim.model": "模型",
        "au.dim.agent": "Agent",
        "au.dim.key": "Key",
        "au.dim.hour": "时段 (24h)",
        "au.dim.day": "日期",
        "au.metric.tokens": "Tokens",
        "au.metric.cost": "费用",
        "au.metric.msgs": "消息数",
        "au.metric.reqs": "请求数",
        "au.metric.err429": "限流",
        "au.metric.ok": "成功",
        "au.metric.input": "输入",
        "au.metric.output": "输出",
        "au.metric.cacheRead": "缓存读",
        "au.caliber.session": "会话口径：来自会话 JSONL 的精确 token/费用",
        "au.caliber.proxy": "代理口径：仅经多 key 轮转代理的请求",
        "au.cnyBilling": "该厂商实际按人民币计费（美元价为目录换算值）",
        "au.tabInput": "输入",
        "au.input.total": "用户消息",
        "au.input.quoted": "含引用",
        "au.input.quoteRate": "引用率",
        "au.input.quoteLines": "引用行",
        "au.input.byDay": "每日消息数",
        "au.input.kinds": "引用格式",
        "au.input.workspaces": "Top 工作区",
        "au.input.chars": "字符数",
        "au.input.avgChars": "平均长度",
        "au.input.sessions": "会话数",
        "au.input.human": "人类输入",
        "au.input.agent": "自动会话",
        "au.input.external": "导入会话",
        "au.input.note": "口径：会话 JSONL 中 role=user 的消息，fork 副本按消息 id 去重；引用格式按文本特征识别（Markdown >、嵌套 >>、Discord >>>、BBCode [quote]、邮件回复头、@file 提及）。",
        "au.input.short": "输入",
        "au.input.quotedShort": "引用",
        "au.quote.gt": "Markdown / 邮件 >",
        "au.quote.gtnested": "嵌套 >>",
        "au.quote.gt3": "Discord >>>",
        "au.quote.bbcode": "BBCode [quote]",
        "au.quote.attrib": "邮件回复头",
        "au.quote.fileref": "@文件提及",
      },
    },
  },
};

// ---------------------------------------------------------------- live ingest

import { localDay } from "./lib/db.ts";
import { noteDirtyDay, scheduleFlush } from "./lib/ingest.ts";

function liveIngest(rt: ReturnType<typeof init>, sessionId: string, msg: Record<string, any>): void {
  const u = msg.usage;
  if (!u || !msg.model) return;
  const ts = Number(msg.timestamp) || Date.now();
  const day = localDay(ts);
  rt.usage.db.prepare(`
    INSERT OR IGNORE INTO msg_usage
      (session_id, ts, day, provider, model, input, output, cache_read, cache_write, reasoning, total_tokens, cost_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    sessionId, ts, day, String(msg.provider ?? "?"), String(msg.model),
    u.input | 0, u.output | 0, u.cacheRead | 0, u.cacheWrite | 0, u.reasoning | 0,
    u.totalTokens | 0, u.cost?.total ?? 0);
  noteDirtyDay(day);
  // 刷新该会话聚合
  const a = rt.usage.db.prepare(`
    SELECT COUNT(*) n, COALESCE(SUM(total_tokens),0) t, COALESCE(SUM(cost_total),0) c,
           MIN(ts) firstMsg, MAX(ts) lastMsg FROM msg_usage WHERE session_id = ?`).get(sessionId) as any;
  rt.usage.db.prepare(`
    UPDATE sessions SET msgs=?, total_tokens=?, cost_total=?, last_ts=CASE WHEN ? > last_ts THEN ? ELSE last_ts END
    WHERE id=?`).run(a.n, a.t, a.c, a.lastMsg, a.lastMsg, sessionId);
  scheduleFlush(rt.usage);
}
