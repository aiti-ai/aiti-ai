/**
 * aiti-cpu-meter v0.3.1 —— 主线程流畅度检测器（双产物：内部版 + 外部版 standalone）+ AI 卡顿调试
 *
 * v0.3.1：修外部版「问 AI」GET 兑底在 URL 超长时静默丢 report（服务端只收到 "{}"）——
 *   改为按预算逐级瘦身（L1 全证据砍 UA → L2 少量证据 → L3 纯指标），核心分数永不丢。
 * v0.3：适配 aiti-helper（skills/jank-debug「调试页面卡顿」帮助点）+ report() 现场报告 API
 * （long-animation-frame 脚本归因）+ 内部版面板「问 AI」（✨ sparkles，经 aiti-helper，懒物化兼容）+ 外部版「问 AI」
 * 弹窗（POST /ask-ai → 服务端两段式建 session：ensure_session + 非阻塞 prompt → 跳转 pi-web 会话页）。
 *
 * 从「pi-web 页面内读秒器」升级为「可注册/注入到其他网站的独立检测器」：
 *   - 内部版 client：本实例页面显示（features 控制：enabled/pos/score/minimize/askAi + 跨实例注入）
 *   - 外部版 standalone：assets/aiti-cpu-meter.js（IIFE 单文件）——任意网站 <script> 加载即用，
 *     供 service-tunnels 注入注册点 / bookmarklet / 跨实例注入复用
 *
 * 服务端职责：
 *   - 静态服务 assets/aiti-cpu-meter.js（外部版，no-store）+ meter-version（内容哈希，浏览器侧注入前取）
 *   - ask-ai（POST 为主/GET 兑底）：外部版「问 AI」收集现场 → 两段式建「调试页面卡顿」AI
 *     会话（ensure_session + 非阻塞 prompt，手册指针内联注入）→ 返回 { sessionId, url } 供跳转
 *   - server.startup 注册 __stInjectRegistry 注入源（service-tunnels 公开配置里勾选「CPU 流畅度检测器」
 *     → 代理/公开的页面 HTML 自动注入外部版）。软依赖：service-tunnels 未装 → 跳过并 warn，不影响内部版。
 *
 * 部署：node tools/deploy.mjs（build → dist/ → 扩展目录 client/ + assets/ + skills/）
 */
import { readFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

export default {
  id: "aiti-cpu-meter",
  name: "主线程流畅度检测器（读秒 + 0-100 分 + 可注入任意站点）",
  version: "0.3.1",
  icon: "icon.svg",
  client: "dist/aiti-cpu-meter-client.mjs",

  // AI 自管理（aiti-helper 帮助点）：skills/jank-debug「调试页面卡顿」——
  // 内部版面板 ✨ / 外部版「问 AI」最终都汇聚到该帮助点建 AI 会话
  ai: {
    manage: true,
    intro: "AI 能帮我分析 aiti-cpu-meter 检测器的流畅度现场数据（读秒/长任务/LoAF 脚本归因/卡顿快照），定位页面卡顿根因并给可执行修复建议",
    skills: "skills",
  },

  // 公开 API 声明：前两个 GET 端点会被 service-tunnels 注入到任意页面（跨源 <script>/fetch；
  // same-site 子资源请求携带登录 cookie，nginx/Authelia 正常拦截未登录），pi-web route 按此声明
  // 豁免 request-security 的 cross-site 门禁（否则 403 JSON → ORB 拦截）。
  // ask-ai 不再豁免（2026-09-08 安全收紧）：跨源 fetch 的 preflight 永远无 cookie，曾在 nginx 加免
  //   认证 location 放行——等于公网未登录可用 AI 建会话，已回滚。改为 gate 流程：standalone 先
  //   window.open gate.html（顶级导航带 Authelia cookie，未登录先登录后回跳），gate 同源 POST
  //   ask-ai（带会话）→ 认证链路闭合，ask-ai 仅登录用户可用。gate.html 本身过 Authelia 后由
  //   route.ts 静态资产正则（.html）放行，无需 publicApi。
  publicApi: ["aiti-cpu-meter.js", "meter-version"],

  features: [
    {
      id: "enabled",
      type: "boolean",
      label: "启用检测器",
      group: "主线程诊断",
      description: "在本实例页面显示 CPU 流畅度检测器（rAF 读秒 + 0-100 流畅度分 + 颜色分层 + 最小化）。主线程卡死时读秒冻结、分数暴跌。",
      default: true,
    },
    {
      id: "pos",
      type: "string",
      label: "位置",
      group: "主线程诊断",
      description: "默认位置：left-bottom（默认）/ left-top / right-bottom / right-top。可拖动后以拖动位置为准（持久化）。",
      placeholder: "left-bottom",
    },
    {
      id: "score",
      type: "boolean",
      label: "流畅度评分",
      group: "主线程诊断",
      description: "显示 0-100 流畅度评分（Apdex 锚定 + 颜色分层）+ 会话统计（平均/运行时长/最低）。关 = 纯读秒。",
      default: true,
    },
    {
      id: "minimize",
      type: "boolean",
      label: "支持最小化",
      group: "主线程诊断",
      description: "面板可最小化成小图标（色点+实时分数），拖到不碍事处长期挂着，点开看会话平均流畅度。关 = 只有展开态 + ✕。",
      default: true,
    },
    {
      id: "askAi",
      type: "boolean",
      label: "面板「问 AI」按钮",
      group: "AI 调试",
      description: "面板标题栏显示 AI 图标（✨ sparkles，与 aiti-helper 同图形）：把现场报告（流畅度分/长任务/LoAF 脚本归因/卡顿快照）交给 aiti-helper 建「调试页面卡顿」AI 会话（外部版则创建会话后跳转 pi-web）。默认开。",
      default: true,
    },
    {
      id: "inject.enabled",
      type: "boolean",
      label: "跨实例注入",
      group: "站点评估",
      description: "把「服务地址」目标实例的 CPU 检测器注入当前页面（评估当前页面，参照 aiti-debug-inject）。默认关闭。",
      default: false,
    },
    {
      id: "service.url",
      type: "string",
      label: "服务地址",
      group: "站点评估",
      description: "目标 pi-web 基址（含子路径，如 https://host:port/dev）。配好后打开「跨实例注入」。",
      placeholder: "https://host:port",
    },
  ],

  server: {
    async startup(ctx) {
      let disposeInject;
      try {
        // 软依赖：service-tunnels 注入注册点（未装 → 动态导入失败 → 跳过）
        const { getInjectRegistry } = await import("../service-tunnels/server/inject-registry.ts");
        disposeInject = getInjectRegistry().register("aiti-cpu-meter", {
          label: "CPU 流畅度检测器",
          description: "向代理/公开的页面注入主线程流畅度检测器（0-100 分 + 颜色分层 + 长任务/卡顿统计 + 最小化）。",
          scriptFor(port, url, method) {
            void port;
            const m = String(method || "GET").toUpperCase();
            if (m !== "GET" && m !== "HEAD") return null;
            // 按页面地址自动选脚本 host：vhost 子域 → 父域（pi-web）；自暴露域名 → 同 host；其余 → BASE 兜底
            return { html: injectScriptTag(ctx, url), position: "prepend" };
          },
        });
        console.log("[aiti-cpu-meter] 已注册 service-tunnels 注入源（id=aiti-cpu-meter）");
      } catch (e) {
        console.warn("[aiti-cpu-meter] service-tunnels 注入注册跳过（未安装？），不影响内部版/standalone：", String(e).slice(0, 200));
      }
      // 跨 reload 保留 dispose（globalThis 单例语义同 aiti-devtools）
      try { (globalThis as Record<string, unknown>).__aitiCpuMeterInjectDispose = disposeInject; } catch {}
      console.log(`[aiti-cpu-meter] 就绪：外部版 assets/aiti-cpu-meter.js + meter-version + 注入注册（configDir ${ctx?.configDir ?? "?"}）`);
    },
    async shutdown() {
      try {
        const d = (globalThis as Record<string, unknown>).__aitiCpuMeterInjectDispose;
        if (typeof d === "function") { d(); (globalThis as Record<string, unknown>).__aitiCpuMeterInjectDispose = null; }
      } catch {}
    },

    // /api/extensions/aiti-cpu-meter/<path>
    async api(req, ctx) {
      const p = ctx.path || [];
      // 外部版 standalone（service-tunnels 注入 / bookmarklet / 跨实例注入的目标脚本）
      if (p.length === 1 && p[0] === "aiti-cpu-meter.js") {
        return serveAsset(ctx, "aiti-cpu-meter.js");
      }
      // gate 页面（外部版「问 AI」认证入口）：standalone window.open 打开（顶级导航带登录会话），
      // 页面同源 POST ask-ai 后跳转会话页——ask-ai 本体不再免认证（见上方 publicApi 注释）
      if (p.length === 1 && p[0] === "gate.html") {
        return serveAsset(ctx, "gate.html");
      }
      // 内容哈希版本号：文件改动 → hash 变 → src?v=<hash> 变 → 浏览器强制拉新
      if (p.length === 1 && p[0] === "meter-version") {
        return new Response(JSON.stringify({ ok: true, asset: "aiti-cpu-meter.js", hash: meterHash(ctx) }), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      // 外部版「问 AI」：gate.html 同源 POST 转发（认证由登录会话承担）→ 两段式建「调试页面卡顿」
      // AI 会话 → 返回 { sessionId, url }。仅 POST（原跨源 GET 兑底已随免认证 location 回滚移除）。
      if (p.length === 1 && p[0] === "ask-ai" && req.method === "POST") {
        return askAi(req, ctx);
      }
      return new Response("not found: " + p.join("/"), { status: 404 });
    },

    // 注入执行归 service-tunnels（proxy 分支）；此处不接管
    async middleware() {
      return { handled: false };
    },
  },
};

// ── ask-ai：外部版「问 AI」建会话（直连 agent 接口两段式；手册文件内联注入，效果同帮助点手册）──
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const jsonResp = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

async function askAi(req: Request, ctx: { searchParams: URLSearchParams }) {
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    body = await req.json().catch(() => ({}));
  } else {
    for (const [k, v] of (ctx.searchParams || new URL(req.url).searchParams)) body[k] = v;
  }
  const prompt = String(body.prompt ?? "").trim().slice(0, 4000);
  if (!prompt) return jsonResp({ ok: false, error: "需要 prompt（卡顿现象描述）" }, 400);

  // 幂等/合并（按 ts + prompt 指纹）：建会话含 pi spawn 较慢，可能超过 nginx 60s 网关超时
  // （实测 POST 504）→ 客户端降级 GET 重试。同一 ts 只建一个会话：
  //   进行中 → 合并等待（POST 服务器侧仍在跑，GET 复用同一 promise，避免双会话）；
  //   已完成 → 缓存立返（POST 实际已建成但网关已断开的场景，GET 立即拿到 sessionId/url）。
  const key = String(body.ts ?? "") + "|" + prompt.slice(0, 64);
  const now0 = Date.now();
  for (const [k, v] of askRuns) if (now0 - v.at > ASK_RUN_TTL) askRuns.delete(k);
  let entry = askRuns.get(key);
  if (!entry) {
    entry = { at: now0, run: askCreate(req, ctx, body, prompt) };
    askRuns.set(key, entry);
    void entry.run.catch(() => {}); // 无人 await 时吞 reject
  }
  const r = await entry.run;
  // 失败不缓存：同 ts 重试可重新建会话（成功才保留，防 POST 超时后 GET 重试重复建）
  if (r.status >= 500) askRuns.delete(key);
  return jsonResp(r.body, r.status);
}
// ts|prompt 指纹 → 进行中/已完成请求（模块级单例；热重载重置可接受，重试窗仅几十秒）
const askRuns = new Map<string, { at: number; run: Promise<{ status: number; body: unknown }> }>();
const ASK_RUN_TTL = 10 * 60 * 1000;

async function askCreate(req: Request, ctx: { searchParams: URLSearchParams; dir: string; cacheDir?: string }, body: Record<string, unknown>, prompt: string): Promise<{ status: number; body: unknown }> {
  const reportStr = String(body.report ?? "{}").slice(0, 16000);
  const pageUrl = String(body.url ?? "").slice(0, 500);
  const pageTitle = String(body.title ?? "").slice(0, 200);
  const message = [
    "[任务] 你是页面卡顿调试助手（aiti-cpu-meter 外部版发起）。请先用 read 工具完整阅读手册文件，严格按其中的任务、指标解读、案例库与输出格式执行：",
    "手册文件: " + join(ctx.dir, "skills", "jank-debug", "SKILL.md"),
    "",
    "[发起上下文]",
    "来源: aiti-cpu-meter 检测器「问 AI」（外部版注入页，页面未连桥——报告已随消息附带，不要尝试 page_exec 该页）",
    pageUrl ? "目标页面: " + pageUrl : "",
    pageTitle ? "页面标题: " + pageTitle : "",
    "发起时间: " + new Date().toISOString(),
    "",
    "[用户描述]",
    prompt,
    "",
    "[cpu-meter 现场报告 JSON]",
    "```json",
    reportStr,
    "```",
  ].filter(Boolean).join("\n");

  // cwd（外部版）：HOME/aiti-helper（不直接落 HOME——HOME 下文件面太大，AI 扫描/写入会波及全 HOME；
  //   目录不存在则新建；env 可覆盖。内部版不走此端点——经 aiti-helper 自动带当前会话 cwd。
  let cwd = process.env.AITI_CPU_METER_CWD || join(homedir(), "aiti-helper");
  try { if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true }); } catch { /* keep */ }
  try { if (!existsSync(cwd)) cwd = join(ctx.cacheDir || process.cwd(), "sessions-cwd"); } catch { /* keep */ }

  // basePath：客户端显式 base > scriptUrl 前缀 > referer > req 路径 > PI_WEB_BASE_PATH env。
  //   ⚠ Next 路由内 req.url 已剥 basePath（构建期 basePath）；跨源请求 referer 只带 origin（默认
  //   strict-origin-when-cross-origin）——两者都拿不到子路径，必须由客户端（知道自己脚本 URL）提供。
  //   ⚠ body.base / scriptUrl 任一存在即已定论（可能为空串 = 根部署），不得再落 referer——
  //   gate 页面的 referer 是 /api/extensions/... 会被误匹配成 basePath="/api" → 自请求 /api/api/agent/new 404
  //   （2026-09-08 gate 流程实测）。
  const pathOf = (u: string) => { try { return new URL(u).pathname.replace(/\/+$/, ""); } catch { return ""; } };
  const bodyBase = String(body.base ?? "").trim();
  const scriptBase = baseFromScriptUrl(String(body.scriptUrl ?? ""));
  let basePath = bodyBase ? pathOf(bodyBase) : "";
  if (!bodyBase && scriptBase) basePath = pathOf(scriptBase);
  if (!bodyBase && !scriptBase) {
    try {
      const refPath = new URL(req.headers.get("referer") || "").pathname;
      const m = refPath.match(/^(\/[^/]+)(?:\/api\/|\/|$)/);
      if (m) basePath = m[1] || "";
    } catch { /* ignore */ }
  }
  if (!basePath) {
    const m = new URL(req.url, "http://127.0.0.1:3001").pathname.match(/^(\/[^/]+)?\/api\/extensions\//);
    if (m && m[1]) basePath = m[1];
  }
  if (!basePath) {
    const envBp = String(process.env.PI_WEB_BASE_PATH || "").replace(/^\/+|\/+$/g, "");
    if (envBp) basePath = "/" + envBp;
  }

  // 两段式建会话（替代经 aiti-helper invoke——后者同步等模型回合，慢时触发网关 504/客户端降级）：
  //   ① POST /api/agent/new {type:"ensure_session"} → 秒级拿到 sessionId（spawn+get_state，无模型回合）
  //   ② POST /api/agent/<id> {type:"prompt"} → accept 窗口内未结算即 202 返回（回合后台跑，
  //      结果经会话页/All Sessions 查看）→ 整个 ask-ai 请求秒级-十秒级返回，不撞网关超时
  const { localOrigin } = resolveApiBase(req);
  const portOrigin = "http://127.0.0.1:" + String(process.env.PORT || "3000") + basePath;
  const bases = [portOrigin, localOrigin + basePath];
  const seen = new Set<string>();
  let sessionId = "";
  let lastErr = "";
  for (const b of bases) {
    if (seen.has(b)) continue;
    seen.add(b);
    try {
      const r1 = await fetch(b + "/api/agent/new", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, type: "ensure_session" }),
      });
      const j1 = await r1.json().catch(() => null);
      const sid = j1 && j1.sessionId ? String(j1.sessionId) : "";
      if (!r1.ok || !sid) { lastErr = (j1 && j1.error) || "HTTP " + r1.status; continue; }
      const r2 = await fetch(b + "/api/agent/" + encodeURIComponent(sid), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "prompt", message }),
      });
      if (!r2.ok && r2.status !== 202) {
        const j2 = await r2.json().catch(() => null);
        lastErr = (j2 && j2.error) || "HTTP " + r2.status;
        continue;
      }
      sessionId = sid;
      break;
    } catch (e) {
      lastErr = String(e).slice(0, 120);
    }
  }
  if (!sessionId) return { status: 502, body: { ok: false, error: "建会话失败：" + lastErr, debug: { bases: [...seen], cwd } } };

  // 跳转地址：优先按外部版脚本来源推导（含 basePath，浏览器可达）；兑底 AITI_BASE_URL 推导的 BASE
  const base = scriptBase || baseFromScriptUrl(String(body.base ?? "")) || BASE;
  const url = base.replace(/\/+$/, "") + "/?session=" + encodeURIComponent(sessionId);
  return { status: 200, body: { ok: true, sessionId, url } };
}

function baseFromScriptUrl(scriptUrl: string): string {
  try {
    const u = new URL(scriptUrl);
    const i = u.pathname.indexOf("/api/extensions/aiti-cpu-meter/");
    if (i > 0) return u.origin + u.pathname.slice(0, i);
  } catch { /* ignore */ }
  return "";
}

// 推断 server 端自请求的 API base（照 aiti-helper resolveApiBase）：必须走本机端口（127.0.0.1），
// 不能用 host header 的外部域名（nginx 反代外部域名到 dev server，转发规则可能 405）。
function resolveApiBase(req: Request): { localOrigin: string; basePath: string } {
  const reqUrl0 = new URL(req.url, "http://127.0.0.1:3001");
  const localOrigin = "http://127.0.0.1:" + reqUrl0.port;
  const referer = req.headers.get("referer") || "";
  let basePath = "";
  if (referer) {
    try {
      const refPath = new URL(referer).pathname;
      const m = refPath.match(/^(\/[^/]+)(?:\/api\/|\/|$)/);
      if (m) basePath = m[1] || "";
    } catch { /* ignore */ }
  }
  if (!basePath) {
    const m = reqUrl0.pathname.match(/^(\/[^/]+)?\/api\/extensions\//);
    if (m) basePath = m[1] || "";
  }
  return { localOrigin, basePath };
}

// ── 资产服务 + 内容哈希（照 aiti-devtools launcher 模式）──────────────────
function assetPath(ctx, name) {
  return join(ctx.dir, "assets", name);
}
function serveAsset(ctx, name) {
  try {
    const data = readFileSync(assetPath(ctx, name));
    const ctype = name.endsWith(".html") ? "text/html; charset=utf-8" : "application/javascript; charset=utf-8";
    return new Response(data, { headers: { "content-type": ctype, "cache-control": "no-store" } });
  } catch {
    return new Response("asset not found: " + name, { status: 404 });
  }
}
const _hashCache = new Map(); // ctx.dir → { mtime, hash }
function meterHash(ctx) {
  try {
    const p = assetPath(ctx, "aiti-cpu-meter.js");
    const st = statSync(p);
    const cached = _hashCache.get(ctx.dir);
    if (cached && cached.mtime === st.mtimeMs) return cached.hash;
    const hash = createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12);
    _hashCache.set(ctx.dir, { mtime: st.mtimeMs, hash });
    return hash;
  } catch {
    return "";
  }
}

// 注入地址协商（照 aiti-devtools inject.ts）：AITI_BASE_URL + PI_WEB_BASE_PATH 自动补前缀
const _base0 = (process.env.AITI_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const _basePath = String(process.env.PI_WEB_BASE_PATH || "").replace(/^\/+|\/+$/g, "");
const BASE = _basePath && !_base0.endsWith("/" + _basePath) ? _base0 + "/" + _basePath : _base0;

// 注入地址协商：BASE（AITI_BASE_URL + PI_WEB_BASE_PATH，照 aiti-devtools inject.ts）兜底；
// 但 service-tunnels vhost 页面（<port>[-<label>].<domain>，如 8899.localhost:3002 / 8899.pi.example.com:8443）
// 优先用「父域」——即 pi-web 本身可达的地址（vhost 子域会转发到目标服务，脚本不在那；且跨源公网域名
// 会被浏览器 ORB/request-security 拦）。自暴露域名（页面本身就挂在 pi-web 域）→ 同 host。
function scriptOriginFor(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const h = u.hostname;
    if (!/^[\d.]+$/.test(h)) {
      // service-tunnels vhost 命名：<port>[-<label>].<domain> —— 第一段以端口数字开头
      const m = h.match(/^\d{1,5}(?:-[^.]*)?\.(.+)$/);
      if (m && m[1]) return u.protocol + "//" + m[1] + (u.port ? ":" + u.port : "");
    }
    // 页面 host 就是 pi-web（自暴露域名 / pi-web 自身页面）→ 同 host 直取
    try {
      const b = new URL(BASE);
      if (u.host === b.host) return u.origin;
    } catch (_) {}
  } catch (_) {}
  return BASE;
}

function injectScriptTag(ctx, pageUrl) {
  const origin = pageUrl ? scriptOriginFor(pageUrl) : BASE;
  return `<script src="${origin}/api/extensions/aiti-cpu-meter/aiti-cpu-meter.js?v=${meterHash(ctx)}" defer></script>`;
}
