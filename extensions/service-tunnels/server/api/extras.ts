/**
 * api/extras — P2/P3a 新增域：port-label（用户自定义服务名）、
 * portmap-probe（路由器探测转发）、ipv6-addresses（候选地址转发）。
 * M3 分域：新功能一律走 server/api/ 域文件（handleExtrasApi 先于遗留
 * if 链尝试，null = 非本域 → 继续遗留路由）。
 */
import { getServiceTunnels } from "../integration.ts";
import { listIpv6Addresses, detectPublicIpv6 } from "service-tunnels";
import type { ExtApiContextLike } from "../api.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function handleExtrasApi(req: Request, ctx: ExtApiContextLike): Promise<Response | null> {
  const p = ctx.path || [];
  if (p.length !== 1) return null;
  const st = getServiceTunnels();

  // ── GET /portmap-probe — 路由器 UPnP/NAT-PMP/PCP/CGNAT 探测（P3a probe 按钮）──
  if (p[0] === "portmap-probe" && req.method === "GET") {
    if (typeof st.portmap?.probe !== "function") return json({ error: "portmap not supported by this library version" }, 404);
    try {
      const gateway = ctx.searchParams.get("gateway") ?? undefined;
      const report = await st.portmap.probe({ gateway });
      return json(report as Record<string, unknown>);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  // ── GET /ipv6-addresses — 候选地址（scope 标注）+ 公网出口探测（P3a 下拉）──
  if (p[0] === "ipv6-addresses" && req.method === "GET") {
    try {
      const addresses = listIpv6Addresses();
      // 外呼探测 4s 兜底（受限网络不拖死表单）
      const pub = await Promise.race([
        detectPublicIpv6().catch(() => [] as string[]),
        new Promise<string[]>((r) => setTimeout(() => r([]), 4_000)),
      ]);
      return json({ addresses, public: pub });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  // ── POST /port-label — 用户自定义服务名（P2；daemon 优先，embedded 直写 state）──
  if (p[0] === "port-label" && req.method === "POST") {
    let body: { port?: unknown; label?: unknown } = {};
    try { body = (await req.json()) as typeof body; } catch { /* empty */ }
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return json({ error: "port required (1-65535)" }, 400);
    const label = String(body.label ?? "").trim().slice(0, 80);
    // 0.3.73+ 实例 API st.setServiceLabel：daemon port.label.set 优先，embedded 直写 state（内部封装）
    const setter = (st as { setServiceLabel?: (port: number, label: string) => Promise<{ port: number; label?: string }> }).setServiceLabel;
    if (typeof setter !== "function") {
      return json({ error: "setServiceLabel requires service-tunnels >= 0.3.73" }, 501);
    }
    try {
      await setter.call(st, port, label);
    } catch (err) {
      return json({ error: `label write failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
    return json({ port, label: label || undefined });
  }

  return null;
}
