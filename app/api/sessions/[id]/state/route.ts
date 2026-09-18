import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveAnySession, attachIfBridged } from "@/lib/session";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRegistry } from "@/lib/ext/registry";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // 桥占用识别最先（同上）
    {
      const fp = await resolveSessionPath(id);
      if (fp) {
        let bridged;
        try {
          bridged = await attachIfBridged(fp);
        } catch (e) {
          if ((e as { name?: string }).name === "BridgeOccupiedError") {
            return NextResponse.json({ error: String(e), code: "session_bridged_unreachable" }, { status: 409 });
          }
          throw e;
        }
        if (bridged?.isAlive()) {
          const state = await bridged.send({ type: "get_state" }).catch(() => null);
          return NextResponse.json({ running: true, state, bridged: true });
        }
      }
    }
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      const state = await rpc.send({ type: "get_state" });
      return NextResponse.json({ running: true, state });
    }

    // Backend (provider-handle) sessions: state via the wrapper adapter.
    const wrapped = resolveAnySession(id);
    if (wrapped?.isAlive()) {
      const state = (await wrapped.send({ type: "get_state" })) as Record<string, unknown> | null;
      return NextResponse.json({
        running: true,
        state: {
          ...(state ?? {}),
          // 能力声明透传给前端（capability-aware 控件渲染）
          capabilities: (wrapped as { handle?: { capabilities?: unknown } }).handle
            ?.capabilities ?? (wrapped as unknown as { capabilities?: unknown }).capabilities,
          backendSource: wrapped.source,
        },
      });
    }

    // 休眠兜底（任务列表等只读快照）——置于 404 之前：后端复合 id（"<agentKey>:<sid>"）
    // 无本地 session path，404 守卫对它恒真，兜底必须先于它执行。后端扩展可 provide
    // "<extId>.sessionDormantState" (compositeId) => Promise<{tasks?: ...} | null>（字段名与
    // AgentStateResponse wire 对齐；aiti-zcode-agent 实现 = <stateDir>/task-lists/<sid>.json
    // 最近任务快照）。首个非空应答并入 state；全缺席 → 照旧 404/running:false。
    let dormantState: Record<string, unknown> | null = null;
    try {
      const services = getRegistry().services;
      for (const entry of services.list()) {
        if (!entry.key.endsWith(".sessionDormantState")) continue;
        const impl = services.get<(compositeId: string) => Promise<Record<string, unknown> | null>>(entry.key);
        if (typeof impl !== "function") continue;
        const res = await impl(id).catch(() => null);
        if (res && typeof res === "object") { dormantState = res; break; }
      }
    } catch { /* registry 未 bootstrap 等：降级为无数据 */ }
    if (dormantState) {
      return NextResponse.json({ running: false, state: dormantState });
    }
    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ running: false });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
