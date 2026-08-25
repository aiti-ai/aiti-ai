import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getHandle } from "@/lib/session";
import { UnsupportedCapabilityError } from "@/lib/session/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Per-handle command route for provider-created sessions.
 *
 * GET /api/session-backends/[id]
 *        → { sessionId, source, capabilities, running, alive, model }
 *
 * POST /api/session-backends/[id]
 *      body: one action at a time —
 *        { action: "prompt", text, images?, streamingBehavior? }
 *        { action: "abort" }
 *        { action: "steer", text }            (capability-gated)
 *        { action: "follow_up", text }
 *        { action: "get_messages" }
 *        { action: "set_model", provider, modelId }
 *        { action: "set_thinking_level", level }
 *        { action: "rename_session", name }
 *        { action: "compact", customInstructions? }
 *        { action: "get_commands" }
 *        → { success: true, data? }
 *
 * Unsupported capability → 501 with the typed error payload; UI checks
 * `capabilities` up front and hides these controls.
 */
export async function GET(req: Request, ctx: Params) {
  if (!isApiRequestAllowed(req as never)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const handle = getHandle(id);
  if (!handle) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    sessionId: handle.id,
    source: handle.source,
    capabilities: handle.capabilities,
    running: handle.isRunning(),
    alive: handle.alive(),
    model: handle.getModel() ?? null,
  });
}

export async function POST(req: Request, ctx: Params) {
  if (!isApiRequestAllowed(req as never)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const handle = getHandle(id);
  if (!handle) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const action = String(body.action ?? "");
  try {
    switch (action) {
      case "prompt": {
        const text = body.text;
        if (typeof text !== "string") {
          return NextResponse.json({ error: "text is required" }, { status: 400 });
        }
        await handle.prompt(text, {
          ...(Array.isArray(body.images)
            ? { images: body.images as never[] }
            : {}),
          ...(Array.isArray(body.files)
            ? { files: body.files as never[] }
            : {}),
          ...(body.streamingBehavior === "steer" || body.streamingBehavior === "followUp"
            ? { streamingBehavior: body.streamingBehavior }
            : {}),
        });
        return NextResponse.json({ success: true });
      }
      case "abort":
        await handle.abort();
        return NextResponse.json({ success: true });
      case "steer": {
        if (!handle.steer) throw new UnsupportedCapabilityError("steer", handle.source);
        await handle.steer(String(body.text ?? ""));
        return NextResponse.json({ success: true });
      }
      case "follow_up": {
        if (!handle.followUp) throw new UnsupportedCapabilityError("followUp", handle.source);
        await handle.followUp(String(body.text ?? ""));
        return NextResponse.json({ success: true });
      }
      case "get_messages": {
        if (!handle.getMessages) throw new UnsupportedCapabilityError("getMessages", handle.source);
        return NextResponse.json({ success: true, data: await handle.getMessages() });
      }
      case "set_model": {
        if (!handle.setModel) throw new UnsupportedCapabilityError("setModel", handle.source);
        const ok = await handle.setModel({
          provider: String(body.provider ?? ""),
          id: String(body.modelId ?? ""),
        });
        return NextResponse.json({ success: ok });
      }
      case "set_thinking_level": {
        if (!handle.setThinkingLevel) throw new UnsupportedCapabilityError("setThinkingLevel", handle.source);
        handle.setThinkingLevel(String(body.level ?? "off"));
        return NextResponse.json({ success: true });
      }
      case "rename_session": {
        if (!handle.setSessionName) throw new UnsupportedCapabilityError("renameSession", handle.source);
        handle.setSessionName(String(body.name ?? ""));
        return NextResponse.json({ success: true });
      }
      case "compact": {
        if (!handle.compact) throw new UnsupportedCapabilityError("compact", handle.source);
        const data = await handle.compact(
          typeof body.customInstructions === "string" ? body.customInstructions : undefined,
        );
        return NextResponse.json({ success: true, data });
      }
      case "get_commands": {
        if (!handle.getCommands) throw new UnsupportedCapabilityError("getCommands", handle.source);
        return NextResponse.json({ success: true, data: await handle.getCommands() });
      }
      case "permission_response": {
        if (!handle.respondPermission) throw new UnsupportedCapabilityError("respondPermission", handle.source);
        const ok = await handle.respondPermission(String(body.requestId ?? ""), {
          behavior: body.behavior === "allow" ? "allow" : "deny",
          ...(body.updatedInput ? { updatedInput: body.updatedInput as Record<string, unknown> } : {}),
          ...(typeof body.message === "string" ? { message: body.message } : {}),
        });
        return NextResponse.json({ success: ok });
      }
      case "get_usage": {
        if (!handle.getUsage) throw new UnsupportedCapabilityError("getUsage", handle.source);
        return NextResponse.json({ success: true, data: (await handle.getUsage()) ?? null });
      }
      case "list_models": {
        if (!handle.getAvailableModels) throw new UnsupportedCapabilityError("listModels", handle.source);
        return NextResponse.json({ success: true, data: await handle.getAvailableModels() });
      }
      case "set_permission_mode": {
        if (!handle.setPermissionMode) throw new UnsupportedCapabilityError("setPermissionMode", handle.source);
        const ok = await handle.setPermissionMode(String(body.mode ?? ""));
        return NextResponse.json({ success: ok });
      }
      default:
        return NextResponse.json({ error: `unknown action "${action}"` }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof UnsupportedCapabilityError) {
      // 501 Not Implemented semantics: backend exists but lacks this feature.
      return NextResponse.json(
        { error: e.message, code: "unsupported_capability", capability: e.capability },
        { status: 501 },
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
