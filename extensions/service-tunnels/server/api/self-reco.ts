/**
 * api/self-reco —— 「手机访问」只读探测端点（方案 §3.2）。
 *
 * 候选装配（fail-closed：不满足条件的候选整条不出现或标 unavailable）：
 *   - vhost  部署域名已配置（getBaseDomains 非 IP）→ mode proxy + portal（推荐）
 *   - tunnel cloudflared/ngrok/frpc 任一可用（toolStatus source 非 null）→ 次选
 *   - lan    非回环 IPv4 接口 ∧ 该 IP:port TCP 可连（500ms 一次连接）∧ allowLocal
 *   - portmap/ipv6  仅 ?deep=1（「换个方案」清单展开时才跑网络 IO），30s 缓存
 *
 * 零敏感字段（不回密码/模板向量/隧道 token）。TCP 探测一次性连接（非轮询），
 * 进程内缓存 30s。本文件不做任何写操作——暴露/建号/门禁全部走既有 action。
 */
import { connect as tcpConnect } from "node:net";
import { networkInterfaces } from "node:os";
import { getServiceTunnels, getSelfExposeState } from "../integration.ts";
import { getBaseDomains, getAllowLocal } from "../proxy-shared.ts";
import type { ExtApiContextLike } from "../api.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// ---- 本地 TCP 可连探测缓存（30s；键 ip:port）----
const tcpProbeCache = new Map<string, { at: number; ok: boolean }>();
function probeTcp(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  const key = `${host}:${port}`;
  const hit = tcpProbeCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return Promise.resolve(hit.ok);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      tcpProbeCache.set(key, { at: Date.now(), ok });
      // 缓存防膨胀：只留最近 32 条
      if (tcpProbeCache.size > 32) {
        const first = tcpProbeCache.keys().next().value;
        if (first !== undefined) tcpProbeCache.delete(first);
      }
      resolve(ok);
    };
    const sock = tcpConnect({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => { sock.destroy(); done(true); });
    sock.once("timeout", () => { sock.destroy(); done(false); });
    sock.once("error", () => { sock.destroy(); done(false); });
  });
}

/** 非回环 IPv4 接口清单（名 + 地址）。 */
function lanAddresses(): Array<{ name: string; address: string }> {
  const out: Array<{ name: string; address: string }> = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && a.address) out.push({ name, address: a.address });
    }
  }
  return out;
}

/** 隧道工具可用性（source 非 null = 本机可用；与 PortsTab 缺工具提示同一判据）。 */
function tunnelTools(toolStatus: unknown): { available: boolean; names: string[] } {
  const list = Array.isArray(toolStatus) ? toolStatus as Array<{ name?: string; source?: unknown }> : [];
  const wanted = ["cloudflared", "ngrok", "frpc"];
  const names = list.filter((t) => t?.name && wanted.includes(t.name) && (t.source ?? null) !== null).map((t) => t.name as string);
  return { available: names.length > 0, names };
}

/** 部署域名（剔 IP 字面量后；getBaseDomains 已剔，这里再兜一层）。 */
function baseDomains(): string[] {
  return getBaseDomains().filter((d) => {
    const host = d.replace(/:\d{1,5}$/, "");
    return host && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.includes(":");
  });
}

/** 预期 vhost 入口（未暴露时构造；暴露中则以既有 authEntry 地址为准）。
 *  库实证 proxy-manager.ts:293 `vhost(port,label) = ${port}-${label}.${suffix}`，
 *  baseVhost 保留域端口（host:port）；label = "pi-web"。 */
function expectedVhostUrl(port: number): string | null {
  const basePath = (process.env.PI_WEB_BASE_PATH ?? "").replace(/\/+$/, "");
  const dom = baseDomains()[0];
  if (!dom) return null;
  return `http://${port}-pi-web.${dom}${basePath}`;
}

interface RecoCandidate {
  id: string;
  available: boolean;
  recommended?: boolean;
  risk?: boolean;
  mode?: string;
  auth?: string;
  tunnel?: string | null;
  tunnelOptions?: string[];
  url?: string | null;
  https?: boolean;
  badges?: string[];
  reason?: string | null;
}

export async function handleSelfRecoApi(
  req: Request,
  ctx: ExtApiContextLike,
  helpers?: { toolStatus?: () => unknown },
): Promise<Response | null> {
  const p = ctx.path || [];
  if (p[0] !== "self-reco") return null;
  if (req.method !== "GET") return json({ error: "GET only" }, 405);

  const st = getServiceTunnels();
  const deep = ctx.searchParams?.get("deep") === "1";
  const self = getSelfExposeState();
  const port = self.port;
  const basePath = (process.env.PI_WEB_BASE_PATH ?? "").replace(/\/+$/, "");
  const domains = baseDomains();
  const allowLocal = getAllowLocal();

  // ---- portal×pi-web 用户有无（决定 S2 首次表单是否要建号）----
  let hasUsers = false;
  try {
    const users = await (st.auth as { users?: (provider?: string, site?: string) => Promise<Array<{ provider: string; users?: unknown[] }>> })
      .users?.("portal", "pi-web");
    hasUsers = (users ?? []).some((e) => e.provider === "portal" && (e.users?.length ?? 0) > 0);
  } catch { /* basic-only 等场景：portal 用户查询失败按无用户处理 */ }

  // ---- 已暴露通道（authEntry / noAuth 分型；不新开不停旧）----
  const liveChannels = self.urls.filter((u) => u.authEntry);
  const candidates: RecoCandidate[] = [];

  // ① vhost —— 部署域名已配置（推荐）。URL 用 baseVhost 形态（域名含端口，
  //  proxy-manager.ts:300 baseVhost = ${port}-${label}.${baseDomain}），方案示例同款；
  //  本机专用后缀（.pi.localhost）手机解析不了，不作为出码依据（G2：只报真能用的）。
  if (domains.length > 0) {
    const existing = liveChannels.find((u) => u.labelKey?.includes("vhost"));
    const url = existing?.url ?? expectedVhostUrl(port) ?? null;
    candidates.push({
      id: "vhost",
      available: true,
      recommended: true,
      mode: "proxy",
      auth: "portal",
      tunnel: null,
      url,
      https: url?.startsWith("https://") === true,
      badges: ["password-only", "any-network"],
      reason: null,
    });
  }

  // ② tunnel —— a tunnel tool exists on this machine (2nd choice, costs
  //  labeled). tunnelOptions lists every usable tool (trycloudflare.com is
  //  occasionally unreachable → user can switch to ngrok/frpc); the tunnel
  //  field remains the default recommendation (cloudflared first).
  const tools = tunnelTools(helpers?.toolStatus?.());
  if (tools.available) {
    const existing = liveChannels.find((u) => u.tunnel);
    candidates.push({
      id: "tunnel",
      available: true,
      mode: "tunnel",
      auth: "portal",
      tunnel: tools.names.includes("cloudflared") ? "cloudflared" : tools.names[0],
      tunnelOptions: tools.names,
      url: existing?.url ?? null,
      https: existing?.url?.startsWith("https://") === true,
      badges: ["password-only", "any-network", "third-party", "url-changes", "rate-limit"],
      reason: null,
    });
  }

  // ③ lan —— 局域网直连（唯一无认证候选；只在清单出现，永不推荐）
  const lans = lanAddresses();
  if (lans.length > 0) {
    let reachable = false;
    let lanUrl: string | null = null;
    for (const a of lans) {
      const url = `http://${a.address}:${port}${basePath}`;
      if (!reachable && allowLocal && (await probeTcp(a.address, port))) {
        reachable = true;
        lanUrl = url;
      }
    }
    if (reachable && allowLocal) {
      candidates.push({
        id: "lan",
        available: true,
        risk: true,
        auth: "none",
        url: lanUrl,
        badges: ["no-auth", "same-wifi"],
        reason: null,
      });
    } else if (!allowLocal) {
      candidates.push({ id: "lan", available: false, risk: true, auth: "none", reason: "allowlocal-off" });
    } else {
      candidates.push({ id: "lan", available: false, risk: true, auth: "none", reason: "binding-local-only" });
    }
  } else {
    candidates.push({ id: "lan", available: false, risk: true, auth: "none", reason: "no-nonloopback-if" });
  }

  // ④ portmap / ipv6 —— 仅 deep（清单展开）时探测（网络 IO，不进首屏）
  if (deep) {
    const caps = st as unknown as {
      portmap?: { probe?: () => Promise<{ supported?: boolean; reason?: string } | null> };
      ipv6?: { detect?: () => Promise<string[]> };
    };
    try {
      const pm = await caps.portmap?.probe?.();
      candidates.push(pm?.supported
        ? { id: "portmap", available: true, mode: "portmap", auth: "portal", badges: ["password-only", "any-network"], reason: null }
        : { id: "portmap", available: false, reason: pm?.reason === "no-upnp" ? "gateway-no-upnp" : (pm?.reason ?? "gateway-no-upnp") });
    } catch {
      candidates.push({ id: "portmap", available: false, reason: "gateway-no-upnp" });
    }
    try {
      const v6 = await caps.ipv6?.detect?.();
      const usable = (v6 ?? []).filter((a) => a && !a.startsWith("fe80") && !a.startsWith("fc") && !a.startsWith("fd"));
      candidates.push(usable.length > 0
        ? { id: "ipv6", available: true, mode: "ipv6", auth: "portal", url: `http://[${usable[0]}]:${port}${basePath}`, badges: ["password-only", "any-network"], reason: null }
        : { id: "ipv6", available: false, reason: "no-global-ipv6" });
    } catch {
      candidates.push({ id: "ipv6", available: false, reason: "no-global-ipv6" });
    }
  } else {
    candidates.push({ id: "portmap", available: false, reason: "deep-only" });
    candidates.push({ id: "ipv6", available: false, reason: "deep-only" });
  }

  // ---- 推荐：第一个 available 且非 risk（lan/portmap/ipv6 永不推荐，Q2 已定）----
  const safe = candidates.find((c) => c.available && !c.risk);
  for (const c of candidates) c.recommended = c === safe;

  // ---- fail-closed：一个安全候选都没有 → recommended:null（S6 左由客户端渲染）----
  const absent: Array<{ id: string; reason: string }> = [];
  if (domains.length === 0) absent.push({ id: "vhost-hint", reason: "no-base-domain" });
  if (!tools.available) absent.push({ id: "tunnel-hint", reason: "no-tool" });

  return json({
    port,
    candidates,
    absent,
    hasUsers,
    site: "pi-web",
    self: {
      exposing: self.exposing,
      unauthenticated: self.unauthenticated,
      channels: liveChannels.map((u) => ({ url: u.url, labelKey: u.labelKey ?? null, tunnel: u.tunnel ?? null, exposeName: u.exposeName ?? null, noAuth: u.noAuth ?? false })),
    },
  });
}
