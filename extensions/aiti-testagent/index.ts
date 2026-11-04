/**
 * aiti-testagent · IDE 支持 —— Java 进程扫描 / 一键 attach / 连桥状态面板
 *
 * 与 mcp-testagent.cjs（stdio MCP server）共享同一核心 lib/testagent-core.cjs：
 *   - MCP 侧：ta_discover / ta_attach（挂载后自动等就绪）/ ta_bridge（一键连桥）
 *   - IDE 侧（本文件）：pi-web 工具条入口 → 面板（进程列表 / 一键 Attach / 会话状态）
 *
 * 面板数据全部来自 TestAgent 既有机制：
 *   已挂载会话 = ~/.cache/testagent/sessions（agent 写入，TCP 在线探测）
 *   候选进程   = 跨平台进程表扫描（java/jshell/-jar；Linux ps、Windows Cim、macOS ps）
 *   attach     = AttachTool（jdk.attach VirtualMachine loadAgent，agentmain 无需重启）
 */
import { createRequire } from "node:module";
import https from "node:https";
import nodePath from "node:path";
const require2 = createRequire(import.meta.url);

// 平台：核心 lib/testagent-core.cjs 已跨平台移植（方案 windows-compat §5 走向 B，2026-09-19）——
// Linux ps/ss、Windows Get-CimInstance+netstat、macOS ps/lsof；临时路径走 os.tmpdir()；
// JTO 自动挂载在 Windows 落用户级环境变量（setx/reg），Linux/macOS 落 shell rc 块。
// 热重载注意：jiti 重新加载本入口时，CJS 子模块走 Node 全局 require 缓存（旧代码）——
// 显式失效后再取，保证 lib 改动 reload 即生效。
const corePath = require2.resolve("./lib/testagent-core.cjs");
if (require2.cache[corePath]) delete require2.cache[corePath];
const core = require2(corePath);
const {
  loadBridgeConfig, saveBridgeConfig, bridgeStatus, bridgeBaseUrl, bridgeWsUrl, bridgeUseToken,
  bridgeConfigured, jtoEnabled, applyJto, BRIDGE_HTTP_PORT_DEFAULT, BRIDGE_WS_PORT_DEFAULT, bridgeFingerprint,
} = core;

// tunnel/bridge：桥地址（IDE 面板动态传 query ?bridge=；localStorage 记忆在 client 侧）
const BRIDGE_RE = /^https?:\/\//;

// ---------------- Web 操作台挂载（service-tunnels proxy no-auth）----------------
// 打开 TestAgent Web 操作台：把会话 httpPort 经 service-tunnels 的 proxy 模式（open binding，
// 无认证）登记为虚拟主机 <port>.<部署域>，URL 保留 TA 自身 basePath（前端 TA_BASE_PATH 绝对
// 路径 fetch，1:1 透传防双前缀）——浏览器直接打开 pi-web 域下的完整操作台。
// 单例与 aiti-devtools 同模式读取（service-tunnels 扩展 startup 创建，同进程共享）。
type StTunnelsLike = {
  proxy?: {
    enroll?(port: number, opts?: { serviceBasePath?: string }): void;
    unenroll?(port: number): void;
    enrolled?(): Array<{ port: number; serviceBasePath?: string }>;
  };
};
const stTunnels = (): StTunnelsLike | null =>
  ((globalThis as Record<string, unknown>).__piServiceTunnels as StTunnelsLike | undefined) ?? null;

/** 部署域入口（host:port，取第一项）——与 service-tunnels getBaseDomains 同回退链。 */
function baseDomainEntry(): string {
  const env = process.env as Record<string, string | undefined>;
  for (const k of ["PI_WEB_BASE_DOMAIN", "PI_WEB_ALLOWED_HOSTS", "PI_WEB_HOSTNAME"]) {
    const first = String(env[k] ?? "").split(",")[0]?.trim() ?? "";
    if (first) return first;
  }
  return "";
}

/** 本实例部署前缀（dev=/dev，生产=""）。 */
const deployPrefix = () => (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");

/** TA basePath 规范化为目录形态（"/testagent/"；空/"/" = 根）。 */
const normTaBasePath = (bp?: string | null): string => {
  if (!bp || bp === "/") return "/";
  const s = bp.startsWith("/") ? bp : "/" + bp;
  return s.endsWith("/") ? s : s + "/";
};

/** 对端实例 binding 同步（best-effort）：dev/prod 双实例各自进程内存 holding，互不热同步——
 *  经 nginx 回环入口（https://127.0.0.1:<部署域端口>，Host 用部署域；本机连 nginx
 *  remote_addr=回环 → Authelia 免认证）PATCH 对端 service-tunnels enroll 端点。
 *  对端部署前缀未知 → /api 与 /dev/api 两种形态都尝试（404/失败忽略），任一 2xx 即成功。 */
function peerPatch(path: string, body: unknown): Promise<boolean> {
  const entry = baseDomainEntry();
  const m = entry.match(/^([^:/]+)(?::(\d+))?$/);
  if (!m) return Promise.resolve(false);
  const host = m[1]!;
  const entryPort = m[2] ?? "443";
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: "127.0.0.1", port: Number(entryPort), path, method: "PATCH",
        headers: { host: `${host}:${entryPort}`, "content-type": "application/json" },
        rejectUnauthorized: false, timeout: 4000,
      },
      (res) => { res.resume(); const s = res.statusCode ?? 0; resolve(s >= 200 && s < 300); },
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end(JSON.stringify(body));
  });
}

async function syncPeerEnroll(port: number, action: "enroll" | "unenroll"): Promise<boolean> {
  const body = action === "enroll" ? { port, basePath: "" } : { port, remove: true };
  const prefixes = deployPrefix() === "/dev" ? ["", "/dev"] : ["/dev", ""];
  let ok = false;
  for (const pre of prefixes) {
    try { ok = (await peerPatch(`${pre}/api/extensions/service-tunnels/enroll`, body)) || ok; } catch { /* best-effort */ }
  }
  return ok;
}

/** 本实例 HTTP 端口（localhost 降级形态用：vhost 请求需到达 pi-web 自身 middleware）。 */
const piWebPort = (): number => {
  const p = Number(process.env.PORT);
  return Number.isInteger(p) && p > 0 ? p : 3000;
};

/** 生成 p-web 挂载 URL：
 *  - 配了部署域：https://<port>.<部署域><本实例部署前缀><basePath>/（nginx 泛域 + 泛证书，远程可达）
 *  - 未配部署域：http://<port>.localhost:<piWeb端口><部署前缀><basePath>/（RFC 6761，浏览器解析 127.0.0.1；
 *    需浏览器与 pi-web 同机，端口=本实例 PORT——middleware 即网关，库默认后缀 .localhost 已验证可解析） */
function webMountUrl(httpPort: number, basePath: string): string {
  const entry = baseDomainEntry();
  if (entry) return `https://${httpPort}.${entry}${deployPrefix()}${basePath}`;
  return `http://${httpPort}.localhost:${piWebPort()}${deployPrefix()}${basePath}`;
}

/** 已登记（enrolled）端口集合——/processes 附带 web.enrolled 供面板显示挂载状态。 */
function enrolledPorts(): Set<number> {
  try {
    const en = stTunnels()?.proxy?.enrolled?.() ?? [];
    return new Set(en.map((e) => e.port));
  } catch { return new Set(); }
}

export interface ExtApiCtx {
  configDir: string;
  path: string[];
  searchParams: URLSearchParams;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function handleApi(req: Request, ctx: ExtApiCtx): Promise<Response | null> {
  const [head] = ctx.path;
  try {
    if (req.method === "GET" && head === "processes") {
      // 进程↔ta 端口对齐：attached = 有 TestAgent 连接的（含陈旧，前端在线点区分）；candidates = 活进程但无 ta
      const enrolled = enrolledPorts();
      const t = await core.buildProcessTable();
      const flat = (e: any) => ({ pid: e.pid, httpPort: e.ta?.port ?? null, basePath: e.ta?.basePath ?? null,
        agentVersion: e.ta?.version ?? null, startTime: null, cmd: e.cmd,
        active: !!e.ta?.online, degraded: !!e.ta?.degraded,
        web: e.ta?.port ? { enrolled: enrolled.has(e.ta.port) } : undefined });
      // tunnel/bridge 双源（方案 §5.6）：?bridge=<TaBridge 地址> 时融合桥端点列表（失败降级 bridge.mode=unreachable）
      const bridgeQ = ctx.searchParams.get("bridge");
      const bridgeTokenQ = ctx.searchParams.get("bridgeToken");
      const bridge = bridgeQ && BRIDGE_RE.test(bridgeQ)
        ? await core.fetchBridgeEndpoints(bridgeQ, bridgeTokenQ || undefined) : undefined;
      return json({ ok: true, attached: t.connected.concat(t.dead).map(flat), candidates: t.plain.map(flat),
        bridge: bridge ? { url: bridgeQ, mode: bridge.mode, endpoints: bridge.endpoints, error: (bridge as any).error } : undefined });
    }
    if (req.method === "POST" && head === "tunnel-remove") {
      const body = (await req.json().catch(() => ({}))) as { bridge?: string; endpointId?: string; useToken?: string };
      if (!body.bridge || !BRIDGE_RE.test(body.bridge) || !body.endpointId) return json({ ok: false, error: "bridge 与 endpointId 必填" }, 400);
      const r = await core.removeBridgeEndpoint(body.bridge, body.endpointId, body.useToken || undefined, false);
      return json(r, r.ok ? 200 : 400);
    }
    if (head === "reg-token") {
      // 注册票据（桥主邀请 TA 加入）：POST 签发 / GET 列表 / DELETE 吊销
      if (req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { bridge?: string; useToken?: string; ttlSec?: number };
        if (!body.bridge || !BRIDGE_RE.test(body.bridge)) return json({ ok: false, error: "bridge 地址必填" }, 400);
        const r = await core.issueRegToken(body.bridge, body.useToken || undefined, body.ttlSec ? Number(body.ttlSec) : undefined);
        return json(r, r.ok ? 200 : 502);
      }
      if (req.method === "GET") {
        const bridge = ctx.searchParams.get("bridge");
        const useToken = ctx.searchParams.get("useToken");
        if (!bridge) return json({ ok: false, error: "bridge 地址必填" }, 400);
        return json(await core.listRegTokens(bridge, useToken || undefined));
      }
      if (req.method === "DELETE") {
        const body = (await req.json().catch(() => ({}))) as { bridge?: string; useToken?: string; token?: string };
        if (!body.bridge || !body.token) return json({ ok: false, error: "bridge 与 token 必填" }, 400);
        return json(await core.revokeRegToken(body.bridge, body.useToken || undefined, body.token));
      }
    }
    if (req.method === "POST" && head === "tunnel") {
      // 经桥的端点隧道操作：status / connect（远程补连）/ disconnect——X-TA-Endpoint 寻址
      const body = (await req.json().catch(() => ({}))) as { bridge?: string; action?: string; url?: string; endpointId?: string; useToken?: string };
      if (!body.bridge || !BRIDGE_RE.test(body.bridge)) return json({ ok: false, error: "bridge 地址必填（http://host:port）" }, 400);
      const action = String(body.action || "status");
      if (action === "connect" && !/^wss?:\/\//.test(String(body.url || ""))) return json({ ok: false, error: "connect 需要 url（ws://host:port，端点视角）" }, 400);
      const r = await core.bridgeTunnel(body.bridge, action, body.url, body.endpointId, body.useToken || undefined);
      return json({ ok: r.ok, status: r.status, data: r.data }, r.ok ? 200 : 502);
    }
    if (req.method === "GET" && head === "sessions") {
      const t = await core.buildProcessTable();
      return json({ ok: true, attached: t.connected.concat(t.dead) });
    }
    if (req.method === "POST" && head === "attach") {
      const body = (await req.json().catch(() => ({}))) as {
        pid?: string | number; bridge?: string; bridgeWs?: string; regToken?: string; taToken?: string;
      };
      const pid = body.pid != null ? String(body.pid) : "";
      if (!/^\d+$/.test(pid)) return json({ ok: false, error: "pid 必须是纯数字" }, 400);
      // 挂到桥：extra agent args（testagent.* 经 premain 解析器同步为系统属性）——TA 上线即入桥
      if (body.bridgeWs || body.regToken || body.taToken) {
        const extra: string[] = [];
        if (body.bridgeWs) extra.push("testagent.bridge=" + body.bridgeWs.trim());
        if (body.regToken) extra.push("testagent.bridge.token=" + body.regToken.trim());
        if (body.taToken) { extra.push("testagent.bridge.needToken=true"); extra.push("testagent.token=" + body.taToken.trim()); }
        const r = await core.attachJava(pid, extra.join(","));
        if (!r.ok) return json(r, 500);
        if (body.bridge && BRIDGE_RE.test(body.bridge)) {
          // 已挂载进程 agentmain 幂等跳过（extra 未生效）→ 尽力经 ta 端口运行时补连；新挂载进程由 bootstrap 自动上桥
          try {
            const t = await core.buildProcessTable();
            const mine = t.all.find((e: any) => e.pid === pid && e.ta);
            if (mine?.ta?.port && body.bridgeWs) {
              await core.api("POST", "/api/tunnel", { action: "connect", url: body.bridgeWs.trim(), token: body.regToken || undefined },
                mine.ta.port, mine.ta.basePath || "/testagent", body.taToken ? { "X-TA-Token": body.taToken } : undefined);
            }
          } catch { }
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline) {
            const t = await core.fetchBridgeEndpoints(body.bridge, body.useToken || undefined);
            const hit = (t.endpoints || []).find((e: any) => String(e.pid) === pid && e.online);
            if (hit) return json({ ok: true, pid, ready: true, onBridge: true, endpoint: hit });
            await new Promise((rr) => setTimeout(rr, 800));
          }
          return json({ ok: false, pid, error: "attach 已执行但 20s 内未在桥上看到该端点（检查注册 token / 桥 WS 地址）" }, 500);
        }
        const ready = await core.waitForReady(r.pid || pid, 20000);
        return json({ ok: !!ready, pid: r.pid || pid, ready: !!ready, ...(r.note ? { note: r.note } : {}), ...(ready ? { session: ready } : {}) }, ready ? 200 : 500);
      }
      // ensureConnected：已挂载→直接返回；未挂载→attach + 等待 HTTP 就绪（约 2-15s）
      const r = await core.ensureConnected({ pid, auto: false, timeoutMs: 15000 });
      return json(r, r.ok ? 200 : 500);
    }
    if (req.method === "POST" && head === "bridge/start") {
      // 启动自己的桥（同 jar 双角色）：java -cp testagent.jar TaBridge
      const body = (await req.json().catch(() => ({}))) as { jar?: string; httpPort?: number; wsPort?: number; regToken?: string; useToken?: string };
      // 与 MCP/自建桥同款确认逻辑：带配置指纹，/api/endpoints 回显供重连对比
      const fp = bridgeFingerprint({ mode: "self", self: {
        httpPort: Number(body.httpPort) || BRIDGE_HTTP_PORT_DEFAULT,
        wsPort: Number(body.wsPort) || BRIDGE_WS_PORT_DEFAULT,
        regToken: body.regToken || "", useToken: body.useToken || "",
      } });
      const r = core.startBridge({ ...body, instanceId: fp });
      if (!r.ok) return json(r, 500);
      const ready = await core.bridgeReady(r.url, body.useToken);
      return json({ ...r, ready, bridgeWs: r.wsUrl, instanceId: fp }, ready ? 200 : 500);
    }
    if (req.method === "GET" && head === "bridge") {
      // 桥管理状态：配置 + 桥在线/端点 + JTO 开关（Linux/macOS shell rc 标记块；Windows 用户级 JAVA_TOOL_OPTIONS）
      const cfg = loadBridgeConfig();
      const status = await core.bridgeStatus();
      return json({ ok: true, config: cfg, status, jto: { enabled: await jtoEnabled(), snippet: core.jtoSnippet() } });
    }
    if (req.method === "POST" && head === "bridge" && ctx.path[1] === "jto") {
      // JAVA_TOOL_OPTIONS 自动挂载开关：Linux/macOS 写/删 shell rc 标记块，Windows setx 用户级环境变量
      //（两者都影响此后新启动的所有 Java 进程，含 maven/gradle 等构建工具）
      const body = (await req.json().catch(() => ({}))) as { enabled?: boolean };
      if (!bridgeConfigured()) return json({ ok: false, error: "桥未配置（先保存桥配置）" }, 400);
      const r = await applyJto(!!body.enabled);
      return json({ ok: r.ok, error: r.error, enabled: await jtoEnabled(), snippet: r.snippet ?? core.jtoSnippet() }, r.ok ? 200 : 500);
    }
    if (req.method === "POST" && head === "bridge") {
      // 保存桥配置（mode=self/external + 对应段）；self 模式保存后自动拉起（幂等）；jto 开着则重写注入段
      const body = (await req.json().catch(() => ({}))) as {
        mode?: string; self?: { httpPort?: number | string; wsPort?: number | string; regToken?: string; useToken?: string };
        external?: { url?: string; ws?: string; useToken?: string; regToken?: string };
      };
      const mode = body.mode === "external" ? "external" : "self";
      const prev = loadBridgeConfig();
      const cfg: any = { ...(prev ?? {}), mode };
      const num = (v: unknown, d: number) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 65535 ? n : d; };
      if (mode === "self") {
        cfg.self = {
          httpPort: num(body.self?.httpPort, prev?.self?.httpPort ?? BRIDGE_HTTP_PORT_DEFAULT),
          wsPort: num(body.self?.wsPort, prev?.self?.wsPort ?? BRIDGE_WS_PORT_DEFAULT),
          regToken: String(body.self?.regToken ?? prev?.self?.regToken ?? ""),
          useToken: String(body.self?.useToken ?? prev?.self?.useToken ?? ""),
        };
      } else {
        const url = String(body.external?.url ?? prev?.external?.url ?? "").trim();
        if (!/^https?:\/\//.test(url)) return json({ ok: false, error: "外部桥地址必填（http://host:port）" }, 400);
        cfg.external = {
          url: url.replace(/\/$/, ""),
          ws: String(body.external?.ws ?? prev?.external?.ws ?? "").trim(),
          useToken: String(body.external?.useToken ?? prev?.external?.useToken ?? ""),
          regToken: String(body.external?.regToken ?? prev?.external?.regToken ?? ""),
        };
      }
      saveBridgeConfig(cfg);
      const status = await core.bridgeStatus(); // self 模式此处自动拉起（幂等）
      if (await jtoEnabled()) await applyJto(true); // 桥地址变了 → 重写 JTO 注入段（rc 块 / 用户级 env）
      return json({ ok: true, config: cfg, status, jto: { enabled: await jtoEnabled() } });
    }
    if (req.method === "POST" && head === "web-open") {
      // 打开 Web 操作台：service-tunnels proxy no-auth 登记会话端口为 p-web 虚拟主机，返回可访问 URL
      const body = (await req.json().catch(() => ({}))) as { pid?: string | number; port?: number; basePath?: string };
      let httpPort = Number(body.port ?? 0);
      let basePath = body.basePath;
      const pid = body.pid != null ? String(body.pid) : "";
      if (!httpPort && /^\d+$/.test(pid)) {
        const t = await core.buildProcessTable();
        const hit = t.all.find((e: any) => String(e.pid) === pid && e.ta);
        if (!hit?.ta) return json({ ok: false, error: "该进程没有在线的 TestAgent 会话（先 Attach 挂载）" }, 404);
        httpPort = hit.ta.port; basePath = hit.ta.basePath;
      }
      if (!Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) return json({ ok: false, error: "pid 或 port 必填" }, 400);
      const st = stTunnels();
      if (!st?.proxy?.enroll) return json({ ok: false, error: "service-tunnels 扩展未就绪（extman 启用后重试）" }, 502);
      // proxy no-auth：open binding 登记；serviceBasePath 留空 —— TA 前端以 TA_BASE_PATH（/testagent）
      // 绝对路径请求，URL 保留 basePath 1:1 透传，避免代理层双前缀
      const bp = normTaBasePath(basePath);
      st.proxy.enroll(httpPort, { serviceBasePath: "" });
      const synced = await syncPeerEnroll(httpPort, "enroll");
      const url = webMountUrl(httpPort, bp);
      const degraded = !baseDomainEntry(); // localhost 降级形态（需与 pi-web 同机）
      return json({ ok: true, url, httpPort, basePath: bp, synced, degraded });
    }
    if (req.method === "POST" && head === "web-close") {
      // 关闭挂载（unenroll 本实例 + best-effort 同步对端）
      const body = (await req.json().catch(() => ({}))) as { port?: number };
      const port = Number(body.port ?? 0);
      if (!Number.isInteger(port) || port <= 0) return json({ ok: false, error: "port 必填" }, 400);
      const st = stTunnels();
      if (!st?.proxy) return json({ ok: false, error: "service-tunnels 扩展未就绪" }, 502);
      if (typeof st.proxy.unenroll === "function") st.proxy.unenroll(port);
      const synced = await syncPeerEnroll(port, "unenroll");
      return json({ ok: true, port, synced });
    }
    if (req.method === "POST" && head === "ta/call") {
      // 单独连 TA（直连任意地址 + token）：GET /api/ping|/api/status
      const body = (await req.json().catch(() => ({}))) as { url?: string; path?: string; token?: string };
      const url = (body.url || "http://127.0.0.1:8564").replace(/\/$/, "");
      const path = String(body.path || "/api/ping");
      if (!/^\/api\//.test(path)) return json({ ok: false, error: "path 必须以 /api/ 开头" }, 400);
      const headers = body.token ? { "X-TA-Token": String(body.token) } : undefined;
      const r = await core.withTimeout(core.api("GET", path, null, undefined, undefined, headers, url), 6000);
      return json({ ok: r.status === 200, status: r.status, data: r.data });
    }
    if (req.method === "POST" && head === "ping") {
      const body = (await req.json().catch(() => ({}))) as { port?: number; basePath?: string };
      if (!body.port) return json({ ok: false, error: "port 必填" }, 400);
      const r = await core.pingAgent(Number(body.port), body.basePath);
      return json({ ok: r.status === 200, status: r.status, data: r.data });
    }
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? String(e) }, 500);
  }
  return null;
}

export default {
  id: "aiti-testagent",
  name: "TestAgent 连桥（Java 进程扫描 / Attach）",
  version: "0.3.0",
  icon: "icon.svg",
  client: "dist/aiti-testagent-client.mjs",

  server: {
    api: handleApi,
    startup() {
      console.log("[aiti-testagent] IDE 就绪（Java 进程扫描 / attach / 连桥面板；MCP 侧见 mcp-testagent.cjs）");
      // 默认自建桥：无配置写入默认 self 配置；已配置 → 幂等拉起（spawn detached，reload/重启不重复）——
      // 之后 JTO 挂载的 Java 进程自动上桥注册，面板/MCP 直接可见。
      void (async () => {
        try {
          if (!loadBridgeConfig()) {
            saveBridgeConfig({ mode: "self", self: { httpPort: BRIDGE_HTTP_PORT_DEFAULT, wsPort: BRIDGE_WS_PORT_DEFAULT, regToken: "", useToken: "" } });
          }
          const st = await core.bridgeStatus();
          if (st.online && st.identityOk === false) console.warn(`[aiti-testagent] ⚠ 端口 ${st.url} 上已是另一个不同配置的 TaBridge（instanceId=${st.bridgeInstanceId}，期望=${st.instanceId}）——换端口或先停旧桥`);
          else if (st.online) console.log(`[aiti-testagent] 桥在线：${st.url}（在线端点 ${st.endpointCount}/${st.endpoints.length}）`);
          else if (st.mode === "self") console.log(`[aiti-testagent] 自建桥拉起失败（查看 ${nodePath.join(core.TMP_DIR, "ta-bridge-*.log")}）`);
        } catch (e) { console.error("[aiti-testagent] 桥初始化失败（非致命）:", e); }
      })();
    },
    shutdown() {},
  },

  ui: {
    // 懒加载 v2 M3批①：静态条目带 icon（与 client ICONS.cup 同源，物化前后零闪变）。
    toolbar: [{ id: "java", label: "Java", title: "Java 进程 · TestAgent 连桥", icon: "icons/coffee.svg" }],
    // aiti-float dock v3：停靠槽静态声明（懒扩展物化触发 + 静态入口；id 与 client 注册一致）
    rightFileDock: [{ id: "panel", label: "Java" }],
    dialogs: [{ id: "panel", label: "Java 进程连桥面板" }],
    clientImmediately: false, // [懒加载 v2] M1 已同步生产，懒化重启用
    i18n: {
      en: {
        "at.title": "Java Processes · TestAgent Bridge",
        "at.entry": "Java",
        "at.refresh": "Refresh",
        "at.close": "Close",
        "at.attached": "Attached sessions",
        "at.candidates": "Java processes (not attached)",
        "at.attach": "Attach",
        "at.attaching": "Attaching…",
        "at.none": "None",
        "at.active": "online",
        "at.inactive": "offline",
        "at.tip": "Bridge-first: the extension auto-runs a local TaBridge (or connect an external one); turn on JAVA_OPTS auto-mount so every new Java process attaches and registers itself — then open consoles from the endpoint list; MCP (aiti-testagent) routes all ta_* tools to bridge endpoints via the endpoint param.",
        "at.attachOk": "Attached — HTTP API ready",
        "at.attachFail": "Attach failed",
        "at.open": "Open console",
        "at.openTip": "Open the full TestAgent web console under the pi-web domain (service-tunnels proxy, no auth): hot update / Eval / Mock / SQL / diagnostics…",
        "at.webEnrolled": "Mounted on p-web",
        "at.webClose": "Unmount",
        "at.openFail": "Failed to open console",
        "at.syncWarn": " (peer instance sync failed: the other instance may need the same mount or a restart)",
        "at.degraded": " (localhost fallback: browser must be on the pi-web host)",
      },
      "zh-CN": {
        "at.title": "Java 进程 · TestAgent 连桥",
        "at.entry": "Java",
        "at.refresh": "刷新",
        "at.close": "关闭",
        "at.attached": "已挂载会话",
        "at.candidates": "Java 进程（未挂载）",
        "at.attach": "挂载",
        "at.attaching": "挂载中…",
        "at.none": "无",
        "at.active": "在线",
        "at.inactive": "离线",
        "at.tip": "桥为中心：扩展默认自建 TaBridge（也可配外部桥）；开 JAVA_OPTS 自动挂载后，新 Java 进程自动挂 agent 连桥——等注册即可，端点列表一键打开操作台；MCP（aiti-testagent）经 endpoint 参数路由任意端点，AI 可操作全部桥上进程。",
        "at.attachOk": "挂载成功 —— HTTP API 已就绪",
        "at.attachFail": "挂载失败",
        "at.open": "打开操作台",
        "at.openTip": "在 pi-web 域下打开完整 TestAgent Web 操作台（service-tunnels proxy 无认证挂载）：热更新 / Eval / Mock / SQL / 诊断…",
        "at.webEnrolled": "已挂到 p-web",
        "at.webClose": "取消挂载",
        "at.openFail": "打开操作台失败",
        "at.syncWarn": "（对端实例同步失败：另一实例需同样挂载或重启后生效）",
        "at.degraded": "（localhost 降级形态：需浏览器与 pi-web 同机）",
      },
    },
  },
};
