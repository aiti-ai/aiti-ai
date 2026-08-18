import { NextResponse } from "next/server";
import { completeInput, type CompleteInputRequest } from "@/lib/input-complete";

export const dynamic = "force-dynamic";

// POST /api/chat/complete-input —— AI 输入行内自动补全（逐句续写）
// body: { provider?, input, history?, ctx? }
// 独立干净 runtime（不落盘、不碰会话上下文）；模型 = provider 内低配（非推理优先）。
// 见 docs/aiti-input-autocomplete-plan.md（aiti-ai-input 扩展服务端调用）
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Partial<CompleteInputRequest>;
    const input = typeof body.input === "string" ? body.input.trim() : "";
    if (!input) {
      return NextResponse.json({ error: "empty-input" }, { status: 400 });
    }
    const request: CompleteInputRequest = {
      provider: typeof body.provider === "string" && body.provider ? body.provider : undefined,
      cwd: typeof body.cwd === "string" && body.cwd ? body.cwd : undefined,
      mode: body.mode === "voice-fix" ? "voice-fix" : undefined,
      input,
      history: Array.isArray(body.history) ? body.history.filter((h): h is string => typeof h === "string") : undefined,
      ctx: body.ctx === "small" || body.ctx === "large" ? body.ctx : body.ctx === "medium" ? "medium" : undefined,
    };
    const result = await completeInput(request);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof Error && (
      error.message === "no-provider" ||
      error.message.startsWith("provider-not-found") ||
      error.message.startsWith("no-models") ||
      error.message === "model-not-found"
    ) ? 400 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}