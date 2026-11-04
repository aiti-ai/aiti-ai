#!/usr/bin/env node
/**
 * test-cron.mjs —— cron 解析器回归测试（零依赖，node 直跑）
 *
 * 期望值由 croner v10 交叉验证得出（2026-08-25 fuzz，60 组对齐）。
 * 用法：node tools/test-cron.mjs   （非 0 退出 = 有回归）
 */
import { parseSchedule, parseSchedules, nextRunAt } from "../sched/cron.ts";

const BASE = new Date(2026, 7, 25, 10, 38, 30).getTime(); // 周二 10:38:30 本地
// [表达式, 基准偏移ms(可选), 期望 ISO 或 "null"]
const CASES = [
  ["*/5 * * * *", undefined, "2026-08-25T02:40:00.000Z"],          // B1: 秒归整分
  ["59 23 * * 7", undefined, "2026-08-30T15:59:00.000Z"],          // B2: dow=7 仅周日
  ["0 18 * * 1-5", undefined, "2026-08-25T10:00:00.000Z"],         // 当天 18 点
  ["0 12 15-21 * 5", new Date(2026, 2, 27, 12, 0, 30).getTime(), "2026-04-03T04:00:00.000Z"], // dom∪dow
  ["0 0 29 2 *", undefined, "2028-02-28T16:00:00.000Z"],           // B3: 闰日在窗口内
  ["30m", undefined, null], // interval 走独立断言（见下）
];

let fail = 0;
for (const [expr, offset, expected] of CASES) {
  if (expected === null && expr === "30m") continue;
  const spec = parseSchedule(expr);
  const got = nextRunAt(spec, offset != null ? offset : BASE);
  const ok = got != null && new Date(got).toISOString() === expected;
  console.log((ok ? "✓" : "✗") + " " + expr + (offset ? " @" + offset : "") + " → " + (got ? new Date(got).toISOString() : "null") + (ok ? "" : " （期望 " + expected + "）"));
  if (!ok) fail++;
}

// interval / once / 非法输入
const iv = parseSchedule("30m");
const t1 = nextRunAt(iv, BASE);
if (t1 !== BASE + 1800_000) { console.log("✗ interval 30m"); fail++; } else console.log("✓ interval 30m");
// 非法 cron：parseSchedule 只归一形态，实算（nextRunAt）必须返回 null 才算拒绝
const bad = nextRunAt(parseSchedule("99 99 99 99 99"), BASE);
if (bad !== null) { console.log("✗ 非法 cron 应无未来时点"); fail++; } else console.log("✓ 非法 cron 无未来时点");
const once = parseSchedule({ type: "once", at: BASE + 5000 });
if (nextRunAt(once, BASE) !== BASE + 5000 || nextRunAt(once, BASE + 6000) !== null) { console.log("✗ once 语义"); fail++; } else console.log("✓ once 过期即 null");

// timezone 用例
{
  const base = new Date("2026-08-25T02:38:30Z").getTime();
  const tzCases = [
    [{ type: "cron", expr: "0 9 * * *", tz: "UTC" }, "2026-08-25T09:00:00.000Z"],
    [{ type: "cron", expr: "0 0 * * *", tz: "Asia/Shanghai" }, "2026-08-25T16:00:00.000Z"],
    [{ type: "cron", expr: "0 9 * * *", tz: "America/New_York" }, "2026-08-25T13:00:00.000Z"], // EDT=UTC-4
    [{ type: "cron", expr: "0 9 * * *" }, "2026-08-26T01:00:00.000Z"], // 本机 CST=UTC+8
  ];
  for (const [spec, exp] of tzCases) {
    const got = nextRunAt(spec, base);
    const ok = got != null && new Date(got).toISOString() === exp;
    console.log((ok ? "✓" : "✗") + " tz " + JSON.stringify(spec.tz || "(本机)") + " → " + (got ? new Date(got).toISOString() : "null") + (ok ? "" : " （期望 " + exp + "）"));
    if (!ok) fail++;
  }
}

// parseSchedules 多调度（工作日/非工作日不同 cron 等）
{
  const multi = parseSchedules(["0 9 * * 1-5", "0 10 * * 0,6"]);
  if (multi?.length === 2 && multi[0].type === "cron" && multi[1].type === "cron") console.log("✓ parseSchedules 数组 → 2 个 spec");
  else { console.log("✗ parseSchedules 数组"); fail++; }
  const single = parseSchedules("30m");
  if (single?.length === 1 && single[0].type === "interval") console.log("✓ parseSchedules 单值 → 1 个 spec");
  else { console.log("✗ parseSchedules 单值"); fail++; }
  // 任一元素非法 → 整体拒绝（避免静默丢时点）
  if (parseSchedules(["0 9 * * 1-5", "垃圾表达式"]) === null) console.log("✓ parseSchedules 非法元素整体拒绝");
  else { console.log("✗ parseSchedules 非法元素应拒绝"); fail++; }
  if (parseSchedules([]) === null) console.log("✓ parseSchedules 空数组 → null");
  else { console.log("✗ parseSchedules 空数组"); fail++; }
  // 工作日/非工作日的下一个时点确实不同（周二 10:38 基准）：工作日 cron → 周三 8/26，周末 cron → 周六 8/29
  const wk = nextRunAt(multi[0], BASE);
  const we = nextRunAt(multi[1], BASE);
  if (wk != null && we != null && wk < we) console.log("✓ 多调度时点独立计算（工作日 " + new Date(wk).toISOString() + " / 周末 " + new Date(we).toISOString() + "）");
  else { console.log("✗ 多调度时点计算 wk=" + (wk ? new Date(wk).toISOString() : "null") + " we=" + (we ? new Date(we).toISOString() : "null")); fail++; }
}

// ISO 一次性（字符串形态，防对象归一后保存失败）
{
  const iso1 = parseSchedule("2026-09-10T09:00:00");
  const iso2 = parseSchedule("2026-09-10 09:00:00");
  const iso3 = parseSchedule("2026-09-10");
  if (iso1?.type === "once" && iso2?.type === "once" && iso3?.type === "once") console.log("✓ ISO 字符串 → once");
  else { console.log("✗ ISO 字符串解析"); fail++; }
  const t1 = new Date("2026-09-10T09:00:00").getTime();
  if (nextRunAt(iso1, t1 - 1000) === t1) console.log("✓ ISO once 未来时点精确");
  else { console.log("✗ ISO once 时点"); fail++; }
  if (nextRunAt(iso1, t1 + 1000) === null) console.log("✓ ISO once 过期 → null");
  else { console.log("✗ ISO once 过期"); fail++; }
  // cron 不应被 ISO 分支误判
  const c = parseSchedule("0 9 * * *");
  if (c?.type === "cron") console.log("✓ cron 不被 ISO 误判");
  else { console.log("✗ cron 被 ISO 误判"); fail++; }
}

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
