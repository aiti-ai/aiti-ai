/**
 * pi-models-combo i18n — 极简字典式多语（零依赖，便于单测）。
 *
 * 覆盖面：代理日志、客户端可见的结构化错误消息、/combo 命令全部输出、
 * 启动/刷新 console 消息。协议层字段（error.type、"quota exceeded" 功能锚点、
 * usage log 字段）不翻译——pi-ai 的 NON_RETRYABLE 匹配与测试锚点依赖它们。
 *
 * 语言选择：优先级 PMC_LANG > PMC_LOCALE > LC_ALL > LC_MESSAGES > LANG
 * （后三者为系统 locale 惯例变量；Windows 原生环境不设这些变量）。
 * 取值归一（去 codeset 后缀 .UTF-8 与 @modifier、小写）后：`zh*` → zh-CN、`en*` → en、
 * 其它不受支持的真实语言 → 国际兑底 en；`C`/`POSIX`/空 = 无语言信息 → 沿链继续。
 * 全链无声明 → ICU 默认 locale 兕底（`Intl.DateTimeFormat().resolvedOptions().locale`，
 * Windows 上即系统区域格式语言；Linux/macOS 亦适用）——zh* → zh-CN，其余 → en；
 * Intl 不可用 → 产品默认 zh-CN。
 * 进程级一次性判定（pi 扩展进程生命周期内不变；测试可用 setLang 覆盖）。
 */

export type Lang = "zh-CN" | "en";

const ZH: Record<string, string> = {
  // ── 时长（fmtDur）──
  "dur.h": "{n}小时",
  "dur.min": "{n}分钟",
  "dur.sec": "{n}s",
  "dur.off": "关闭",
  // ── 冷却/饱和 ──
  "cooldown.cap": "⚠️  \"{k}\" 上游要求冷却 {dur}（大概率配额耗尽，非普通限流）→ 封顶为 {cap}s，到期重新探测",
  "sat.terminal.log": "⛔ \"{k}\" 全部槽位持续限流 {dur} → 返回终态 400 终止客户端重试（避免无限转圈）",
  "sat.terminal.err": "{what}的所有上游成员已持续限流超过 {min} 分钟，已停止自动重试（避免无限等待）。多为免费额度耗尽：可充值上游、切换其他模型，或稍后重发。[quota exceeded: all upstream members unavailable]",
  "sat.what.combo": "组合模型 {model}",
  "sat.what.pool": "模型池 {provider}",
  "all.unavailable": "所有组合成员暂不可用：{detail}",
  "detail.cooling": "(冷却中)",
  "detail.novision": "(无vision)",
  "detail.norole": "(类别不接)",
  "keys.ratelimited": "所有 key 均被限流",
  "keys.allfailed": "代理上游错误：所有 key 均失败",
  "keys.allfailed.exhausted": "代理上游错误：所有 key 均失败（冷却重试耗尽）",
  "keys.allfailed.code": "所有 key 均失败（{code}）",
  "combo.allfailed.code": "所有组合成员均失败（{code}）：{detail}",
  "ocsession.learn": "上游 {host} 要求 x-opencode-session（MissingSessionID）→ 已全局启用注入并重发",
  "upstream.timeout.err": "上游超时",
  "body.timeout.err": "请求体接收超时：客户端 body 未发完",
  // ── 选点/切换 ──
  "rpm.wait": "⏳ \"{k}\" 限流等待 {s}s",
  "rpm.switch": "⏳ \"{k}\" 限流等待 {s}s → 提前换 \"{alt}\"",
  "sticky.slow": "🐢 \"{from}\" 持续慢（TTFB 中位数超阈值）→ 忽略 TTL 换 \"{to}\"",
  "candidates": "健康候选",
  // ── 超时/降权 ──
  "body.timeout.log": "⏱️ 请求体接收超时（客户端 body 未发完）→ 响应 408 并关闭连接",
  "stream.abort": "⏱️ \"{k}\" {why} → 掐断流并冷却该槽位（客户端需重试）",
  "idle.reason": "流空闲 {s}s 无数据",
  "total.reason": "总时长超 {min}min",
  "ttfb.reason": "TTFB 超时（{s}s 无响应头）",
  "timeout.penalize": "⚖️  \"{k}\" {why} → 冷却 {dur} + 权重 ×{f}（该成员下次成功恢复）",
  "penalty.clear": "✓ \"{k}\" 成功 → 超时降权解除，权重恢复",
  "client.gone": "✂️ \"{k}\" 客户端提前断开 → 中止上游请求",
  "pool.deadline.log": "⛔ 池级硬截止 {s}s 到期 → 终止重试链，返回 504",
  "pool.deadline.err": "上游池硬截止 {s}s 到期（成员持续超时），请稍后重试",
  "upstream.timeout.log": "上游超时 ({who})",
  // ── 生命周期 ──
  "port.busy": "端口 {old} 被占用，改用 {new} 重试（{attempt}/{max}）",
  "dup.copy": "[pi-models-combo] 检测到另一副本（engine v{a}，本副本 v{b}）——共用其代理状态",
  "combo.reg.fail": "[pi-models-combo] combo \"{pid}\" 注册 provider 失败: {err}",
  // ── 组合构建/刷新 ──
  "refresh.skip": "[pi-models-combo] refresh \"{pid}\" 模型 \"{model}\" 跳过: {err}",
  "model.skip": "[pi-models-combo] \"{pid}\" 模型 \"{model}\" 跳过: {err}",
  "defer.skip": "[pi-models-combo] 延迟建 combo \"{pid}\" 模型 \"{model}\" 跳过: {err}",
  "defer.missing": "[pi-models-combo] combo \"{pid}\" 成员仍缺（{n} 个错误），保持延迟态——检查 freeflow 等上游 provider 是否注册",
  "defer.fail": "[pi-models-combo] 延迟建 combo 代理失败 \"{pid}\": {err}",
  "no.baseurl": "[pi-models-combo] \"{pid}\": 配了多 key 但无 baseUrl",
  "no.baseurl.refresh": "[pi-models-combo] refresh \"{pid}\": 配了多 key 但无 baseUrl",
  "slots.external": "外部刷新: 槽位 {n} 个{removed}",
  "slots.update": "原地更新槽位: 移除 [{list}] · 新 {n} 个",
  "slots.removed": " · 移除 [{list}]",
  "key.empty": "[pi-models-combo] \"{pid}\": 空 key 已忽略",
  "key.dup": "[pi-models-combo] \"{pid}\": 重复 key 名 \"{name}\" → 自动改名 {new}",
  "key.badRpm": "[pi-models-combo] \"{pid}\" key \"{name}\": 非法 rpm \"{v}\" → 忽略（不限速）",
  "key.badMiv": "[pi-models-combo] \"{pid}\" key \"{name}\": 非法 minIntervalMs \"{v}\" → 按默认 auto（{auto}）",
  "combo.unknown": "未知组合模型 \"{model}\"。可用组合：{known}",
  "combo.nobody": "（请求体无 model 字段或非 JSON）",
  "combo.none.known": "（无）",
  "combo.none.id": "(无 id)",
  "combo.dupRef": "[pi-models-combo] 组合 \"{id}\": 成员重复引用 {ref} 已忽略",
  "combo.badWeight": "[pi-models-combo] 组合 \"{id}\" 成员 {member}: 非法权重 \"{v}\"（需 1~1e9）→ 用默认 {d}",
  "combo.badTypes": "[pi-models-combo] 组合 \"{id}\" 成员 {member}: 非法 types 值 {v} 已忽略（合法: text/vision/other）",
  "combo.visionNoCap": "[pi-models-combo] 组合 \"{id}\" 成员 {member}: types 含 vision 但模型 input 未声明 image——带图请求仍会被能力过滤排除（该声明不会生效）",
  "types.text": "文本",
  "types.vision": "图形",
  "types.other": "其他媒体",
  // ── /combo 命令 ──
  "cmd.combo.desc": "查看组合（combo）代理状态：/combo list|status [provider]|refresh（无参数弹选择菜单）",
  "run.built": "· ✅已构建 端口 {port}",
  "run.cooling": " · ⏳{n} 冷却中",
  "run.unbuilt": "· ⏸未构建（首次请求时自动建）",
  "sticky.ttl": " · 粘性TTL {n}min",
  "weight": "权重:{w}",
  "combo.none.list": "[pi-models-combo] models.json 里没有配置组合（combo）模型（provider 级 \"combo\": true + 模型级 combo.members）。",
  "combo.none.status": "[pi-models-combo] models.json 里没有配置组合（combo）模型（provider 级 \"combo\": true）。",
  "stat.429": "429:{n}次/{p}%",
  "stat.timeout": "超时:{n}",
  "stat.token": "token {tin}入/{tout}出",
  "stat.lastStatus": "末次:{v}",
  "stat.lastUse": "末用:{v}",
  "stat.pinned": "📌粘性×{n}",
  "status.line": "▸ {provider}  ·  端口 {port}  ·  {slots} 槽位  ·  粘性:{sticky}  ·  ⏳{cooling} 冷却",
  "status.line.sat": "  ·  🔥饱和:{list}",
  "status.pick.title": "/combo 检测到多个组合 — 选择要查看的 provider：",
  "status.opt.built": "端口 {port} · {slots} 槽位 · ⏳{cooling} 冷却",
  "status.unknown.provider": "[pi-models-combo] 未知组合 provider \"{v}\"。已配置：{list}",
  "sticky.on": "开",
  "sticky.off": "关",
  "action.list": "list — 列出所有组合代理及成员/上游/冷却",
  "action.status": "status — 详细运行状态（粘性/req/429/token 输入输出/饱和；多组合时可选 provider）",
  "action.refresh": "refresh — 重建所有组合代理",
  "refreshed": "[pi-models-combo] 已刷新 {n} 个组合代理",
  "bad.sub": "[pi-models-combo] /combo 子命令：list | status | refresh",
  "pick.title": "/combo 选择操作：",
  "cancelled": "已取消",
  "bad.choice": "[pi-models-combo] 未知的选项：{v}",
  "help.text": "🎯 /combo 子命令（直接回车或输入 help 显示此帮助）：\n  1. /combo list      — 列出所有组合代理及成员/上游/冷却\n  2. /combo status    — 显示详细状态（多组合时弹 provider 选择器）\n     /combo status <provider> — 直接显示指定组合 provider\n  3. /combo refresh   — 重建所有组合代理",
};

const EN: Record<string, string> = {
  "dur.h": "{n}h",
  "dur.min": "{n}min",
  "dur.sec": "{n}s",
  "dur.off": "off",
  "cooldown.cap": "⚠️  \"{k}\" upstream asked to cool down for {dur} (likely quota exhausted, not plain rate-limit) → capped to {cap}s, will re-probe on expiry",
  "sat.terminal.log": "⛔ \"{k}\" all slots rate-limited for {dur} → returning terminal 400 to stop client retries (avoid infinite loop)",
  "sat.terminal.err": "All upstream members of {what} have been rate-limited for over {min} minutes; auto-retry stopped to avoid endless waiting. Usually free-quota exhaustion: top up, switch models, or retry later. [quota exceeded: all upstream members unavailable]",
  "sat.what.combo": "combo model {model}",
  "sat.what.pool": "model pool {provider}",
  "all.unavailable": "all combo members unavailable: {detail}",
  "detail.cooling": "(cooling)",
  "detail.novision": "(no vision)",
  "detail.norole": "(class not accepted)",
  "keys.ratelimited": "All keys rate-limited",
  "keys.allfailed": "proxy upstream error: all keys failed",
  "keys.allfailed.exhausted": "proxy upstream error: all keys failed (cooldown retry exhausted)",
  "keys.allfailed.code": "all keys failed ({code})",
  "combo.allfailed.code": "all combo members failed ({code}): {detail}",
  "ocsession.learn": "upstream {host} requires x-opencode-session (MissingSessionID) → injection enabled globally and request resent",
  "upstream.timeout.err": "upstream timeout",
  "body.timeout.err": "request body timeout: client did not finish sending body",
  "rpm.wait": "⏳ \"{k}\" rate-limit wait {s}s",
  "rpm.switch": "⏳ \"{k}\" rate-limit wait {s}s → switching early to \"{alt}\"",
  "sticky.slow": "🐢 \"{from}\" persistently slow (median TTFB over threshold) → ignoring TTL, switching to \"{to}\"",
  "candidates": "healthy candidates",
  "body.timeout.log": "⏱️ request body timeout (client never finished sending) → responding 408 and closing",
  "stream.abort": "⏱️ \"{k}\" {why} → aborting stream and cooling the slot (client will retry)",
  "idle.reason": "stream idle for {s}s with no data",
  "total.reason": "total time over {min}min",
  "ttfb.reason": "TTFB timeout ({s}s without response headers)",
  "timeout.penalize": "⚖️  \"{k}\" {why} → cooldown {dur} + weight ×{f} (restores on this member's next success)",
  "penalty.clear": "✓ \"{k}\" success → timeout weight penalty lifted",
  "client.gone": "✂️ \"{k}\" client disconnected early → aborting upstream request",
  "pool.deadline.log": "⛔ pool deadline {s}s reached → cutting retry chain, responding 504",
  "pool.deadline.err": "upstream pool deadline exceeded after {s}s (members kept timing out); please retry",
  "upstream.timeout.log": "upstream timeout ({who})",
  "port.busy": "port {old} in use, retrying on {new} ({attempt}/{max})",
  "dup.copy": "[pi-models-combo] another module copy detected (engine v{a}, this copy v{b}) — sharing its proxy state",
  "combo.reg.fail": "[pi-models-combo] combo \"{pid}\" provider registration failed: {err}",
  "refresh.skip": "[pi-models-combo] refresh \"{pid}\" model \"{model}\" skipped: {err}",
  "model.skip": "[pi-models-combo] \"{pid}\" model \"{model}\" skipped: {err}",
  "defer.skip": "[pi-models-combo] deferred combo \"{pid}\" model \"{model}\" skipped: {err}",
  "defer.missing": "[pi-models-combo] combo \"{pid}\" members still missing ({n} errors), staying deferred — check whether upstream providers like freeflow are registered",
  "defer.fail": "[pi-models-combo] deferred combo proxy failed \"{pid}\": {err}",
  "no.baseurl": "[pi-models-combo] \"{pid}\": multiple keys configured but no baseUrl",
  "no.baseurl.refresh": "[pi-models-combo] refresh \"{pid}\": multiple keys configured but no baseUrl",
  "slots.external": "external refresh: {n} slots{removed}",
  "slots.update": "in-place slot update: removed [{list}] · now {n}",
  "slots.removed": " · removed [{list}]",
  "key.empty": "[pi-models-combo] \"{pid}\": empty key ignored",
  "key.dup": "[pi-models-combo] \"{pid}\": duplicate key name \"{name}\" → renamed to {new}",
  "key.badRpm": "[pi-models-combo] \"{pid}\" key \"{name}\": invalid rpm \"{v}\" → ignored (no rate limit)",
  "key.badMiv": "[pi-models-combo] \"{pid}\" key \"{name}\": invalid minIntervalMs \"{v}\" → default auto ({auto})",
  "combo.unknown": "unknown combo model \"{model}\". Known combos: {known}",
  "combo.nobody": "(request body has no model field or is not JSON)",
  "combo.none.known": "(none)",
  "combo.none.id": "(no id)",
  "combo.dupRef": "[pi-models-combo] combo \"{id}\": duplicate member reference {ref} ignored",
  "combo.badWeight": "[pi-models-combo] combo \"{id}\" member {member}: invalid weight \"{v}\" (1..1e9) → using default {d}",
  "combo.badTypes": "[pi-models-combo] combo \"{id}\" member {member}: invalid types value(s) {v} ignored (valid: text/vision/other)",
  "combo.visionNoCap": "[pi-models-combo] combo \"{id}\" member {member}: types includes vision but the model's input does not declare image — image requests will still be filtered out by capability check (this declaration will never take effect)",
  "types.text": "text",
  "types.vision": "vision",
  "types.other": "other media",
  "cmd.combo.desc": "Inspect combo proxy state: /combo list|status [provider]|refresh (no args opens a picker)",
  "run.built": "· ✅built, port {port}",
  "run.cooling": " · ⏳{n} cooling",
  "run.unbuilt": "· ⏸not built yet (auto-builds on first request)",
  "sticky.ttl": " · sticky TTL {n}min",
  "weight": "weight:{w}",
  "combo.none.list": "[pi-models-combo] no combo models configured in models.json (provider-level \"combo\": true + model-level combo.members).",
  "combo.none.status": "[pi-models-combo] no combo models configured in models.json (provider-level \"combo\": true).",
  "stat.429": "429:{n}/{p}%",
  "stat.timeout": "timeout:{n}",
  "stat.token": "token in {tin}/out {tout}",
  "stat.lastStatus": "last:{v}",
  "stat.lastUse": "lastUse:{v}",
  "stat.pinned": "📌sticky×{n}",
  "status.line": "▸ {provider}  ·  port {port}  ·  {slots} slots  ·  sticky:{sticky}  ·  ⏳{cooling} cooling",
  "status.line.sat": "  ·  🔥saturated:{list}",
  "status.pick.title": "/combo found multiple combos — pick a provider:",
  "status.opt.built": "port {port} · {slots} slots · ⏳{cooling} cooling",
  "status.unknown.provider": "[pi-models-combo] unknown combo provider \"{v}\". Configured: {list}",
  "sticky.on": "on",
  "sticky.off": "off",
  "action.list": "list — list all combo proxies with members/upstreams/cooldowns",
  "action.status": "status — detailed runtime state (sticky/req/429/tokens/saturation; pick a provider when multiple)",
  "action.refresh": "refresh — rebuild all combo proxies",
  "refreshed": "[pi-models-combo] refreshed {n} combo proxies",
  "bad.sub": "[pi-models-combo] /combo subcommands: list | status | refresh",
  "pick.title": "/combo pick an action:",
  "cancelled": "Cancelled",
  "bad.choice": "[pi-models-combo] unknown choice: {v}",
  "help.text": "🎯 /combo subcommands (press Enter or type help to see this):\n  1. /combo list      — list all combo proxies with members/upstreams/cooldowns\n  2. /combo status    — detailed state (provider picker when multiple combos)\n     /combo status <provider> — show one combo provider directly\n  3. /combo refresh   — rebuild all combo proxies",
};

const DICTS: Record<Lang, Record<string, string>> = { "zh-CN": ZH, en: EN };

/**
 * 语言检测（进程内一次性）：
 * ① PMC_LANG（显式覆盖）> PMC_LOCALE > LC_ALL > LC_MESSAGES > LANG——
 *    zh*→zh-CN、en*→en、其它真实语言→en（国际兑底）、C/POSIX/空→沿链继续；
 * ② 全链无声明 → ICU 默认 locale 兕底（Windows 原生环境无 LANG/LC_*，
 *    靠 Intl 反映的系统区域设置识别语言）：zh*→zh-CN，其余→en；
 * ③ Intl 不可用/异常 → zh-CN（产品默认）。
 */
function detectLang(): Lang {
  for (const k of ["PMC_LANG", "PMC_LOCALE", "LC_ALL", "LC_MESSAGES", "LANG"]) {
    const raw = String(process.env[k] || "").trim();
    if (!raw) continue;
    const norm = normLocaleTag(raw);
    if (!norm || norm === "c" || norm === "posix") continue; // 无语言信息 → 沿链继续
    if (norm.startsWith("zh")) return "zh-CN";
    if (norm.startsWith("en")) return "en";
    return "en"; // 声明了不受支持的语言 → 国际兑底
  }
  try {
    const icu = normLocaleTag(String((Intl as any).DateTimeFormat().resolvedOptions().locale || ""));
    if (icu) return icu.startsWith("zh") ? "zh-CN" : "en";
  } catch { /* 极端运行时无 Intl → 走默认 */ }
  return "zh-CN";
}

/** locale 标签归一：去 @modifier、去 codeset 后缀（.utf-8）、小写。 */
function normLocaleTag(v: string): string {
  return v.trim().toLowerCase().split(".")[0].split("@")[0].trim();
}

let lang: Lang = detectLang();

/** 当前语言（测试/状态面板用）。 */
export function getLang(): Lang { return lang; }

/** 强制切换语言（仅测试/特殊宿主用；正常运行由 env 决定）。 */
export function setLang(l: Lang): void { lang = l; }

/**
 * 取文案并做 {name} 插值。key 缺失时回退 zh-CN，再缺失返回 key 本身（开发期可见）。
 * 模板里字面量花括号不受支持——文案模板不得出现裸 `{`。
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = DICTS[lang][key] ?? ZH[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}
