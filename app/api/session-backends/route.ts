import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  listProviderInfos,
  createSessionHandle,
  getHandle,
  removeHandle,
  getProvider,
} from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Session backends (multi-agent frontend API).
 *
 * GET  /api/session-backends
 *        → { providers: [{ type, label, maxCapabilities }] }
 * GET  /api/session-backends?provider=<key>
 *        → { ok, provider, models: [...] | null }   # 静态目录（无会话）
 *
 * POST /api/session-backends
 *      body: { providerType: string; sessionFile?: string; cwd?: string;
 *              socketPath?: string; options?: Record<string, unknown> }
 *        → { sessionId, capabilities }
 *      Creates a session through the named provider and stores the handle.
 *
 * DELETE /api/session-backends?id=<sessionId>
 *        → disposes and forgets the handle.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req as never)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // ?provider=<key> → 静态模型目录（新建页选后端时给选择器供数据；无静态目录 →
  // models:null，前端保留本地清单回退）。?refresh=1 → 有 refreshModels 的 provider
  // 强制真实探测（绕过缓存/TTL）；响应带 refreshable（前端据此显隐「刷新模型列表」按钮）。
  const url = new URL(req.url);
  const providerKey = url.searchParams.get("provider");
  if (providerKey) {
    const forceRefresh = url.searchParams.get("refresh") === "1";
    const provider = getProvider(providerKey);
    if (!provider) return NextResponse.json({ error: `unknown provider "${providerKey}"` }, { status: 404 });
    const refreshable = typeof provider.refreshModels === "function";
    const loader = forceRefresh && refreshable ? provider.refreshModels?.() : provider.listModels?.();
    if (!loader) return NextResponse.json({ ok: true, provider: providerKey, models: null, refreshable });
    try {
      return NextResponse.json({ ok: true, provider: providerKey, models: await loader, refreshable });
    } catch (e) {
      return NextResponse.json(
        { ok: false, provider: providerKey, error: e instanceof Error ? e.message : String(e), refreshable },
        { status: 502 },
      );
    }
  }
  const infos = await Promise.all(
    listProviderInfos().map(async (p) => {
      let profiles: Array<{ name: string; path: string }> | undefined;
      try {
        profiles = (await getProvider(p.type)?.listProfiles?.()) ?? undefined;
      } catch { /* provider-specific scan failure → no profiles */ }
      return { ...p, ...(profiles ? { profiles } : {}) };
    }),
  );
  return NextResponse.json({ providers: infos });
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req as never)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const body = await req.json() as {
      providerType?: string;
      sessionFile?: string;
      cwd?: string;
      socketPath?: string;
      options?: Record<string, unknown>;
    };
    if (!body.providerType) {
      return NextResponse.json({ error: "providerType is required" }, { status: 400 });
    }
    if (!body.sessionFile && !body.cwd) {
      return NextResponse.json(
        { error: "sessionFile or cwd is required" },
        { status: 400 },
      );
    }

    const handle = await createSessionHandle({
      providerType: body.providerType,
      ...(body.sessionFile ? { sessionFile: body.sessionFile } : {}),
      ...(body.cwd ? { cwd: body.cwd } : {}),
      ...(body.socketPath ? { socketPath: body.socketPath } : {}),
      ...(body.options ?? {}),
    });

    return NextResponse.json({
      success: true,
      sessionId: handle.id,
      source: handle.source,
      capabilities: handle.capabilities,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req as never)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const handle = getHandle(id);
  if (!handle) return NextResponse.json({ error: "not found" }, { status: 404 });
  await handle.dispose();
  removeHandle(id);
  return NextResponse.json({ success: true });
}
