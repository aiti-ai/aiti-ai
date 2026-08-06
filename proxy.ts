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

  // Service virtual hosts: the library's in-process decision API (parse,
  // enrollment, per-site auth backends, forward-auth probe, login redirect)
  // runs HERE — no separate proxy port, one public port. Next then forwards
  // the request (rewrite target) or answers 403/302/401.
  if (host && st?.proxy?.parseHost(host)) {
    let decision: Awaited<ReturnType<typeof st.proxy.resolve>>;
    try {
      decision = await st.proxy.resolve({
        host,
        url: request.nextUrl.pathname + request.nextUrl.search,
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
        const url = new URL(`http://127.0.0.1:${decision.port}`);
        url.pathname = decision.url.split("?")[0] ?? "/";
        url.search = decision.url.includes("?") ? `?${decision.url.split("?")[1]}` : "";
        if (decision.port === getPiWebPort()) {
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
          request.headers.set("host", `127.0.0.1:${decision.port}`);
        } else {
          // Child-process dev server: keep the public host untouched.
          request.headers.set("host", host);
        }
        return NextResponse.rewrite(url);
      }
      case "redirect":
        return NextResponse.redirect(decision.location, 302);
      case "forward":
        request.headers.set("host", host);
        return NextResponse.rewrite(decision.target);
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
      // 临时 block(两阶段关闭中)提示剩余恢复时间,永久 block 保持原文案
      const pending = getAllowLocalPending();
      const remain = pending.pending ? Math.max(0, Math.ceil((pending.expiresAt - Date.now()) / 1000)) : 0;
      if (pending.pending) {
        // 临时封禁:返回 HTML 页面,meta refresh + JS 双保险——TTL 到期自动恢复后
        // 浏览器自动重载,无需手动 F5;永久封禁不自动刷新(避免死循环)
        const refreshSec = Math.max(1, remain);
        const title = "访问被拒绝";
        const body = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="${refreshSec}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d0d0d;color:#e5e5e5}.card{text-align:center;padding:26px 30px;border:1px solid #333;border-radius:10px;max-width:440px;line-height:1.7}code{color:#f87171;background:#1c1c1c;padding:1px 6px;border-radius:4px}strong{color:#f87171}</style></head>
<body><div class="card">
<h3 style="margin-top:0">${title}</h3>
<p>本地直连已禁用（<code>allowlocal=false</code>）</p>
<p>临时封禁 <strong>${remain}s</strong> 后自动恢复，页面将自动刷新…</p>
</div>
<script>setTimeout(function(){ location.reload(); }, ${(remain + 1) * 1000});</script>
</body></html>`;
        return new NextResponse(body, {
          status: 403,
          headers: {
            "cache-control": "no-store",
            "content-type": "text/html; charset=utf-8",
          },
        });
      }
      const msg = `访问被拒绝：本地直连已禁用（allowlocal=false）`;
      return new NextResponse(msg, {
        status: 403,
        headers: { "cache-control": "no-store" },
      });
    }
  }

  // pi-web's own security gate: DNS-rebinding protection + password. The host
  // allow-list already includes the allowlocal exception hosts (deployment
  // domains + explicit allowHost) via configuredHostnamesFromEnvironment, so
  // operator-protected front domains pass both gates.
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
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
