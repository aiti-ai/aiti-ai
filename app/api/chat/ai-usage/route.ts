import { NextResponse } from "next/server";
import { aiUsage } from "@/lib/ai-invoke";

export const dynamic = "force-dynamic";

// GET /api/chat/ai-usage — AI usage centrally accounted by the core (invokeAI calls by
// extensions; token accounting infrastructure).
// For existing "stats/dashboard" pages to integrate: aggregated by calling extension + details.
// ?session=<id> — only counts calls of that session (the response also includes global =
// cumulative across all sessions, to distinguish scopes).
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("session") || undefined;
  const data = aiUsage(false, sessionId);
  return NextResponse.json({ ok: true, ...data }, { headers: { "Cache-Control": "no-store" } });
}
