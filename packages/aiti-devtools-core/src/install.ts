/**
 * aiti-devtools-core · aiti 中间件 + 进程挂载（公共能力，载体无关）
 *
 * 两个导出（桥实例 / 页面资产 / 注入标签全部内部创建——aiti 自己的资源不让调用方碰）：
 *
 *   aitiMiddleware()        —— 标准 Connect 中间件（桥路由 + HTML 注入）。
 *                              谁持有 server 谁挂载：app.use(aitiMiddleware())，可与其他逻辑自由组合。
 *                              不碰端口 / 不注册 MCP（挂载者自己决定）。
 *
 *   patchProcessHttp()      —— 进程级挂载（patch http.Server.prototype.emit），Next instrumentation 等
 *                              **拿不到 server 实例**的场景专用。进程全局、幂等（一个进程一次）。
 *                              含 MCP 自动注册（与其他载体体验一致）：端口由宿主传 opts.port 或 PORT env
 *                              （core 不持有端口，只读）；mcp 选项可关。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { connectBridge, type ConnectMiddleware } from "./connect.ts";
import { createBridge } from "./bridge.ts";
import { loadAssets } from "./assets.ts";
import { registerMcp } from "./mcp-config.ts";
import { normalizeBridgeUrl } from "./endpoints.ts";
import type { HttpBridgeHandle } from "./http.ts";

export interface AitiMiddlewareOptions {
  /** 标识名：MCP 条目名/日志/界面文案（默认 'aiti-devtools'；多项目并存改名） */
  name?: string;
  /** 外部桥地址（可带 /aiti、/bridge、/mcp 等多余路径，自动协商剥后缀；空 = 用内部桥） */
  bridgeUrl?: string;
  /** AI 窗地址（默认同源 /aiti/cockpit.html） */
  aiUrl?: string;
  /** 挂载前缀（默认 /aiti） */
  prefix?: string;
  /** 注入标签（默认自动生成；传 null 禁用注入只挂桥路由） */
  tag?: string | null;
  /** 共享桥实例（缺省内部创建；外部桥模式（bridgeUrl）时无需桥实例） */
  bridge?: HttpBridgeHandle;
  /** 日志 */
  log?: (line: string) => void;
}

export interface PatchProcessHttpOptions extends AitiMiddlewareOptions {
  /** 宿主端口（拼端点/MCP 注册 url 用；缺省读 PORT env） */
  port?: number;
  /** 宿主 host（默认 localhost） */
  host?: string;
  /** MCP 注册选项（与 vite/webpack 等载体一致；register 默认 true） */
  mcp?: {
    register?: boolean;                     // 关闭自动注册
    targets?: string[] | "auto" | false;    // 'auto'=写已存在的配置文件（默认）；或 ['pi','claude',…]
    configPaths?: string[];                 // 用户指定的 mcp 配置文件（自动识别结构）
    dryRun?: boolean;                       // 只报告不写
    projectDir?: string;                    // 项目根（claude .mcp.json / vscode 工作区）
  };
}

/** aiti 中间件：桥路由 + HTML 注入（标准 Connect 格式，挂任意 server/express，可组合） */
export function aitiMiddleware(opts: AitiMiddlewareOptions = {}): ConnectMiddleware & { bridge: HttpBridgeHandle } {
  const prefix = (opts.prefix || "/aiti").replace(/\/+$/, "") || "/aiti";
  const name = opts.name || "aiti-devtools";
  const bridge = opts.bridge || createBridge();
  const bridgeMw = connectBridge(bridge, { prefix, staticFiles: loadAssets() });
  // 外部桥模式（bridgeUrl，如用户自己用 CLI 起的桥）：页面注入指向外部桥，/aiti/* 桥路由仍挂（兼容两种用法）
  const tag = opts.tag === null ? null : opts.tag !== undefined
    ? opts.tag
    : opts.bridgeUrl
      ? externalTag(opts.bridgeUrl, opts.aiUrl, name)
      : defaultTag(prefix, opts.aiUrl, name);
  const mw: ConnectMiddleware = (req, res, next) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      bridgeMw(req, res, () => {
        if (!res.headersSent) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found: " + pathname); }
      });
      return;
    }
    if (tag && shouldInject(req)) {
      if (req.headers["accept-encoding"] !== undefined) req.headers["accept-encoding"] = "identity";
      wrapResForInject(res, tag);
    }
    next();
  };
  return Object.assign(mw, { bridge });
}

/** 进程级挂载（Next instrumentation 等拿不到 server 实例的场景；进程全局，幂等） */
export function patchProcessHttp(opts: PatchProcessHttpOptions = {}): { bridge: HttpBridgeHandle } {
  const prefix = (opts.prefix || "/aiti").replace(/\/+$/, "") || "/aiti";
  const log = opts.log || ((l: string) => console.log(l));
  const sym = Symbol.for("aiti-devtools.process-patched");
  if ((globalThis as Record<symbol, unknown>)[sym]) {
    log(`[aiti-devtools] 进程级 patch 已存在，跳过`);
    return { bridge: (globalThis as Record<string, unknown>).__aitiBridge as HttpBridgeHandle };
  }
  const mw = aitiMiddleware(opts);
  (globalThis as Record<string, unknown>).__aitiBridge = mw.bridge;
  (globalThis as Record<symbol, unknown>)[sym] = true;

  const origEmit = http.Server.prototype.emit;
  // @ts-expect-error patch：仅请求事件走 aiti 中间件（next() 放行原链）
  http.Server.prototype.emit = function (event: string, ...args: unknown[]) {
    if (event === "request") {
      const [req, res] = args as [IncomingMessage, ServerResponse];
      let passed = false;
      mw(req, res, () => { passed = true; });
      if (!passed) return true; // aiti 消化（桥路由），不透传
    }
    return origEmit.call(this, event, ...args);
  };

  // MCP 自动注册（与其他载体一致；端口由宿主传或 PORT env——core 不持有端口）
  const mcp = opts.mcp || {};
  if (mcp.register !== false && mcp.targets !== false) {
    const port = opts.port ?? (process.env.PORT ? Number(process.env.PORT) : NaN);
    if (Number.isFinite(port)) {
      const host = opts.host || "localhost";
      // 注册 url：外部桥（bridgeUrl，用户自己 CLI 起的）→ 指外部；否则本进程端点
      const url = opts.bridgeUrl
        ? normalizeBridgeUrl(opts.bridgeUrl, "/aiti").origin + "/aiti/mcp"
        : `http://${host}:${port}${(opts.prefix || "/aiti")}/mcp`;
      const r = registerMcp({
        url,
        serverName: opts.name,
        targets: mcp.targets === false ? undefined : (mcp.targets || "auto"),
        configPaths: mcp.configPaths || [],
        projectDir: mcp.projectDir,
        dryRun: !!mcp.dryRun,
        log,
      });
      log(`[aiti-devtools] MCP 注册：${r.summary}`);
    } else {
      log(`[aiti-devtools] 未提供端口（opts.port / PORT env），跳过 MCP 注册`);
    }
  }
  log(`[aiti-devtools] 进程级挂载完成（桥路由 + HTML 注入）`);
  return { bridge: mw.bridge };
}

function defaultTag(prefix: string, aiUrl?: string, name?: string): string {
  return `<script src="${prefix}/aiti-launcher.js" data-ai-url="${aiUrl || prefix + "/cockpit.html"}" data-bridge-url="${prefix}"${name ? ` data-name="${name}"` : ""} defer></script>`;
}

/** 外部桥模式注入标签：地址自动协商（剥多余后缀）后指向外部桥 */
function externalTag(bridgeUrl: string, aiUrl?: string, name?: string): string {
  const r = normalizeBridgeUrl(bridgeUrl, "/aiti");
  const base = r.origin + "/aiti";
  return `<script src="${base}/aiti-launcher.js" data-ai-url="${aiUrl || base + "/cockpit.html"}" data-bridge-url="${base}"${name ? ` data-name="${name}"` : ""} defer></script>`;
}

/** 仅主页面导航（Sec-Fetch-Mode navigate；子资源/XHR/fetch 不碰）；无头请求（curl）默认注入 */
function shouldInject(req: IncomingMessage): boolean {
  const sfm = String(req.headers["sec-fetch-mode"] || "");
  if (sfm && sfm !== "navigate") return false;
  return true;
}

function wrapResForInject(res: ServerResponse, tag: string) {
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  const origSetHeader = res.setHeader.bind(res);
  const origWriteHead = res.writeHead.bind(res);
  // content-type 缓存：writeHead(headers) 设置的头 getHeader 读不到——包装时记录
  let ctCache: string | undefined;
  const isHtml = () => {
    const ct = ctCache !== undefined ? ctCache : String(res.getHeader("content-type") || "");
    return ct.includes("text/html");
  };
  const stripCl = (h: Record<string, unknown>) => {
    const o = { ...h };
    delete o["Content-Length"]; delete o["content-length"];
    delete o["Transfer-Encoding"]; delete o["transfer-encoding"];
    return o;
  };
  // @ts-expect-error wrap
  res.setHeader = function (k: unknown, v: unknown) {
    if (String(k).toLowerCase() === "content-type" && typeof v === "string") ctCache = v;
    if (isHtml() && String(k).toLowerCase() === "content-length") return this;
    return origSetHeader(k, v);
  };
  // @ts-expect-error wrap
  res.writeHead = function (status: unknown, ...rest: unknown[]) {
    const hs = rest[0];
    if (hs && typeof hs === "object") {
      const h = hs as Record<string, unknown>;
      const ct = h["Content-Type"] || h["content-type"];
      if (typeof ct === "string" && ctCache === undefined) ctCache = ct;
      if (isHtml()) return origWriteHead(status, stripCl(h), ...rest.slice(1));
    }
    return origWriteHead(status, ...rest);
  };
  // doctype 之后插入（doctype 前触发 Quirks Mode）；无 doctype 则开头注入
  const injectAt = (buf: Buffer): Buffer => {
    const head = buf.toString("utf8");
    const m = head.match(/^\s*<!DOCTYPE[^>]*>/i);
    if (m) {
      const at = m[0].length;
      return Buffer.concat([buf.subarray(0, at), Buffer.from("\n" + tag), buf.subarray(at)]);
    }
    return Buffer.concat([Buffer.from(tag), buf]);
  };
  let injected = false;
  // @ts-expect-error wrap：首次注入，流式透传
  res.write = function (chunk: unknown, ...rest: unknown[]) {
    if (!injected && isHtml() && chunk != null) {
      injected = true;
      return origWrite(injectAt(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))), ...rest);
    }
    return origWrite(chunk, ...rest);
  };
  // @ts-expect-error wrap：end 单块场景也注入；其余透传
  res.end = function (chunk: unknown, ...rest: unknown[]) {
    if (!injected && isHtml() && chunk != null) {
      injected = true;
      return origEnd(injectAt(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))), ...rest);
    }
    return origEnd(chunk, ...rest);
  };
}
