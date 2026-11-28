import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { queryUsageOverview } from "@/lib/provider-usage";

export const dynamic = "force-dynamic";

// Overview: configured + adaptable providers, queried concurrently with a
// process-level TTL cache. `force: true` bypasses the cache (manual refresh).

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  let force = false;
  if (hasJsonContentType(request)) {
    try {
      const body = await request.json() as { force?: unknown };
      force = body?.force === true;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
  }
  try {
    const overview = await queryUsageOverview(force);
    return NextResponse.json(overview);
  } catch {
    return NextResponse.json({ capturedAt: Date.now(), providers: [] }, { status: 200 });
  }
}
