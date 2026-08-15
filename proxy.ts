import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isValidBasicAuthorization,
  isWebPasswordEnabled,
} from "@/lib/web-auth";
import {
  getPiWebPort,
  getAllowLocal,
  getAllowLocalHosts,
  getAllowLocalPending,
  mapSelfTunnelToVhost,
  issueSelfForwardToken,
  isValidSelfForwardToken,
} from "@/lib/service-proxy-shared";

/**
 * pi-web security gate + embedded service-vhost proxy.
 *
 * pi-web's own traffic passes the DNS-rebinding / password gate. Service
 * virtual hosts (`<port>[-<label>].<domain>`) are handled IN PROCESS by the
 * service-tunnels instance shared on globalThis (created by
 * lib/service-tunnels-integration.ts): `st.proxy.resolve()` returns the
 * enrollment/auth/forward decision, and Next forwards via rewrite (its
 * internal http-proxy handles both HTTP and WebSocket upgrades). There is
 * exactly ONE implementation of vhost routing / allow-list / 403 — the
 * library's — and one public port; no separate proxy listener.
 */

// The live library instance created by lib/service-tunnels-integration.ts in
// the SAME process (verified: shared globalThis with the app server).
function liveServiceTunnels() {
  return globalThis.__piServiceTunnels ?? null;
}

/** aiti 注入片段：__aitiInject.scriptFor(port, url, method)（service-tunnels transformResponse 同一回调） */
type AitiInjection = string | { html: string; position?: "head" | "prepend" } | null;

async function aitiInjectSnippet(port: number, url: string, method: string): Promise<AitiInjection> {
  const inj = globalThis.__aitiInject;
  if (!inj || typeof inj.scriptFor !== "function") return null;
  try { return inj.scriptFor(port, url, method) || null; } catch { return null; }
}

/** 注入 HTML + 位置：string → head；{html, position} → 按 position */
function resolveAitiInject(r: AitiInjection): { html: string; position: "head" | "prepend" } | null {
  if (!r) return null;
  if (typeof r === "string") return { html: r, position: "head" };
  return { html: r.html, position: r.position === "prepend" ? "prepend" : "head" };
}

/** aiti 注入执行：fetch 上游 → text/html 注入（prepend=响应开头 / head=</head> 前）
 *  pi-web library mode 转发在 proxy.ts（fetch 缓冲），注入位置仍更早（prepend） */
async function aitiInjectHtml(port: number, url: string, snippet: string, position: "head" | "prepend"): Promise<Response | null> {
  try {
    const u = new URL(url, `http://127.0.0.1:${port}`);
    u.port = String(port);
    u.hostname = "127.0.0.1";
    const upstream = await fetch(u.href, { headers: { accept: "text/html,*/*" }, redirect: "manual" });
    const ct = upstream.headers.get("content-type") || "";
    if (!ct.includes("text/html")) return null;
    const html = await upstream.text();
    const injected = position === "prepend"
      ? snippet + html                       // 响应开头（解析器最先遇到 → 最早执行）
      : (html.includes("</head>") ? html.replace("</head>", snippet + "</head>") : html + snippet);
    const headers = new Headers(upstream.headers);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    return new Response(injected, { status: upstream.status, headers });
  } catch { return null; }
}

/** basePath 目录规范化 302：保持 query，补尾斜杠。Web 规范——目录 URL 必须以 / 结尾，
 * 否则浏览器把最后一段当"文件名"，相对链接 ./x 会解析到上一级（丢前缀）。
 * 必须 no-store：302 默认可被启发式缓存，一旦后续配置再次产生尾斜杠重定向
 * （双向 308）会污染浏览器永久重定向缓存 → ERR_TOO_MANY_REDIRECTS。 */
function redirectToBase(request: NextRequest, raw: URL, base: string): NextResponse {
  const u = new URL(base + "/", request.url);
  u.search = raw.search;
  const res = NextResponse.redirect(u, 302);
  res.headers.set("cache-control", "no-store");
  return res;
}

export async function proxy(request: NextRequest) {
  // Public tunnel-domain requests for pi-web's OWN exposure are mapped to its
  // proxy virtual host: the middleware then authenticates them through the
  // same resolve() path as every other gateway entry (no whitelist backdoor —
  // a forged Host still hits the auth provider).
  const st = liveServiceTunnels();
  let host = request.headers.get("host");
  if (host && st?.proxy?.parseHost) {
    const hostname = host.replace(/^\[|\]$/g, "").split(":")[0];
    if (!st.proxy.parseHost(hostname)) {
      const mapped = mapSelfTunnelToVhost(hostname);
      if (mapped) {
        request.headers.set("host", mapped);
        host = mapped;
      }
    }
  }

  // Extension middleware hooks (registry lives on globalThis, created by the
  // app server in instrumentation — the middleware bundle never imports
  // extension code). Extensions own their host/path namespaces; unhandled
  // requests fall through to the core gates. A throwing hook is fail-closed.
  const extRegistry = globalThis.__piWebExt;
  if (extRegistry) {
    try {
      const extRes = await extRegistry.middleware(request);
      if (extRes.handled) return extRes.response;
    } catch (err) {
      console.error("[pi-web] extension middleware failed:", err);
      return new NextResponse("extension middleware error", {
        status: 403,
        headers: { "cache-control": "no-store" },
      });
    }
  }

  // Service virtual hosts: the library's in-process decision API (parse,
  // enrollment, per-site auth backends, forward-auth probe, login redirect)
  // runs HERE — no separate proxy port, one public port. Next then forwards
  // the request (rewrite target) or answers 403/302/401.
  if (host && st?.proxy?.parseHost(host)) {
    let decision: Awaited<ReturnType<typeof st.proxy.resolve>>;
    try {
      // Next 的 nextUrl.pathname 在 basePath 模式下会剥除 /dev,而 request.url
      // 保留原始完整路径——resolve 必须用原始路径(/dev 开头、/portal/login 等
      // provider 路径原样),否则 strip/pipe 到错误目标
      const raw = new URL(request.url);
      const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
      const piWebSelf = st.proxy.parseHost(host)?.label === "pi-web";
      // pi-web 自身 vhost(部署域/隧道域映射)的根路径 → basePath:否则 Next
      // 根无页面 404(basic 经 gateway 转发 Host=127.0.0.1 后同样 404)
      if (base && piWebSelf && (raw.pathname === "/" || raw.pathname === "")) {
        return redirectToBase(request, raw, base);
      }
      // basePath 目录规范(隧道 vhost):公共 URL 恰好落在部署前缀(如 /dev)而无尾斜杠时,
      // 浏览器把 /dev 当"文件名",相对链接 ./x 解析到上一级(丢前缀 → nginx location /
      // 走错实例)。除 pi-web 自身(Next 路由用绝对链接,无需尾斜杠,且 /dev 即其页面根)
      // 外,统一 302 到 basePath + "/"(目录带尾斜杠是 Web 规范,保证 ./target.html
      // 解析为 /dev/target.html 而非 /target.html)。配合 next.config 的
      // skipTrailingSlashRedirect:true(/dev/ 不再被 Next 308 回 /dev),无死循环。
      if (!piWebSelf && base && raw.pathname === base) {
        return redirectToBase(request, raw, base);
      }
      decision = await st.proxy.resolve({
        host,
        url: raw.pathname + raw.search,
        method: request.method,
        authorization: request.headers.get("authorization") ?? undefined,
        cookie: request.headers.get("cookie") ?? undefined,
        remoteAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
        forwardedProto: (request.headers.get("x-forwarded-proto") as "http" | "https") ?? undefined,
      });
    } catch (err) {
      // Fail closed: an unexpected resolve error must never open a path
      // around the auth gateway — answer 403 like every other deny.
      console.error("[pi-web] service vhost resolve failed:", err);
      return new NextResponse("service-tunnels: resolve error", {
        status: 403,
        headers: { "cache-control": "no-store" },
      });
    }
    switch (decision.kind) {
      case "deny":
        return new NextResponse(`service-tunnels: ${decision.body}`, {
          status: 403,
          headers: { "cache-control": "no-store" },
        });
      case "deny-auth":
        return new NextResponse("Authentication required", {
          status: 401,
          headers: { "cache-control": "no-store", "www-authenticate": decision.wwwAuthenticate },
        });
      case "pipe": {
        // 响应注入（service-tunnels transformResponse 语义——library mode 转发在 proxy.ts）：
        // 读 __aitiInject.scriptFor（扩展注册，与 createServiceTunnels 的 transformResponse 同一回调）
        const aitiSnippet = await aitiInjectSnippet(decision.port, request.url, request.method);
        const aitiResolved = resolveAitiInject(aitiSnippet);
        if (aitiResolved) {
          const injected = await aitiInjectHtml(decision.port, request.url, aitiResolved.html, aitiResolved.position);
          if (injected) return injected;
        }
        const url = new URL(`http://127.0.0.1:${decision.port}`);
        url.pathname = decision.url.split("?")[0] ?? "/";
        url.search = decision.url.includes("?") ? `?${decision.url.split("?")[1]}` : "";
        console.log("[pi-web][dbg] pipe:", { host, decisionUrl: decision.url, port: decision.port, rewriteTarget: url.href, rawUrl: request.url, nextPath: request.nextUrl.pathname });
        if (decision.port === getPiWebPort()) {
          // 根路径重定向到 basePath:pi-web 无根页面(登录后 next=/ 会 404),
          // 裸 / 应落到部署前缀下
          const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
          if (base && (url.pathname === "/" || url.pathname === "")) {
            return NextResponse.redirect(new URL(base + "/", request.url), 302);
          }
          // Self-exposure forward: switch Host to the loopback target so the
          // request does NOT match a service virtual host again on re-entry
          // (avoids a rewrite loop); the public host is preserved under
          // x-forwarded-host. With allowlocal=false the direct-access gate
          // refuses loopback hosts too — so the forward carries a one-shot
          // proof token (random, server-side only, never seen by the browser)
          // that lets the gate tell this authenticated forward from a raw
          // direct connection.
          if (!getAllowLocal()) {
            url.search = `${url.search ? url.search + "&" : "?"}__piSelfFwd=${issueSelfForwardToken()}`;
          }
          request.headers.set("x-forwarded-host", host);
          // 还原外部 scheme 给 origin 校验:nginx 会带 X-Forwarded-Proto(https),
          // 直连/局域网时补 http;否则 API 的预期 origin 会用内部 http 与
          // 浏览器 https Origin 不匹配。
          request.headers.set("x-forwarded-proto", request.headers.get("x-forwarded-proto") ?? "http");
          request.headers.set("host", `127.0.0.1:${decision.port}`);
        } else {
          // Child-process dev server: keep the public host untouched.
          request.headers.set("host", host);
        }
        return NextResponse.rewrite(url);
      }
      case "redirect":
        return NextResponse.redirect(decision.location, 302);
      case "forward": {
        // 响应注入（同 pipe：service-tunnels transformResponse 语义）——forward 目标含端口
        try {
          const turl = new URL(decision.target);
          const tport = turl.port ? parseInt(turl.port, 10) : 0;
          const snippet = tport ? await aitiInjectSnippet(tport, turl.pathname + turl.search, request.method) : null;
          const resolved = resolveAitiInject(snippet);
          if (resolved) {
            const injected = await aitiInjectHtml(tport, turl.pathname + turl.search, resolved.html, resolved.position);
            if (injected) return injected;
          }
        } catch (err) {
          console.error("[pi-web][aiti-inject] 注入失败，回退普通转发:", err);
        }
        request.headers.set("host", host);
        return NextResponse.rewrite(decision.target);
      }
    }
  }

  // pi-web's own traffic: direct-access gate. With allowlocal=false, requests
  // whose Host is NOT an operator-trusted host (deployment domains / explicit
  // allowHost list) are refused — including LOOPBACK hosts and API paths
  // (防的就是 API,一视同仁). The ONLY exception is a valid self-exposure
  // forward token (pi-web's own vhost→self forward re-entering after Next's
  // external rewrite, the proof rides in the rewrite URL). This is the whole
  // two-phase point: if you have a working authenticated entry you can reach
  // the page/API and confirm (permanent); if you are blocked you cannot — the
  // TTL auto-restores. No API whitelist.
  if (!getAllowLocal()) {
    const hostHeader = (request.headers.get("host") ?? "").toLowerCase();
    const hostname = hostHeader.replace(/^\[|\]$/g, "").split(":")[0];
    const fwdToken = request.nextUrl.searchParams.get("__piSelfFwd");
    const isSelfForward = isValidSelfForwardToken(fwdToken ?? "");
    if (!isSelfForward && !getAllowLocalHosts().includes(hostname)) {
      // 403 统一返回 HTML 自动刷新页:临时封禁每 1s 刷(剩余倒计时实时更新,
      // TTL 到期立即重载);永久封禁每 5s 刷(用户可能重启服务/其他途径解除,
      // 页面自动重试检测,解除后自动恢复)。
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
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d0d0d;color:#e5e5e5}.card{text-align:center;padding:26px 30px;border:1px solid #333;border-radius:10px;max-width:440px;line-height:1.7}code{color:#f87171;background:#1c1c1c;padding:1px 6px;border-radius:4px}strong{color:#f87171}</style></head>
<body><div class="card">
<h3 style="margin-top:0">${title}</h3>
${hint}
</div>
<script>setTimeout(function(){ location.reload(); }, ${refreshSec * 1000});</script>
</body></html>`;
      return new NextResponse(body, {
        status: 403,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        },
      });
    }
  }

  // pi-web's own security gate: DNS-rebinding protection + password. The host
  // allow-list already includes the allowlocal exception hosts (deployment
  // domains + explicit allowHost) via configuredHostnamesFromEnvironment, so
  // operator-protected front domains pass both gates.
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  // 扩展静态资源（/api/extensions/<id>/<file>.<js|html|...>）：script/img 标签 no-cors 加载
  // 跨域无 Origin/Origin:null 时默认门禁会 403——静态资源是公共产物（无敏感数据），放行；
  // 扩展 API（claim/sse/mcp 等，带数据语义）保持门禁（API_ALLOW_ORIGINS 配置放行 + secret 凭证）。
  const isStaticAsset = isApiRequest
    && /^\/api\/extensions\/[^/]+\/[^/]+\.(js|mjs|html|css|json|map)$/.test(request.nextUrl.pathname);
  const isTrustedRequest = isApiRequest
    ? (isStaticAsset || isApiRequestAllowed(request))
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (
    isWebPasswordEnabled(password)
    && !isValidBasicAuthorization(request.headers.get("authorization"), password)
  ) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
      },
    });
  }

  return NextResponse.next();
}

// No matcher: the proxy must see every request so service-host paths (assets,
// SPA routes, /api/* under the virtual host) are intercepted. Non-service
// hosts return NextResponse.next() immediately, so pi-web's own traffic is
// unaffected apart from the existing security gate.
