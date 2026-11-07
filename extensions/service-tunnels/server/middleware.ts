/**
 * service-tunnels extension · middleware hook（宿主 proxy 在核心门禁前调用）。
 *
 * 承担原 pi-web proxy.ts 的 service 专属分支：
 *   ① 自暴露隧道域名 → 虚拟主机映射（无白名单后门，统一走 resolve 认证）
 *   ② 服务虚拟主机（<port>[-<label>].<domain>）：进程内 parseHost + resolve
 *      → pipe / redirect / forward / deny / deny-auth（同一份库实现）
 *   ③ allowlocal 直连门禁（自暴露安全：非回环直连 403，含两阶段封禁 HTML）
 *   ④ 实例自愈：库实例缺失 → 懒重建；resolve not enrolled → 节流地从盘重读
 *      登记并重试一次（CLI/同机其它实例启动后直写共享 state.json 的场景），
 *      不重启进程即可让新登记生效，仍 deny 则照常 fail-closed
 *
 * 不处理的请求返回 { handled: false } → 宿主继续核心门禁（DNS-rebinding +
 * PI_WEB_PASSWORD）。全部用标准 Response 构造（rewrite 走 x-middleware-rewrite
 * 头、redirect 走 302+Location、JSON 走 Response.json）——无需引入 next/server。
 */
import type { ExtMiddlewareResult } from "./middleware-types.ts";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { resolveExposeInject, getServiceTunnels, rehydrateBindingsFromDisk } from "./integration.ts";
import {
  getBaseDomains,
  getPiWebPort,
  getAllowLocal,
  getAllowLocalHosts,
  getAllowLocalPending,
  mapSelfTunnelToVhost,
  issueSelfForwardToken,
  isValidSelfForwardToken,
} from "./proxy-shared.ts";

/** 宿主 proxy.ts 同款：从 globalThis 读库实例（扩展启动时创建）。 */
function liveServiceTunnels(): unknown | null {
  return (globalThis as Record<string, unknown>).__piServiceTunnels ?? null;
}

/** 注入片段：__stInjectRegistry 多注册者聚合（兼容旧 __aitiInject 单实例）。 */
import { aggregateInjections } from "./inject-registry.ts";

/** 外部页面 URL：基于 Host 头 / x-forwarded-* 构造浏览器实际访问的地址。
 *  request.url 的 host 是内部 bind 地址（如 127.0.0.1:3002），不反映 vhost 子域
 *  （如 8899.localhost:3002）——注入源需要外部 host 来推断同域脚本地址。构造失败
 *  回退 request.url。 */
function externalPageUrl(request: Request): string {
  try {
    const inner = new URL(request.url);
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (!host) return request.url;
    const proto = request.headers.get("x-forwarded-proto")
      ?? (request.headers.get("cf-visitor")?.match(/"scheme":"(https?)"/)?.[1])
      ?? inner.protocol.replace(":", "");
    return `${proto}://${host}${inner.pathname}${inner.search}`;
  } catch {
    return request.url;
  }
}

type AitiInjection = { prepend?: string; head?: string } | null;

function aitiInjectSnippet(port: number, url: string, method: string): AitiInjection {
  try { return aggregateInjections(port, url, method); } catch { return null; }
}

/** 按通道注入白名单过滤（公开配置的注入源列表）。 */
function aitiInjectSnippetAllowed(port: number, url: string, method: string, ids: string[]): AitiInjection {
  try { return aggregateInjections(port, url, method, ids); } catch { return null; }
}

/** 两段注入：prepend 拼在 html 前，head 段插入 </head> 前（无则尾部）。 */
async function aitiInjectHtml(port: number, url: string, inj: NonNullable<AitiInjection>): Promise<Response | null> {
  try {
    const u = new URL(url, `http://127.0.0.1:${port}`);
    u.port = String(port);
    u.hostname = "127.0.0.1";
    const upstream = await fetch(u.href, { headers: { accept: "text/html,*/*" }, redirect: "manual" });
    const ct = upstream.headers.get("content-type") || "";
    if (!ct.includes("text/html")) return null;
    let html = await upstream.text();
    if (inj.prepend) html = inj.prepend + html;
    if (inj.head) {
      html = html.includes("</head>")
        ? html.replace("</head>", inj.head + "</head>")
        : html + inj.head;
    }
    const headers = new Headers(upstream.headers);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    headers.delete("content-encoding");
    return new Response(html, { status: upstream.status, headers });
  } catch { return null; }
}

/** basePath 目录规范化 302（no-store；与宿主 proxy.ts 同款）。 */
function redirectToBase(request: Request, raw: URL, base: string): Response {
  const u = new URL(base + "/", request.url);
  u.search = raw.search;
  const res = new Response(null, {
    status: 302,
    headers: {
      location: u.toString(),
      "cache-control": "no-store",
    },
  });
  return res;
}

/** 库实例的 parseHost/resolve/… 结构化访问（运行时对象，无静态类型依赖）。 */
interface StProxyLike {
  proxy: {
    parseHost(host: string): { label?: string } | null;
    resolve(args: Record<string, unknown>): Promise<{
      kind: "deny" | "deny-auth" | "pipe" | "redirect" | "forward";
      body?: string;
      wwwAuthenticate?: string;
      port?: number;
      label?: string;
      url?: string;
      location?: string;
      target?: string;
    }>;
  };
  exposes?: () => Array<Record<string, unknown> & { site?: string; name?: string; url?: string | null; running?: boolean; port?: number }>;
}

/** 自愈节流：not-enrolled 洪水最多每 3s 触发一次盘读（state.json 很小，防放大）。 */
const SELF_HEAL_MIN_INTERVAL_MS = 3000;

/** 从盘自愈一次（节流）。返回 true 表示盘上读到了登记、值得重试 resolve。 */
function selfHealFromDisk(): boolean {
  const g = globalThis as Record<string, unknown>;
  const now = Date.now();
  if (now - (typeof g.__stSelfHealAt === "number" ? g.__stSelfHealAt : 0) < SELF_HEAL_MIN_INTERVAL_MS) return false;
  g.__stSelfHealAt = now;
  return rehydrateBindingsFromDisk() > 0;
}

export async function serviceTunnelsMiddleware(request: Request): Promise<ExtMiddlewareResult> {
  // 宿主 proxy.ts 在调用扩展钩子前已把 public tunnel 域名映射为 vhost——
  // 本扩展仍自行兜底映射（扩展未加载时宿主不做映射）。
  let st = liveServiceTunnels() as StProxyLike | null;
  // 自愈①：实例缺失（扩展尚未初始化/被卸载清掉）时懒重建——getServiceTunnels
  // 内部有 globalThis 单例守卫，实例健在时是零开销直返。
  if (!st) {
    try {
      st = getServiceTunnels() as StProxyLike | null;
    } catch { /* 懒建失败保持 null → 宿主核心门禁兜底 */ }
  }

  let host = request.headers.get("host");
  if (host && st && typeof st.proxy?.parseHost === "function") {
    const hostname = host.replace(/^\[|\]$/g, "").split(":")[0];
    if (!st.proxy.parseHost(hostname)) {
      const mapped = mapSelfTunnelToVhost(hostname);
      if (mapped) {
        request.headers.set("host", mapped);
        host = mapped;
      }
    }
  }

  // 服务虚拟主机：库的进程内决策（enrollment/auth/forward）——无独立代理端口。
  if (host && st && typeof st.proxy?.parseHost === "function" && st.proxy.parseHost(host)) {
    let decision: Awaited<ReturnType<StProxyLike["resolve"]>>;
    try {
      const raw = new URL(request.url);
      const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
      const piWebSelf = st.proxy.parseHost(host)?.label === "pi-web";
      if (base && piWebSelf && (raw.pathname === "/" || raw.pathname === "")) {
        return { handled: true, response: redirectToBase(request, raw, base) };
      }
      if (!piWebSelf && base && raw.pathname === base) {
        return { handled: true, response: redirectToBase(request, raw, base) };
      }
      const resolveArgs = {
        host,
        url: raw.pathname + raw.search,
        method: request.method,
        authorization: request.headers.get("authorization") ?? undefined,
        cookie: request.headers.get("cookie") ?? undefined,
        remoteAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
        forwardedProto: (request.headers.get("x-forwarded-proto") as "http" | "https") ?? undefined,
      };
      decision = await st.proxy.resolve(resolveArgs);
      // 自愈②：not enrolled 可能是实例登记落后于共享 state.json（CLI/同机其它
      // 实例在进程启动后直写盘，而实例只在创建时恢复过一次）。节流地从盘重读
      // 登记并重试一次——不重启自愈，仍 deny 则照常 fail-closed。
      if (decision.kind === "deny" && /not enrolled/.test(decision.body ?? "") && selfHealFromDisk()) {
        decision = await st.proxy.resolve(resolveArgs);
      }
    } catch (err) {
      console.error("[service-tunnels] vhost resolve failed:", err);
      return { handled: true, response: new Response("service-tunnels: resolve error", {
        status: 403,
        headers: { "cache-control": "no-store" },
      }) };
    }
    switch (decision.kind) {
      case "deny":
        return { handled: true, response: new Response(`service-tunnels: ${decision.body}`, {
          status: 403,
          headers: { "cache-control": "no-store" },
        }) };
      case "deny-auth":
        return { handled: true, response: new Response("Authentication required", {
          status: 401,
          headers: { "cache-control": "no-store", "www-authenticate": decision.wwwAuthenticate ?? 'Basic realm="services"' },
        }) };
      case "pipe": {
        // 注入按公开通道配置（该通道 expose 勾选的源）——注入是公开配置的一部分
        const injectIds = resolveExposeInject(decision.port ?? 0, decision.label);
        const externalUrl = externalPageUrl(request);
        const aitiSnippet = injectIds ? aitiInjectSnippetAllowed(decision.port ?? 0, externalUrl, request.method, injectIds) : null;
        if (aitiSnippet) {
          const injected = await aitiInjectHtml(decision.port ?? 0, request.url, aitiSnippet);
          if (injected) return { handled: true, response: injected };
        }
        const url = new URL(decision.url ?? "/", `http://127.0.0.1:${decision.port}`);
        // 纵深防御：decision.url 理论上只含相对路径（库 mapServicePath 产物），但
        // 若被传入协议相对/绝对路径（//host 或 http://host），URL 构造会覆盖 host →
        // 开放代理/SSRF。强制目标 hostname 回环（Next 已在 middleware 前规范化
        // // → /，此为第二道防线）。
        const host = url.hostname.toLowerCase();
        if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
          return { handled: true, response: new Response("service-tunnels: invalid pipe target", { status: 403, headers: { "cache-control": "no-store" } }) };
        }
        if (decision.port === getPiWebPort()) {
          const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
          if (base && (url.pathname === "/" || url.pathname === "")) {
            return { handled: true, response: new Response(null, {
              status: 302,
              headers: { location: new URL(base + "/", request.url).toString(), "cache-control": "no-store" },
            }) };
          }
          if (!getAllowLocal()) {
            url.search = `${url.search ? url.search + "&" : "?"}__piSelfFwd=${issueSelfForwardToken()}`;
          }
          request.headers.set("x-forwarded-host", host);
          request.headers.set("x-forwarded-proto", request.headers.get("x-forwarded-proto") ?? "http");
          request.headers.set("host", `127.0.0.1:${decision.port}`);
        } else {
          request.headers.set("host", host);
        }
        return { handled: true, response: new Response(null, {
          headers: { "x-middleware-rewrite": url.toString() },
        }) };
      }
      case "redirect":
        return { handled: true, response: new Response(null, {
          status: 302,
          headers: { location: decision.location ?? "/", "cache-control": "no-store" },
        }) };
      case "forward": {
        const target = decision.target ?? "";
        // 纵深防御：forward 目标（库的 forward-auth provider 配置）必须指向回环。
        // 若未来 provider 配置/路径拼接引入非回环 host，立即拒绝而非转发。
        try {
          const turl = new URL(target);
          const thost = turl.hostname.toLowerCase();
          if (thost !== "127.0.0.1" && thost !== "localhost" && thost !== "::1") {
            return { handled: true, response: new Response("service-tunnels: invalid forward target", { status: 403, headers: { "cache-control": "no-store" } }) };
          }
        } catch {
          return { handled: true, response: new Response("service-tunnels: invalid forward target", { status: 403, headers: { "cache-control": "no-store" } }) };
        }
        try {
          const turl = new URL(target);
          const tport = turl.port ? parseInt(turl.port, 10) : 0;
          const injectIds = tport ? resolveExposeInject(tport) : undefined;
          // 传「外部页面 URL」（基于 Host 头构造，含 vhost 子域）而非内部 request.url（host 是
          // 127.0.0.1）——注入源（如 aiti-cpu-meter）需要按页面地址推断脚本 host（vhost 子域 →
          // pi-web 父域），内部 URL 无外部 host 信息无法推断
          const snippet = tport ? (injectIds ? aitiInjectSnippetAllowed(tport, externalPageUrl(request), request.method, injectIds) : null) : null;
          if (snippet) {
            const injected = await aitiInjectHtml(tport, turl.pathname + turl.search, snippet);
            if (injected) return { handled: true, response: injected };
          }
        } catch (err) {
          console.error("[service-tunnels][aiti-inject] 注入失败，回退普通转发:", err);
        }
        // 上游 Host 语义：转发时 Host = 目标地址（127.0.0.1:port，与 nginx proxy_pass
        // 默认一致），而非公网 vhost 域名——否则链式目标是自带 service-tunnels 的
        // pi-web（如 aiti-demo 容器注册了同一 base domain）时，它会把请求当自己的
        // vhost、查自己的空登记 403 not enrolled。原 HTML 走 x-middleware-rewrite，
        // 但 Next rewrite 会丢弃 middleware 的头修改（Host 改不到上游），故 HTML 与
        // 其他方法统一手动转发；仅 websocket 升级仍走 rewrite（node:http 无法 upgrade）。
        const isUpgrade = (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
        if (isUpgrade) {
          request.headers.set("host", host);
          return { handled: true, response: new Response(null, {
            headers: { "x-middleware-rewrite": target },
          }) };
        }
        try {
          const fwdHeaders: Record<string, string> = {};
          for (const [k, v] of request.headers.entries()) fwdHeaders[k] = v;
          fwdHeaders["host"] = new URL(target).host;
          delete fwdHeaders["content-length"];
          delete fwdHeaders["transfer-encoding"];
          delete fwdHeaders["connection"];
          // 上游 gzip 问题：Next 对 middleware 返回的流式 Response 会丢
          // content-encoding 头（body 仍是 gzip 二进制）→ 浏览器按明文读乱码。
          // 删 accept-encoding 让上游返回明文，彻底绕开 gzip（内网 loopback
          // 明文传输带宽可忽略）。
          delete fwdHeaders["accept-encoding"];
          const upstreamRes = await new Promise<InstanceType<typeof IncomingMessage>>((resolve, reject) => {
            const upstreamReq = httpRequest(
              target,
              { method: request.method, headers: fwdHeaders },
              (res: InstanceType<typeof IncomingMessage>) => resolve(res),
            );
            upstreamReq.on("error", reject);
            if (request.body) Readable.fromWeb(request.body as unknown as import("node:stream/web").ReadableStream).pipe(upstreamReq);
            else upstreamReq.end();
          });
          const outHeaders = new Headers();
          const fwdProto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(/:$/, "") ?? "http";
          for (const [k, v] of Object.entries(upstreamRes.headers)) {
            if (["transfer-encoding", "connection", "content-length"].includes(k)) continue;
            // 上游相对 Location（如 vite base=/dev 的 302 → /dev/）：基于 vhost 转绝对，
            // 否则 Next 对响应头里相对 Location 的解析（new URL 单参）会 500。
            if (k === "location" && typeof v === "string" && v.startsWith("/")) {
              outHeaders.set(k, `${fwdProto}://${host}${v}`);
              continue;
            }
            if (Array.isArray(v)) for (const x of v) outHeaders.append(k, x);
            else outHeaders.set(k, v as string);
          }
          const nullBody = [204, 205, 304].includes(upstreamRes.statusCode ?? 200);
          if (nullBody) upstreamRes.resume();
          return { handled: true, response: new Response(nullBody ? null : (Readable.toWeb(upstreamRes) as unknown as BodyInit), {
            status: upstreamRes.statusCode ?? 200,
            headers: outHeaders,
          }) };
        } catch (err) {
          console.error("[service-tunnels] forward node:http failed:", err);
          return { handled: true, response: new Response("service-tunnels: upstream error", { status: 502 }) };
        }
      }
    }
  }

  // allowlocal 直连门禁：非回环 Host 的直连（LAN/公网）403；回环也拦
  // （allowlocal=false 时），唯一例外是带 self-forward token 的内部转发。
  if (!getAllowLocal()) {
    const hostHeader = (request.headers.get("host") ?? "").toLowerCase();
    const hostname = hostHeader.replace(/^\[|\]$/g, "").split(":")[0];
    const fwdToken = new URL(request.url).searchParams.get("__piSelfFwd");
    const isSelfForward = isValidSelfForwardToken(fwdToken ?? "");
    if (!isSelfForward && !getAllowLocalHosts().includes(hostname)) {
      const pending = getAllowLocalPending();
      const remain = pending.pending ? Math.max(0, Math.ceil((pending.expiresAt - Date.now()) / 1000)) : 0;
      const refreshSec = pending.pending ? 1 : 5;
      const hint = pending.pending
        ? `<p>临时封禁中（剩余 <strong>${remain}s</strong>），页面每 1 秒自动刷新，恢复后立即重载…</p>`
        : `<p>本地直连已禁用（<code>allowlocal=false</code>），每 5 秒自动重试；解除后自动恢复。</p>`;
      const title = "访问被拒绝";
      const body = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="${refreshSec}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d0d0d;color:#e5e5e5}.card{text-align:center;padding:26px 30px;border:1px solid #333;border-radius:10px;max-width:440px;line-height:1.7}code{color:var(--danger, #f87171);background:#1c1c1c;padding:1px 6px;border-radius:4px}strong{color:var(--danger, #f87171)}</style></head>
<body><div class="card">
<h3 style="margin-top:0">${title}</h3>
${hint}
</div>
<script>setTimeout(function(){ location.reload(); }, ${refreshSec * 1000});</script>
</body></html>`;
      return { handled: true, response: new Response(body, {
        status: 403,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        },
      }) };
    }
  }

  return { handled: false };
}
