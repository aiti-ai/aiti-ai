import { NextResponse } from "next/server";
import {
  describeSessionHosting,
  switchSessionHosting,
  HostingError,
  type HostingMode,
} from "@/lib/session/hosting";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET  /api/sessions/[id]/hosting
 *   Read-only hosting snapshot for the chat's agent badge: agent identity,
 *   live/running state, current hosting mode and the switch options.
 *
 * POST /api/sessions/[id]/hosting { mode }
 *   Switch a cold/idle pi session to in-process / subprocess / subprocess-detached.
 *   Running sessions are rejected (the hosting strategy is fixed at spawn time).
 */

function failure(error: unknown): Response {
  const candidate = error as { name?: unknown; status?: unknown; code?: unknown; message?: unknown } | null;
  if (error instanceof HostingError
    || (candidate?.name === "HostingError" && typeof candidate.status === "number" && typeof candidate.code === "string")) {
    return NextResponse.json(
      { ok: false, error: candidate?.message ?? String(error), code: candidate?.code },
      { status: candidate?.status as number },
    );
  }
  return NextResponse.json(
    { ok: false, error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    return NextResponse.json(await describeSessionHosting(id));
  } catch (error) {
    return failure(error);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as { mode?: unknown };
    const mode = body?.mode;
    if (mode !== "in-process" && mode !== "subprocess" && mode !== "subprocess-detached") {
      return NextResponse.json(
        { ok: false, error: "mode must be in-process, subprocess, or subprocess-detached", code: "invalid_mode" },
        { status: 400 },
      );
    }
    return NextResponse.json(await switchSessionHosting(id, mode as HostingMode));
  } catch (error) {
    return failure(error);
  }
}
