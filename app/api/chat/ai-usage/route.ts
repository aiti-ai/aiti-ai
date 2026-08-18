import { NextResponse } from "next/server";
import { aiUsage } from "@/lib/ai-invoke";

export const dynamic = "force-dynamic";

// GET /api/chat/ai-usage —— core 集中记账的 AI 用量（invokeAI 各扩展调用；token 统计基础设施）
// 供既有「统计/看板」类页面接入：按调用扩展聚合 + 明细。
export async function GET() {
  const data = aiUsage(false);
  return NextResponse.json({ ok: true, ...data }, { headers: { "Cache-Control": "no-store" } });
}