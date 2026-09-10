import { hasTerminal, subscribeTerminal } from "@/lib/terminal-manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/terminal/[id]/buffered?after=N —— 终端总线订阅快照。
//
// 页面事件唯一 SSE 收敛后（lib/event-bus-client.ts getEventBus），走总线的终端
// 订阅方拿不到原 SSE route 的「建连即回放」帧，改按 aiti-cmd 高频流范式：
// 先订阅（bus topics ready）后拉本快照，再以 offset（seq）去重实时帧——
// 无缝无重复，断线重连后重拉快照补丢失段。
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!hasTerminal(id)) return new Response("Terminal not found", { status: 404 });
  const cursor = req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after");
  const after = cursor !== null && /^\d+$/.test(cursor) && Number.isSafeInteger(Number(cursor))
    ? Number(cursor) : undefined;

  // 复用 subscribeTerminal 的一次性回放能力：空 listener 挂上即取 output 快照，
  // 立即 unsubscribe（scheduleCleanup 恢复空闲回收计时）。
  const sub = subscribeTerminal(id, () => {}, after);
  if (!sub) return new Response("Terminal not found", { status: 404 });
  sub.unsubscribe();

  return Response.json(
    { output: sub.output, exited: sub.exited, exitCode: sub.exitCode },
    { headers: { "Cache-Control": "no-store" } },
  );
}
