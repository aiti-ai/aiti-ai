import { NextResponse } from "next/server";
import { aiUsage } from "@/lib/ai-invoke";

export const dynamic = "force-dynamic";

// GET /api/chat/ai-usage —— core 集中记账的 AI 用量（invokeAI 各扩展调用；token 统计基础设施）
// 供既有「统计/看板」类页面接入：按调用扩展聚合 + 明细。
// ?session=<id> —— 只统计该会话的调用（响应另附 global = 全部会话累计，便于区分口径）。
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("session") || undefined;
  const data = aiUsage(false, sessionId);
  return NextResponse.json({ ok: true, ...data }, { headers: { "Cache-Control": "no-store" } });
}
