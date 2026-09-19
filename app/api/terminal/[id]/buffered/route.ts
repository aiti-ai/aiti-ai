import { hasTerminal, subscribeTerminal } from "@/lib/terminal-manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/terminal/[id]/buffered?after=N — terminal bus subscription snapshot.
//
// After page events converged onto the single SSE bus (lib/event-bus-client.ts
// getEventBus), terminal subscribers on the bus no longer get the original SSE
// route's "replay on connect" frames; instead they follow the cmd high-frequency
// stream pattern: subscribe first (bus topics ready), then fetch this snapshot,
// then dedupe live frames by offset (seq) — seamless, no duplicates; after a
// reconnect, re-fetch the snapshot to fill the lost segment.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!hasTerminal(id)) return new Response("Terminal not found", { status: 404 });
  const cursor = req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after");
  const after = cursor !== null && /^\d+$/.test(cursor) && Number.isSafeInteger(Number(cursor))
    ? Number(cursor) : undefined;

  // Reuse subscribeTerminal's one-shot replay capability: attach an empty listener to grab the
  // output snapshot, then unsubscribe immediately (scheduleCleanup restores the idle reclaim timer).
  const sub = subscribeTerminal(id, () => {}, after);
  if (!sub) return new Response("Terminal not found", { status: 404 });
  sub.unsubscribe();

  return Response.json(
    { output: sub.output, exited: sub.exited, exitCode: sub.exitCode },
    { headers: { "Cache-Control": "no-store" } },
  );
}
