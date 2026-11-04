/**
 * cron.ts —— 零依赖调度时间计算（cron 表达式 / interval / once）
 *
 * 方案 §4：croner 主选，但为免扩展自带 npm 依赖，这里自研等价子集：
 *   - cron：5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周）；支持 * , - /
 *   - interval：每 N 秒
 *   - once：一次性（ISO 时间或 epoch ms），跑完自动停
 *
 * 时区：默认本机（方案允许）。
 */

export type ScheduleSpec =
  | { type: "cron"; expr: string; tz?: string }
  | { type: "interval"; everySec: number; tz?: string }
  | { type: "once"; at: number; tz?: string }; // epoch ms

/** 校验 IANA 时区名（如 Asia/Shanghai）；空值返回 undefined。非法抛错由调用方转 400。 */
export function validateTz(tz?: string): string | undefined {
  if (!tz || !String(tz).trim()) return undefined;
  const v = String(tz).trim();
  new Intl.DateTimeFormat("en-US", { timeZone: v }); // 非法时区这里 throw RangeError
  return v;
}

/**
 * 多调度解析：支持单值（字符串/对象）或数组（每个元素一个调度，如工作日/非工作日不同 cron）。
 * 任一元素无法被 parseSchedule 解析 → 整体返回 null（保存时拒绝，避免静默丢时点）。
 */
export function parseSchedules(raw: unknown): ScheduleSpec[] | null {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) return null;
  const specs: ScheduleSpec[] = [];
  for (const one of list) {
    const v = typeof one === "string" ? one.trim() : one;
    if (!v) return null;
    const spec = parseSchedule(v);
    if (!spec) return null;
    specs.push(spec);
  }
  return specs;
}

/** 解析用户输入的 schedule 字段（宽容：字符串 "5m"/"+30m"/cron 表达式均可）。 */
export function parseSchedule(s: any): ScheduleSpec | null {
  if (!s) return null;
  if (typeof s === "string") {
    // "+30m" / "+2h" = 相对一次；"5m"/"90s" = interval；ISO 时间 = 绝对一次；含空格 = cron
    const rel = /^\+\s*(\d+)\s*([smhd])$/i.exec(s.trim());
    if (rel) {
      const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
      return { type: "once", at: Date.now() + Number(rel[1]) * mult[rel[2].toLowerCase()] * 1000 };
    }
    const iv = /^(\d+)\s*([smhd])?$/i.exec(s.trim());
    if (iv) {
      const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
      const sec = Number(iv[1]) * mult[(iv[2] || "s").toLowerCase()];
      return { type: "interval", everySec: sec };
    }
    // 一次性 ISO 时间（严格形态）：2026-09-10 / 2026-09-10T09:00:00 / …，避免 Date.parse 过于宽松误判
    if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}(:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s.trim())) {
      const at = Date.parse(s.trim());
      if (Number.isFinite(at)) return { type: "once", at };
    }
    if (s.includes(" ")) return { type: "cron", expr: s };
    return null;
  }
  if (typeof s === "object") {
    const tz = validateTz(s.tz || s.timezone);
    if (s.type === "cron" && typeof s.expr === "string") return { type: "cron", expr: s.expr, tz };
    if (s.type === "interval") return { type: "interval", everySec: Math.max(10, Number(s.everySec || s.intervalSec) || 3600), tz };
    if (s.type === "once") {
      const at = typeof s.at === "number" ? s.at : Date.parse(String(s.at));
      if (Number.isFinite(at)) return { type: "once", at, tz };
    }
    // 兜底：{expr:"0 9 * * *"} / {everySec:60}
    if (typeof s.expr === "string") return { type: "cron", expr: s.expr, tz };
    if (s.everySec || s.intervalSec) return parseSchedule(String(s.everySec || s.intervalSec) + "s");
  }
  return null;
}

/** 解析单字段：返回该字段的合法取值集合；null = 不合法。 */
function parseField(field: string, min: number, max: number): Set<number> | null {
  if (field === undefined || field === null || field === "") return null;
  const out = new Set<number>();
  for (const part of String(field).split(",")) {
    let p = part.trim();
    let step = 1;
    const slash = p.indexOf("/");
    if (slash >= 0) {
      step = parseInt(p.slice(slash + 1), 10);
      if (!Number.isFinite(step) || step <= 0) return null;
      p = p.slice(0, slash);
    }
    let lo = min, hi = max;
    if (p !== "*" && p !== "") {
      const dash = p.indexOf("-");
      if (dash >= 0) {
        lo = parseInt(p.slice(0, dash), 10);
        hi = parseInt(p.slice(dash + 1), 10);
      } else {
        lo = hi = parseInt(p, 10);
        // "5/" 形式 = 从 5 起步进
        if (slash >= 0) hi = max;
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) return null;
    } else if (slash < 0) {
      for (let i = min; i <= max; i++) out.add(i);
      continue;
    }
    // 周 7 ≡ 0（周日）：逐值取模映射（修复：此前单值 7 被展开成整周）
    for (let i = lo; i <= hi; i += step) out.add(max === 7 ? i % 7 : i);
  }
  return out.size ? out : null;
}

const DOW_ALIASES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function normalizeDow(expr: string): string {
  return expr.replace(/[a-z]+/gi, (w) => {
    const k = w.toLowerCase().slice(0, 3);
    return k in DOW_ALIASES ? String(DOW_ALIASES[k]) : w;
  });
}

interface CronParts {
  sec: Set<number>; min: Set<number>; hour: Set<number>;
  dom: Set<number>; mon: Set<number>; dow: Set<number>;
}

export function parseCron(expr: string): CronParts | null {
  const normalized = normalizeDow(expr.trim()).replace(/\s+/g, " ");
  const f = normalized.split(" ");
  let sec: Set<number> | undefined;
  let rest = f;
  if (f.length === 6) { sec = parseField(f[0], 0, 59) || undefined; rest = f.slice(1); }
  else if (f.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = rest;
  const min = parseField(minF, 0, 59);
  const hour = parseField(hourF, 0, 23);
  const dom = parseField(domF, 1, 31);
  const mon = parseField(monF, 1, 12);
  const dow = parseField(dowF, 0, 7);
  if (!min || !hour || !dom || !mon || !dow) return null;
  // 5 段表达式无秒字段 → 秒恒为 0（修复：非整分基准下返回「本分钟+已过秒」的偏移）
  return { sec: sec ?? new Set([0]), min, hour, dom, mon, dow };
}

/** 计算 cron 下次触发时间（严格大于 after）。找不到（如 2月30日）返回 null。
 *  utc=true 时按 UTC 分量计算（tz 模式在「epoch+时区偏移」的时间轴上调用本函数）。 */
export function nextCronAfter(parts: CronParts, after: number, utc = false): number | null {
  const d = new Date(after + 1000);
  d.setMilliseconds(0);
  const limit = after + 8 * 366 * 86400 * 1000; // 8 年窗口：覆盖 2/29 等罕见日期
  // getter/setter 按模式选择（本地分量 or UTC 分量）
  const G = {
    month: utc ? (x: Date) => x.getUTCMonth() : (x: Date) => x.getMonth(),
    date: utc ? (x: Date) => x.getUTCDate() : (x: Date) => x.getDate(),
    day: utc ? (x: Date) => x.getUTCDay() : (x: Date) => x.getDay(),
    hour: utc ? (x: Date) => x.getUTCHours() : (x: Date) => x.getHours(),
    min: utc ? (x: Date) => x.getUTCMinutes() : (x: Date) => x.getMinutes(),
    sec: utc ? (x: Date) => x.getUTCSeconds() : (x: Date) => x.getSeconds(),
  };
  const S = {
    month1: utc ? (x: Date, v: number) => x.setUTCMonth(v, 1) : (x: Date, v: number) => x.setMonth(v, 1),
    hours0: utc ? (x: Date) => x.setUTCHours(0, 0, 0, 0) : (x: Date) => x.setHours(0, 0, 0, 0),
    dateAdd: utc ? (x: Date, v: number) => x.setUTCDate(x.getUTCDate() + v) : (x: Date, v: number) => x.setDate(x.getDate() + v),
    hourNext: utc ? (x: Date, v: number) => x.setUTCHours(v + 1, 0, 0, 0) : (x: Date, v: number) => x.setHours(v + 1, 0, 0, 0),
    minNext: utc ? (x: Date, v: number) => x.setUTCMinutes(v + 1, 0, 0) : (x: Date, v: number) => x.setMinutes(v + 1, 0, 0),
    secNext: utc ? (x: Date, v: number) => x.setUTCSeconds(v + 1, 0) : (x: Date, v: number) => x.setSeconds(v + 1, 0),
  };
  while (d.getTime() <= limit) {
    if (!parts.mon.has(G.month(d) + 1)) { S.month1(d, G.month(d) + 1); S.hours0(d); continue; }
    const domOk = parts.dom.has(G.date(d));
    const dowOk = parts.dow.has(G.day(d));
    // dom/dow 均受限时取并集（标准 cron 语义）
    const domRestricted = parts.dom.size < 31;
    const dowRestricted = parts.dow.size < 7;
    const dayOk = domRestricted && dowRestricted ? (domOk || dowOk) : (domRestricted ? domOk : dowRestricted ? dowOk : true);
    if (!dayOk) { S.dateAdd(d, 1); S.hours0(d); continue; }
    if (!parts.hour.has(G.hour(d))) { S.hourNext(d, G.hour(d)); continue; }
    if (!parts.min.has(G.min(d))) { S.minNext(d, G.min(d)); continue; }
    if (!parts.sec.has(G.sec(d))) { S.secNext(d, G.sec(d)); continue; }
    return d.getTime();
  }
  return null;
}

/** 指定 IANA 时区在 at 时刻的偏移毫秒（墙钟 = UTC + offset）。非法时区回退本机。 */
function tzOffsetMs(tz: string | undefined, at: number): number {
  if (!tz) return -new Date(at).getTimezoneOffset() * 60000;
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const p of dtf.formatToParts(new Date(at))) parts[p.type] = p.value;
    const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, (+parts.hour) % 24, +parts.minute, +parts.second);
    return asUTC - Math.floor(at / 1000) * 1000 - ((at % 1000));
  } catch {
    return -new Date().getTimezoneOffset() * 60000;
  }
}

/** 统一入口：给定 spec 与上次水位，算下次执行时间。cron 可带 tz（按该时区墙钟计算）。 */
export function nextRunAt(spec: ScheduleSpec, after: number): number | null {
  if (spec.type === "interval") return after + spec.everySec * 1000;
  if (spec.type === "once") return spec.at > after ? spec.at : null;
  const parts = parseCron(spec.expr);
  if (!parts) return null;
  if (!spec.tz) return nextCronAfter(parts, after);
  // 时区模式：在「墙钟时间轴」上找下一个匹配点，再换算回 epoch；偏移随 DST 变化则迭代收敛
  let off = tzOffsetMs(spec.tz, after);
  for (let i = 0; i < 3; i++) {
    const wall = nextCronAfter(parts, after + off, true); // 偏移轴上按 UTC 分量匹配
    if (wall === null) return null;
    const utc = wall - off;
    const off2 = tzOffsetMs(spec.tz, utc);
    if (off2 === off) return utc;
    off = off2; // DST 边界：用新偏移再算一次
  }
  return null;
}
