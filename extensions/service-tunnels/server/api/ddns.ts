/**
 * api/ddns — P3b 域：DDNS registry 管理（provider 凭据 / profiles / 注册
 * 条目）+ provider 枚举。薄转发库根导出 readRegistryConfig/writeRegistryConfig
 * （0.3.70 起提升根导出；与库自带 UI / CLI 同一 registry 文件）——双开互查
 * （方案 §8 P3b 判据）。旧版依赖（<0.3.70）缺根导出时该域 500 由调用方降级。
 */
import { getServiceTunnels } from "../integration.ts";
import { DDNS_PROVIDERS, readRegistryConfig, writeRegistryConfig } from "service-tunnels";
import type { ExtApiContextLike } from "../api.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function handleDdnsApi(req: Request, ctx: ExtApiContextLike): Promise<Response | null> {
  const p = ctx.path || [];
  if (p.length !== 1) return null;
  const st = getServiceTunnels();

  // GET /ddns-registry — 全量 registry（providerProfiles/profiles/entries）
  if (p[0] === "ddns-registry" && req.method === "GET") {
    try {
      return json(readRegistryConfig(st.dirs.configDir) as Record<string, unknown>);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  // POST /ddns-registry — 全量保存（形状校验：400 不 500，方案 §7）
  if (p[0] === "ddns-registry" && req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "registry object required" }, 400);
    }
    for (const key of ["providerProfiles", "profiles", "entries"]) {
      const v = body[key];
      if (v === undefined) continue;
      if (key === "entries") {
        if (!Array.isArray(v)) return json({ error: "entries must be an array" }, 400);
      } else if (!v || typeof v !== "object" || Array.isArray(v)) {
        return json({ error: `${key} must be an object` }, 400);
      }
    }
    try {
      writeRegistryConfig(st.dirs.configDir, body as never);
      return json({ saved: true });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  }

  // GET /ddns-providers — 120 家枚举（下拉）
  if (p[0] === "ddns-providers" && req.method === "GET") {
    return json({ providers: DDNS_PROVIDERS });
  }

  return null;
}
