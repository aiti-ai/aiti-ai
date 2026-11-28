/**
 * aiti-devtools-core · HTML 注入中间件（公共能力，载体无关）
 *
 *   - write/end 首次时在 body 开头 prepend launcher script（不缓冲、流式保持、页面加载最早期执行）
 *   - 按响应 content-type（text/html）判断是否注入
 *   - 拦截 setHeader 跳过 content-length（框架/上游设的 CL 本身可能不准，注入后 body 变长会被截断 → chunked 保完整）
 * 适用：任何 Connect/express 中间件 server（Next custom server / vite configureServer / 独立 node server）
 * 配合 connectBridge 使用（桥在 <prefix>/*，注入只做 HTML 响应）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface HtmlInjectOptions {
  /** 挂载前缀（默认 /aiti）——launcher src / data-bridge-url 用 */
  prefix?: string;
  /** 标识名（默认 aiti-devtools）——data-name */
  name?: string;
  /** 注入的完整 script 标签（自定义覆盖；缺省用 launcher 标签） */
  tag?: string;
}

/** 注入 script 标签（launcher + 桥地址；与 connectBridge 同 prefix） */
export function launcherTag(opts: HtmlInjectOptions = {}): string {
  const prefix = (opts.prefix || "/aiti").replace(/\/+$/, "") || "/aiti";
  const name = opts.name || "aiti-devtools";
  return (
    opts.tag ||
    `<script src="${prefix}/aiti-launcher.js" data-ai-url="${prefix}/cockpit.html" data-bridge-url="${prefix}" data-name="${name}" defer></script>`
  );
}

export interface HtmlInjectMiddleware {
  (req: IncomingMessage, res: ServerResponse, next: () => void): void;
}

/** Connect 中间件：HTML 响应 prepend 注入 launcher（同端口拦截，服务端零改动） */
export function htmlInjectMiddleware(opts: HtmlInjectOptions = {}): HtmlInjectMiddleware {
  const tag = launcherTag(opts);
  const prefix = (opts.prefix || "/aiti").replace(/\/+$/, "") || "/aiti";
  return (req, res, next) => {
    // 自己的挂载前缀（/aiti/*，含 cockpit.html）绝不注入——否则 launcher 被注进 AI 窗，
    // AI 窗里再开 AI 窗 → 无限递归（SvelteKit 等 SSR 载体实测嵌套 7+ 层，exec 转发断链）
    try {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      if (pathname === prefix || pathname.startsWith(prefix + "/")) return next();
    } catch {}
    // 仅主页面导航：Sec-Fetch-Mode 存在且非 navigate（子资源/XHR/fetch）→ 不包装不注入
    //（保护框架的 RSC 流/HMR 资源——CL 与流语义必须保持原样；无头请求如 curl 默认注入）
    const sfm = String((req.headers as Record<string, unknown>)["sec-fetch-mode"] || "");
    if (sfm && sfm !== "navigate") return next();
    // 按响应 content-type 双保险判断（请求 accept 可能 */*，不准确）
    const isHtmlResponse = (r: ServerResponse) => {
      const ct = r.getHeader("content-type");
      return typeof ct === "string" && ct.includes("text/html");
    };

    const origWrite = res.write;
    const origEnd = res.end;
    const origSetHeader = res.setHeader;
    // @ts-expect-error 包装 setHeader：跳过 content-length（注入后 body 变长，CL 截断 → chunked 保完整）
    res.setHeader = function (k: unknown, v: unknown) {
      if (String(k).toLowerCase() === "content-length") return this;
      return origSetHeader.call(this, k, v);
    };
    let injected = false;
    // @ts-expect-error 包装 write：首次 prepend 注入标签（流式保持，不缓冲）
    res.write = function (chunk: unknown, ...rest: unknown[]) {
      if (!injected && isHtmlResponse(this) && chunk !== undefined && chunk !== null) {
        injected = true;
        const buf = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : Buffer.from(String(chunk));
        return origWrite.call(this, Buffer.concat([Buffer.from(tag), buf]), ...rest);
      }
      return origWrite.call(this, chunk, ...rest);
    };
    // @ts-expect-error 包装 end：write 未触发（框架用 end 单块，如 Next）→ 单块时也 prepend
    res.end = function (chunk: unknown, ...rest: unknown[]) {
      if (!injected && isHtmlResponse(this) && chunk !== undefined && chunk !== null) {
        injected = true;
        const buf = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : Buffer.from(String(chunk));
        return origEnd.call(this, Buffer.concat([Buffer.from(tag), buf]), ...rest);
      }
      return origEnd.call(this, chunk, ...rest);
    };
    next();
  };
}
