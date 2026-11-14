/**
 * aiti-testagent-native · IDE 面板 —— testagent-native broker（Windows 原生 API/COM 追踪）可视面
 *
 * 数据全部来自 testagent-native broker 的 HTTP 面（默认 http://127.0.0.1:8766）：
 *   /api/health          探活
 *   /api/rpc             全方法 JSON-RPC（= testagent-native-mcp 工具 1:1）
 * 面板能力（MVP）：broker 状态 / 进程扫描+attach / 会话表+eject / API 挂钩表单 /
 * 实时事件流（subscribe + 1s 拉取）。AI 侧走 testagent-native-mcp（stdio/HTTP 8767），
 * 人机共用同一 broker 方法面（bridge-integration-plan BR0-BR4）。
 */
import http from "node:http";

const BROKER = process.env.TAN_BROKER_HTTP || "http://127.0.0.1:8766";

/** broker HTTP 调用（POST /api/rpc；token 经环境 TAN_TOKEN 可选） */
function rpc<T = unknown>(method: string, params?: unknown, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL("/api/rpc", BROKER);
    const body = JSON.stringify({ method, params: params ?? {} });
    const req = http.request(
      {
        hostname: u.hostname, port: Number(u.port || 80), path: u.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(process.env.TAN_TOKEN ? { "X-Tan-Token": process.env.TAN_TOKEN } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error(`bad json: ${data.slice(0, 80)}`)); }
        });
      },
    );
    req.on("timeout", () => { req.destroy(); reject(new Error(`broker timeout: ${method}`)); });
    req.on("error", (e) => reject(new Error(`broker 不可达（${BROKER}）：${e.message}`)));
    req.end(body);
  });
}

async function brokerHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const u = new URL("/api/health", BROKER);
    const req = http.request(
      { hostname: u.hostname, port: Number(u.port || 80), path: u.pathname, method: "GET", timeout: 3000 },
      (res) => { res.resume(); resolve((res.statusCode ?? 0) === 200); },
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export interface ExtApiCtx {
  configDir: string;
  path: string[];
  searchParams: URLSearchParams;
}

async function handleApi(req: Request, ctx: ExtApiCtx): Promise<Response | null> {
  const [head] = ctx.path;
  try {
    if (req.method === "GET" && head === "health") {
      const up = await brokerHealth();
      return json({ ok: up, broker: BROKER });
    }
    if (req.method === "POST" && head === "rpc") {
      const body = (await req.json().catch(() => ({}))) as { method?: string; params?: unknown };
      if (!body.method) return json({ ok: false, error: "method 必填" }, 400);
      return json(await rpc(body.method, body.params));
    }
    // 快捷语义端点（面板直用；免拼 RPC 形状）
    if (req.method === "GET" && head === "processes") {
      const q = ctx.searchParams.get("query") ?? "";
      return json({ ok: true, ...(await rpc("proc.list", { query: q })) });
    }
    if (req.method === "GET" && head === "sessions") {
      return json({ ok: true, ...(await rpc("session.list", {})) });
    }
    if (req.method === "POST" && head === "attach") {
      const b = (await req.json().catch(() => ({}))) as { pid?: number };
      if (!b.pid) return json({ ok: false, error: "pid 必填" }, 400);
      return json(await rpc("proc.attach", { pid: b.pid }));
    }
    if (req.method === "POST" && head === "detach") {
      const b = (await req.json().catch(() => ({}))) as { session_id?: string };
      if (!b.session_id) return json({ ok: false, error: "session_id 必填" }, 400);
      return json(await rpc("proc.detach", { session_id: b.session_id, eject: true }));
    }
    if (req.method === "POST" && head === "watch") {
      const b = (await req.json().catch(() => ({}))) as { session_id?: string; module?: string; func_glob?: string };
      if (!b.session_id || !b.module || !b.func_glob)
        return json({ ok: false, error: "session_id/module/func_glob 必填" }, 400);
      return json(await rpc("watch.set", {
        session_id: b.session_id,
        watches: [{ module: b.module, func_glob: b.func_glob }],
      }));
    }
    if (req.method === "POST" && head === "subscribe") {
      const b = (await req.json().catch(() => ({}))) as { session_id?: string };
      if (!b.session_id) return json({ ok: false, error: "session_id 必填" }, 400);
      return json(await rpc("events.subscribe", { session_id: b.session_id }));
    }
    if (req.method === "POST" && head === "events") {
      const b = (await req.json().catch(() => ({}))) as { sub_id?: string };
      if (!b.sub_id) return json({ ok: false, error: "sub_id 必填" }, 400);
      return json(await rpc("events.next", { sub_id: b.sub_id, max: 100 }));
    }
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? String(e) }, 502);
  }
  return null;
}

export default {
  id: "aiti-testagent-native",
  name: "testagent-native（Windows API/COM 追踪面板）",
  icon: "icon.svg",
  client: "dist/aiti-testagent-native-client.mjs",

  server: {
    api: handleApi,
    startup() {
      console.log("[aiti-testagent-native] IDE 就绪（broker 面板：进程/会话/挂钩/事件流；数据源 http://127.0.0.1:8766，env TAN_BROKER_HTTP 可改）");
    },
    shutdown() {},
  },

  ui: {
    toolbar: [{ id: "testagent-native", label: "Win", title: "testagent-native · Windows API/COM 追踪", icon: "icons/monitor.svg" }],
    rightFileDock: [{ id: "panel", label: "Win" }],
    dialogs: [{ id: "panel", label: "testagent-native 追踪面板" }],
    clientImmediately: false,
    i18n: {
      en: {
        "wt.title": "testagent-native · Windows Native Trace",
        "wt.broker": "Broker",
        "wt.sessions": "Sessions",
        "wt.processes": "Processes",
        "wt.attach": "Attach",
        "wt.eject": "Eject",
        "wt.watch": "Watch",
        "wt.module": "Module",
        "wt.func": "Function glob",
        "wt.events": "Events",
        "wt.none": "None",
        "wt.refresh": "Refresh",
        "wt.offline": "broker offline (start testagent-native-broker, default 127.0.0.1:8766)",
      },
      "zh-CN": {
        "wt.title": "testagent-native · Windows 原生追踪",
        "wt.broker": "Broker",
        "wt.sessions": "会话",
        "wt.processes": "进程",
        "wt.attach": "挂载",
        "wt.eject": "卸载",
        "wt.watch": "挂钩",
        "wt.module": "模块",
        "wt.func": "函数通配",
        "wt.events": "事件流",
        "wt.none": "无",
        "wt.refresh": "刷新",
        "wt.offline": "broker 离线（先启动 testagent-native-broker，默认 127.0.0.1:8766）",
      },
    },
  },
};
