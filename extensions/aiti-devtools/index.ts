/**
 * aiti-devtools 扩展 —— 页面内 AI 调试助手（pi-web 托管）
 *
 * 能力：
 *   - 桥：/api/extensions/aiti-devtools/mcp/*（claim/sessions/register/sse/result/event + MCP JSON-RPC）
 *   - 静态资源：/api/extensions/aiti-devtools/aiti-launcher.js / ai.html / bridge-client.js
 *   - 注入：service-tunnels 端口开启注入后，HTML 响应自动注入 aiti-launcher.js
 *     （配置：/api/extensions/aiti-devtools/inject-ports；执行：proxy.ts pipe 分支经 globalThis.__aitiInject）
 *   - agent 扩展点（方案 M）：server.agent hooks → 工具经 SDK customTools 进程内注入每个 agent 会话
 *     （execute 直调桥 callTool，零配置零文件；不再写 ~/.config/mcp/mcp.json）
 *
 * 用法：把 aiti-launcher.js 加进任意页面 <script> 即自动启用调试器；
 *       AI 界面地址自动推断为同目录 ai.html（本扩展 /api/extensions/aiti-devtools/ai.html）。
 */
import { createBridgeExt as createBridge } from "./bridge.js"; // 薄适配层 → core（bridge-core.ts）
import { createInjector } from "./inject.js";
import { createPairFed } from "./pair-fed.js"; // pair 跨桥联邦代理（M3.2；feature 门控默认关）

const fs = require("node:fs");
const path = require("node:path");

let bridge = null;
let dataDirCache = ""; // 扩展 cacheDir（startup 存）：截屏大图落盘目录用（数据分层：可再生 → cache）
let fedFeatures: any = null; // startup 捕获 ctx.features（pairFed.* 配置读取）
function getOrCreatePairFed(cacheDir: string) {
  const g = globalThis as any;
  if (!g.__aitiPairFed) {
    g.__aitiPairFed = createPairFed({
      TAG: "[aiti-devtools]",
      cacheDir,
      log: (m: string) => console.log(m),
      deliverToAllLocalPeers: (env: unknown) => {
        const b = bridge;
        if (!b) return 0;
        let n = 0;
        try { for (const p of b.pair().listPeers()) if (p.online && b.pair().deliverToPeer(p.id, env)) n++; } catch {}
        return n;
      },
    });
  }
  return g.__aitiPairFed;
}
function fedFeatureValue(fid: string): string {
  try {
    const v = fedFeatures?.get?.("aiti-devtools", fid);
    if (typeof v === "string") return v.trim();
  } catch {}
  return "";
}
/** pairFed 配置现读（feature 改动即时生效；enabled 兜底 false——联邦默认关） */
function readFedConfig() {
  let enabled = false;
  try {
    const v = fedFeatures?.get?.("aiti-devtools", "pairFed.enabled");
    if (typeof v === "boolean") enabled = v;
    else { const reg = (globalThis as any).__piWebExt; enabled = reg?.featureEnabled ? !!reg.featureEnabled("aiti-devtools", "pairFed.enabled") : false; }
  } catch {}
  return { enabled, url: fedFeatureValue("pairFed.url"), filesDir: fedFeatureValue("pairFed.filesDir") };
}

// 跨 reload 桥单例：挂 globalThis（按 cacheDir 分 key）。
// 背景：POST /api/extensions/reload 会重新 import 扩展模块——若每次 startup 都 createBridge，
// 已连页面/AI 窗的 SSE 长连接留在旧桥实例上（连接健康、客户端永不重连），新桥实例的
// sessions 永远为空（页面“失联”直到手动刷新——reload 把桥勈成两半，多次复现）。
// 单例跨模块实例复用：旧 SSE 注册与新查询/推送同源，reload 不丢任何页面连接。
// 代价：bridge-core 代码更新需进程重启才生效（reload 只换适配层/资产；桥核心热更靠重启）。
// 惰性总线出口（统一 SSE 端口适配）：startup 时由 ctx 构造并置入；单例桥永远经最新
// ctx.services 现取（"aiti-event-bus.publish"）——reload 后 services 重新 provide 仍命中。
let busPublishFn: ((type: string, data?: Record<string, unknown>) => void) | null = null;

function getOrCreateBridge(cacheDir: string) {
  const g = globalThis;
  if (!g.__aitiBridges) g.__aitiBridges = {};
  const key = String(cacheDir || "");
  if (!g.__aitiBridges[key]) g.__aitiBridges[key] = createBridge(cacheDir, (type, data) => busPublishFn?.(type, data));
  return g.__aitiBridges[key];
}

// 静态资源（assets/ 目录，与 aiti-launcher.js 构建产物同目录引用 ai.html / bridge-client.js）
const ASSETS = {
  "aiti-launcher.js": "application/javascript",
  "ai.html": "text/html; charset=utf-8",
  "bridge-client.js": "application/javascript",
  "host-protocol.js": "application/javascript",
  "cdp-core.js": "application/javascript",
  "pair-client.js": "application/javascript",
  "pair.html": "text/html; charset=utf-8",
};

function serveAsset(ctx, name) {
  const p = path.join(ctx.dir, "assets", name);
  try {
    const data = fs.readFileSync(p);
    return new Response(data, { headers: { "content-type": ASSETS[name], "cache-control": "no-store" } });
  } catch {
    return new Response("asset not found: " + name, { status: 404 });
  }
}

export default {
  id: "aiti-devtools",
  name: "aiti devtools（页面内 AI 调试助手）",
  version: "0.2.2",
  icon: "icon.svg",
  client: "dist/aiti-client.mjs",

  // 功能管理（扩展管理器逐项启停）：核心约定 feature.id = "tool.<注入后的工具名>"——
  // core 在 collectAgentTools 时自动过滤禁用项并包装 execute（注入不出现 + 调用即拒绝）。
  // 与 bridge TOOLS（packages/aiti-devtools-core/src/bridge.ts）保持同步：新增/改名工具时更新此处。
  features: [
    // ── pair 设备互连（跨桥联邦，默认关）──
    { id: "pairFed.enabled", type: "boolean", label: "pairFed · 跨桥联邦", group: "pair 设备互连", description: "开启后本实例 pair 面板/agent 工具可见并发消息/文件给权威桥（默认 127.0.0.1:8777）的设备（fed: 前缀）；权威桥用户经「pi-web 桥」设备向本实例广播", default: false },
    { id: "pairFed.url", type: "string", label: "pairFed · 权威桥 pair base", group: "pair 设备互连", description: "默认 http://127.0.0.1:8777/aiti", placeholder: "http://127.0.0.1:8777/aiti" },
    { id: "pairFed.filesDir", type: "string", label: "pairFed · 权威桥文件目录", group: "pair 设备互连", description: "同机直读 fed 文件用；默认 ~/.pi/aiti-bridge/aiti-bridge/pair-files（跨机部署 fed 文件下载不可用）" },
    // ── 页面调试 ──
    { id: "tool.aiti_page_exec", label: "page_exec · 页面执行", group: "页面调试", description: "在已连接页面执行类 CDP 命令（DOM/CSS/Input/Page/Runtime/Storage/Performance/Browser 域）" },
    { id: "tool.aiti_page_snapshot", label: "page_snapshot · 页面现场", group: "页面调试", description: "拉取已连接页面基础现场（URL/选区/模拟条件）" },
    { id: "tool.aiti_self_ui", label: "self_ui · 窗口弹窗清单", group: "页面调试", description: "扫描目标页面（缺省 AI 主窗口 xxx/ai）打开的弹窗/表单/按钮——ai-helper 回填定位" },
    { id: "tool.aiti_form_fill", label: "form_fill · 弹窗表单回填", group: "页面调试", description: "把字段值回填到目标页面（缺省 AI 主窗口 xxx/ai）的弹窗表单（React 兼容）+ 可选点按钮——AI 结果直接操作扩展弹窗" },
    { id: "tool.aiti_bridge_status", label: "bridge_status · 桥状态", group: "页面调试", description: "查询已连接页面与挂起请求（按标题/URL 匹配 pageId；sessions 含 device——浏览器·屏幕·在线·语言，快速识别设备）" },
    { id: "tool.aiti_page_logs", label: "page_logs · 页面日志", group: "页面调试", description: "查询目标页面已采集的 console 日志（含连桥前缓冲重放）" },
    { id: "tool.aiti_page_network", label: "page_network · 页面网络", group: "页面调试", description: "查询目标页面已采集的 ajax/fetch 请求完成态（status/耗时/错误）" },
    // ── 用户交互 ──
    { id: "tool.aiti_user_pick_element", label: "user_pick_element · 点选元素", group: "用户交互", description: "请当前页面的人类用户点选一个页面元素（Inspector 点选模式）" },
    { id: "tool.aiti_user_confirm", label: "user_confirm · 确认", group: "用户交互", description: "向人类用户提一个是/否问题（可附补充说明）" },
    { id: "tool.aiti_user_choose", label: "user_choose · 多选一", group: "用户交互", description: "给人类用户一组选项让其选择（单选/多选/自定义）" },
    { id: "tool.aiti_user_input", label: "user_input · 输入", group: "用户交互", description: "请人类用户输入一段文本" },
    { id: "tool.aiti_user_presence", label: "user_presence · 在场探测", group: "用户交互", description: "探测人类用户是否在场/在线（长任务前确认）" },
    { id: "tool.aiti_user_notify", label: "user_notify · 通知", group: "用户交互", description: "非阻塞浏览器通知（不等待回答）" },
    // ── agent 会话 ──
    { id: "tool.aiti_aiti_hello", label: "aiti_hello · 注册", group: "agent 会话", description: "agent 自我介绍/注册/绑定目标页（建议会话开始时调用）" },
    { id: "tool.aiti_aiti_inbox", label: "aiti_inbox · 消息主通道", group: "agent 会话", description: "拉取发给本 agent 会话的消息（含异步作答/页面事件订阅）" },
    { id: "tool.aiti_file_stat", label: "file_stat · 文件校验", group: "agent 会话", description: "查询文件存在性/类型/大小/修改时间（绝对路径）" },
  ],

  ui: {
    toolbar: [{ id: "aiti-open", label: "AITI", title: "aiti devtools：注入端口管理 + AI 调试界面", icon: "icons/wrench.svg" }],
    dialogs: [{ id: "aiti-dialog", label: "AITI devtools" }],
  },

  server: {
    startup(ctx) {
      // 方案 M：不再写外部 MCP 配置文件——agent 工具经 server.agent 进程内注入（零配置）
      dataDirCache = (ctx && ctx.cacheDir) || "";
      // 统一 SSE 端口适配：接通桥下行 → event-bus（惰性现取服务出口——总线扩展
      // startupPriority=100 必先 startup，出口已 provide；现取兼容器更换手）。
      busPublishFn = (type, data) => {
        try { (ctx.services as any)?.get?.("aiti-event-bus.publish")?.publish?.(type, data); } catch { /* 总线缺席：客户端 fallback 自带 SSE */ }
      };
      bridge = getOrCreateBridge(ctx.cacheDir); // globalThis 单例：reload 复用，页面 SSE 连接不丢
      fedFeatures = ctx.features || null;
      getOrCreatePairFed(ctx.cacheDir).configure(readFedConfig()); // 联邦 feature 即时态（改 extman 开关即生效/停止）
      // 跨扩展服务出口（DI 方案 P1）：桥表只读获取（getOrCreateBridge 单例复用语义不变；
      // globalThis.__aitiBridges 双轨保留至消费方 [aiti-attach-agent] 迁完）
      ctx.services?.provide?.("aiti-devtools.bridges", {
        /** 按 cacheDir key 取（或建）桥实例——与 __aitiBridges[key] 同源单例 */
        get(key: string) {
          return getOrCreateBridge(key);
        },
      });
      // 注：端口登记（enroll/open binding）不归 aiti-devtools 管——那是 service-tunnels
      // 的职责（UI 登记/公开/Base Path）。本扩展唯一参与 = 告知 service-tunnels 它要
      // 向哪些端口注入 JS（inject-ports.json + 注入注册点）。
      const inj = createInjector(ctx.configDir);
      // 挂 globalThis：middleware（proxy.ts，独立 bundle）经此读注入判定/执行（与 __piServiceTunnels 同模式）
      globalThis.__aitiInject = inj.injector;
      console.log("[aiti-devtools] 桥就绪：/api/extensions/aiti-devtools/mcp");
    },
    shutdown() {
      bridge = null; // 仅清模块引用；globalThis 单例保留（reload 后 startup 复用，页面连接不丢）
      try { delete globalThis.__aitiInject; } catch {}
    },

    // /api/extensions/aiti-devtools/<path>
    async api(req, ctx) {
      const p = ctx.path || [];

      // 诊断：globalThis 上的注入注册状态
      if (p[0] === "diag" && bridge) {
        const g = globalThis;
        return new Response(JSON.stringify({
          aitiInject: typeof g.__aitiInject,
          hasEnabledFor: !!(g.__aitiInject && typeof g.__aitiInject.enabledFor === "function"),
          piTunnels: typeof g.__piServiceTunnels,
        }), { headers: { "content-type": "application/json" } });
      }
      // launcher 内容哈希版本号：与 inject.ts 的 src?v=<hash> 同机制（文件改动 → hash 变 → 浏览器强制拉新）。
      // 供浏览器侧注入（dev-exts/aiti-inject client 等，无法服务端拼 HTML）在注入前 fetch 本端点拼 ?v=<hash>
      if (p[0] === "launcher-version" && globalThis.__aitiInject) {
        const hash = (typeof globalThis.__aitiInject.launcherHash === "function") ? globalThis.__aitiInject.launcherHash() : "";
        return new Response(JSON.stringify({ ok: true, launcher: "aiti-launcher.js", hash }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      // 文件存在性校验（aiti 候选详情"🖥 前端"打开前置：必须有效路径——绝对路径且 stat 存在，才发宿主打开文件标签页；
      // 避免 FileViewer 打开不存在/URL/相对路径）。只 stat 不读内容，返回 {exists, isFile, isDirectory}
      // 路径走 body（不进 URL）：POST file-stat { path }
      if (p[0] === "file-stat" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const fp = String(body.path || "");
        if (!fp) return new Response(JSON.stringify({ exists: false, isFile: false, isDirectory: false }), { headers: { "content-type": "application/json" } });
        try {
          const st = fs.statSync(fp);
          return new Response(JSON.stringify({ exists: true, isFile: st.isFile(), isDirectory: st.isDirectory() }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
        } catch {
          return new Response(JSON.stringify({ exists: false, isFile: false, isDirectory: false }), { headers: { "content-type": "application/json" } });
        }
      }
      // pair 跨桥联邦（M3.2，feature pairFed.enabled 门控）：devices 并集 / fed: 出站转发 / fed 文件同机代理
      if (p[0] === "mcp" && p[1] === "bridge" && p[2] === "pair" && bridge) {
        getOrCreatePairFed(dataDirCache).configure(readFedConfig()); // feature 现读（extman 改开关即生效）
        const fed = getOrCreatePairFed(dataDirCache);
        const seg = p[3] || "";
        if (req.method === "GET" && seg === "devices") {
          const local = await (await bridge.handle(req, p.slice(1), ctx.searchParams)).json();
          const rows = (local.devices || []).concat(await fed.fedDevices());
          return new Response(JSON.stringify({ ok: true, devices: rows }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
        }
        if (req.method === "POST" && seg === "message") {
          const body = await req.json().catch(() => null);
          if (body && typeof body.to === "string" && fed.isFed(body.to)) {
            try {
              const r = await fed.fedSendText(body.to, String(body.text || ""));
              return new Response(JSON.stringify(r), { status: r.ok ? 200 : 400, headers: { "content-type": "application/json" } });
            } catch (e: any) {
              return new Response(JSON.stringify({ ok: false, error: String((e && e.message) || e) }), { status: 502, headers: { "content-type": "application/json" } });
            }
          }
          // 非 fed 目标：重建请求过本桥（body 已被消费）
          req = new Request(req.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
        }
        if (req.method === "POST" && seg === "file" && (p[4] || "") === "complete") {
          const fileId = p[5] || "";
          const resp = await bridge.handle(req, p.slice(1), ctx.searchParams);
          try {
            const info = bridge.pair().getFileInfo(fileId);
            if (info && info.status === "ready" && fed.isFed(info.to)) {
              await fed.fedSendFile({ path: info.path, name: info.name, size: info.size, mime: info.mime }, info.to)
                .then((r: any) => console.log("[aiti-devtools] fed 文件已重放 → " + info.to + " (" + r.fileId + ")"))
                .catch((e: any) => console.error("[aiti-devtools] fed 文件重放失败:", (e && e.message) || e));
            }
          } catch {}
          return resp;
        }
        if (req.method === "GET" && seg === "file" && p[4]) {
          const info = bridge.pair().getFileInfo(p[4]);
          if (!info) {
            const proxy = fed.fedFileProxy(p[4]);
            if (proxy) return fed.fileStreamResponse(proxy.path, proxy.meta.name || p[4], proxy.meta.size || 0, proxy.meta.mime || "application/octet-stream");
          }
        }
      }
      // 静态资源（单段路径）
      if (p.length === 1 && ASSETS[p[0]]) return serveAsset(ctx, p[0]);
      // 桥端点（mcp 前缀）
      if (p[0] === "mcp" && bridge) return bridge.handle(req, p.slice(1), ctx.searchParams);
      return new Response("not found: " + p.join("/"), { status: 404 });
    },

    // middleware：注入执行在 proxy.ts pipe 分支（认证决策后）；此处不接管
    async middleware() {
      return { handled: false };
    },

    // ---- 方案 M：agent 扩展点（进程内工具 + 会话生命周期，零配置） ----
    // 桥工具 → SDK customTools（execute 直调桥 callTool，不走 HTTP/MCP/配置）
    agent: {
      agentTools(info) {
        // 捕获桥实例进闭包：工具与 agent 会话同生命周期，会跨扩展 reload 存活——
        // reload 的 shutdown() 把模块级 bridge 置 null，而 collectAgentTools 仅建会话时调一次、
        // 不重注入 → 旧闭包读模块变量将永远「桥未就绪」（deploy 迭代期每次 reload 都会打死全部活跃会话）。
        // 桥是 globalThis 单例（reload 不销毁），捕获实例即跨 reload 存活。
        const b = bridge;
        if (!b) return [];
        const agentKey = "pi-web/" + info.sessionId;
        const session = () => ({ agentId: agentKey, agentKey, id: info.sessionId, source: "extension" });
        return b.tools().map((t) => {
          const name = "aiti_" + t.name;
          return {
            name,
            label: name,
            description: t.description + "（aiti-devtools 进程内直连，pi-web 会话）",
            // inputSchema 已是 JSON Schema（provider 侧 TypeBox 即生成 JSON Schema，直接可用）
            parameters: t.inputSchema || { type: "object", properties: {} },
            // execute 第三个参数 = SDK 本轮 AbortSignal（pi-web 点停止 → abort）→ 透传桥 callTool：
            // 桥侧挂起请求立即结算为已取消（不再等 15s/180s/60s 服务器超时），agent 循环收到错误结果后随即停止。
            async execute(_toolCallId, params, signal) {
              // pair 跨桥联邦（M3.2）：fed: 目标的 pair 工具走权威桥转发；bridge_status 追加 fed 设备
              const fed = getOrCreatePairFed(dataDirCache);
              fed.configure(readFedConfig());
              const toArg = params && typeof params.to === "string" ? params.to : "";
              if (fed && fed.isFed(toArg) && (t.name === "aiti_pair_send" || t.name === "aiti_pair_file")) {
                try {
                  if (t.name === "aiti_pair_send") {
                    const r = await fed.fedSendText(toArg, String(params.text || ""));
                    return { content: [{ type: "text", text: JSON.stringify(r) }], isError: !r.ok };
                  }
                  const fp = String(params.path || "");
                  let st: any = null;
                  try { st = fs.statSync(fp); } catch {}
                  if (!st || !st.isFile()) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "文件不存在: " + fp }) }], isError: true };
                  const r = await fed.fedSendFile({ path: fp, name: (fp.split("/").pop() as string) || "file", size: st.size, mime: "application/octet-stream" }, toArg);
                  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...r }) }], isError: false };
                } catch (e: any) {
                  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String((e && e.message) || e) }) }], isError: true };
                }
              }
              if (fed && t.name === "bridge_status") {
                const r0 = await b.callTool(t.name, params || {}, session(), signal || undefined);
                try {
                  const j = JSON.parse((r0.content && r0.content[0] && r0.content[0].text) || "{}");
                  j.devices = (j.devices || []).concat(await fed.fedDevices());
                  return { content: [{ type: "text", text: JSON.stringify(j) }], isError: false };
                } catch { return r0; }
              }
              const r = await b.callTool(t.name, params || {}, session(), signal || undefined);
              let text = (r && r.content && r.content[0] && r.content[0].text) || JSON.stringify(r);
              // 截屏大图落盘（适配层，热重载即生效）：工具结果里内联 dataUrl 超大（>120KB base64）→ 存文件、
              // 文本换成路径。桥核心（bridge.ts /bridge/result）也有同逻辑，但单例跨 reload——重启前由本层兑底，
              // 两层幂等（桥已落盘则文本里无大 dataUrl，本层正则不命中）。
              try {
                const m = text.match(/"dataUrl":\s*"(data:image\/(png|jpeg);base64,[A-Za-z0-9+\/=]{120000,})"/);
                if (m) {
                  const ext = m[2] === "png" ? "png" : "jpg";
                  // 兜底根：PI_WEB_DATA_DIR 优先（Docker/Windows 数据根独立于 ~/.pi）；未设 = ~/.pi/web/data 原行为。
                  // 三目录对称：兜底也落 <data>/aiti-devtools/cache（与 ctx.cacheDir 主路径一致）
                  const dir = path.join(dataDirCache || path.join(process.env.PI_WEB_DATA_DIR || path.join(require("node:os").homedir(), ".pi", "web", "data"), "aiti-devtools", "cache"), "aiti-shots");
                  fs.mkdirSync(dir, { recursive: true });
                  const file = path.join(dir, new Date().toISOString().replace(/[:.]/g, "-") + "." + ext);
                  fs.writeFileSync(file, Buffer.from(m[1].slice(m[1].indexOf(",") + 1), "base64"));
                  text = text.replace(m[1], "") // 大 dataUrl 摘除
                    .replace(/"dataUrl":\s*""/, '"dataUrl": "(已落盘)"')
                    + '\n[aiti] 截屏已存文件：' + file;
                  console.log("[aiti-devtools] 截屏落盘（适配层）：" + file);
                }
              } catch (e) { console.warn("[aiti-devtools] 截屏落盘失败（保留内联）:", (e as Error).message); }
              return { content: [{ type: "text", text }], ...(r && r.isError ? { isError: true } : {}) };
            },
          };
        });
      },
      onAgentSession(info) {
        if (!bridge) return;
        const key = "pi-web/" + info.sessionId;
        bridge.registerAgent(key, { agentId: key, id: info.sessionId, open: false, capabilities: {} });
        // 进程内推送 sink：人发消息/异步 user_* 作答 → 直推会话（模型立即看到）
        bridge.setAgentSink(key, (text, kind) => {
          const label = kind === "user_answer" ? "你的交互请求有人作答（来自 aiti-devtools）" : "人发来消息（来自 aiti-devtools）";
          void info.steer(String(label + "：" + text).slice(0, 800)).catch(() => {});
        });
        console.log("[aiti-devtools] agent 会话接入（进程内）：" + key);
      },
      onAgentSessionEnd({ sessionId }) {
        if (!bridge) return;
        const key = "pi-web/" + sessionId;
        bridge.setAgentSink(key, null);
        // 清理 agent 元数据（activeBoundPageId/fallback 列表/boundPageId）
        bridge.clearAgent(key);
      },
      onAgentSettled({ sessionId, text }) {
        if (!bridge || !text) return;
        bridge.answer("pi-web/" + sessionId, text);
      },
    },
  },
};
