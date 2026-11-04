/**
 * api/doctor — P4 域：网络体检（netcheck）事件流（Fetch Response SSE）。
 *
 * 契约与库 UI（service-tunnels ui-doctor.ts）同构：job 单例 409 / SSE
 * Last-Event-ID 环形缓冲 500 续传 / 心跳 20s / 连接上限 8→503。事件渲染走
 * 共享层 netcheckEventView（ui.doctor.ev.<type> 键）。
 *
 * 事件源：st.netcheck.run 存在即真实接入；未实现走 mock 序列，且 mock 仅在
 * ST_UI_DOCTOR_MOCK=1 时开放（/status capabilities.netcheck 同步点亮）——
 * 生产默认隐藏 Doctor tab，库实现落地零改动切换。
 */
import { getServiceTunnels } from "../integration.ts";
import type { ExtApiContextLike } from "../api.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export type DoctorEvent = { type: string } & Record<string, unknown>;

interface Hub {
  start(opts?: { mode?: string }): { started: boolean; mock: boolean } | "conflict";
  stop(): void;
  subscribe(controller: ReadableStreamDefaultController<Uint8Array>, signal: AbortSignal, lastEventId: string): boolean;
  running(): boolean;
}

const MAX_SUBSCRIBERS = 8;
const MAX_BUFFER = 500;
const HEARTBEAT_MS = 20_000;
const g = globalThis as { __stDoctorHub?: Hub };

export function doctorMockEnabled(): boolean {
  return process.env.ST_UI_DOCTOR_MOCK === "1";
}

export function doctorAvailable(): boolean {
  const st = getServiceTunnels() as unknown as { netcheck?: { run?: unknown } };
  return typeof st?.netcheck?.run === "function" || doctorMockEnabled();
}

function createHub(): Hub {
  const buffer: Array<{ id: number; ev: DoctorEvent }> = [];
  const subs = new Set<{ write(frame: string): void; close(): void }>();
  let seq = 0;
  let running = false;
  let cancelled = false;

  const emit = (ev: DoctorEvent): void => {
    seq += 1;
    buffer.push({ id: seq, ev });
    if (buffer.length > MAX_BUFFER) buffer.shift();
    const frame = `id: ${seq}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const s of subs) {
      try { s.write(frame); } catch { subs.delete(s); }
    }
  };

  const enc = () => new TextEncoder();
  const writer = (controller: ReadableStreamDefaultController<Uint8Array>) => ({
    write(frame: string) { controller.enqueue(enc().encode(frame)); },
    close() { try { controller.close(); } catch { /* already closed */ } },
  });

  async function runMock(): Promise<void> {
    const events: DoctorEvent[] = [
      { type: "phase-start", phase: "A", label: "Environment", total: 3 },
      { type: "probe-done", probeId: "a2", item: "Egress IPv4", verdict: "ok", ok: true, ms: 120 },
      { type: "probe-done", probeId: "a3", item: "Egress IPv6", verdict: "unavailable", ok: false, ms: 80 },
      { type: "probe-done", probeId: "a9", item: "Gateway UPnP", verdict: "ok", ok: true, ms: 900 },
      { type: "phase-end", phase: "A", summary: "3 probes" },
      { type: "advice-update", advice: mockAdvice(false), basis: "probe", note: "initial (probes only)" },
      { type: "phase-start", phase: "C", label: "Live tests", total: 2 },
      { type: "tunnel-est", provider: "serveo", url: "https://example.serveo.net", ms: 3200 },
      { type: "channel-result", provider: "serveo", channel: "check-host", level: "E1", ok: true, ms: 90 },
      { type: "verdict-confirmed", provider: "serveo", verdict: "E1+", confirmed: true, sourcesOk: 2 },
      { type: "tunnel-est", provider: "localtunnel", url: "https://example.loca.lt", ms: 1800 },
      { type: "tunnel-fail", provider: "bore", error: "connect timeout", ms: 30_000 },
      { type: "advice-update", advice: mockAdvice(true), basis: "live", note: "after live tests" },
      { type: "phase-end", phase: "C", summary: "2/3 providers usable" },
      { type: "summary", report: mockReport(), text: "netcheck report (mock)", markdown: "# Netcheck report (mock)\n" },
      { type: "done", report: mockReport() },
    ];
    for (const ev of events) {
      if (cancelled) {
        emit({ type: "cancelled" });
        running = false;
        return;
      }
      emit(ev);
      await new Promise((r) => setTimeout(r, 200));
    }
    running = false;
  }

  return {
    start(opts) {
      if (running) return "conflict";
      running = true;
      cancelled = false;
      const st = getServiceTunnels() as unknown as { netcheck?: { run(opts: { mode?: string }, cb: (ev: DoctorEvent) => void): Promise<unknown> } };
      if (st?.netcheck && typeof st.netcheck.run === "function") {
        st.netcheck
          .run({ mode: opts?.mode === "full" ? "full" : "quick" }, emit)
          .catch((e) => emit({ type: "error", message: String(e) }))
          .finally(() => { running = false; });
        return { started: true, mock: false };
      }
      void runMock();
      return { started: true, mock: true };
    },
    stop() {
      if (running) cancelled = true;
    },
    subscribe(controller, signal, lastEventId): () => void {
      if (subs.size >= MAX_SUBSCRIBERS) return null;
      const sub = writer(controller);
      const timer = setInterval(() => {
        try { sub.write(": hb\n\n"); } catch { cleanup(); }
      }, HEARTBEAT_MS);
      const cleanup = () => {
        clearInterval(timer);
        subs.delete(sub2);
      };
      const sub2 = {
        write: sub.write,
        close: () => { cleanup(); sub.close(); },
      };
      subs.add(sub2);
      signal.addEventListener("abort", () => { cleanup(); sub.close(); }, { once: true });
      // Last-Event-ID 续传（EventSource 重连自动携带）
      const last = Number(lastEventId ?? 0) || 0;
      if (last > 0) {
        for (const entry of buffer) {
          if (entry.id > last) {
            try { sub.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.ev)}\n\n`); } catch { break; }
          }
        }
      }
      return cleanup;
    },
    subscriberCount: () => subs.size,
    running: () => running,
  };
}

function getHub(): Hub {
  if (!g.__stDoctorHub) g.__stDoctorHub = createHub();
  return g.__stDoctorHub;
}

function mockAdvice(live: boolean): Array<Record<string, unknown>> {
  return live
    ? [
        { id: "serveo", score: 70, confidence: "E1+", confirmed: true, title: "serveo (tested)", why: ["E1+ confirmed by 2 sources"], cmd: "st expose 3000 --tunnel serveo" },
        { id: "ipv6", score: 60, confidence: "none", confirmed: false, title: "ipv6 direct", why: ["no global IPv6 detected"], cmd: "" },
      ]
    : [
        { id: "ipv6", score: 70, confidence: "none", confirmed: false, title: "ipv6 direct (untested)", why: ["probes only"], cmd: "st expose 3000 --mode ipv6" },
        { id: "serveo", score: 55, confidence: "none", confirmed: false, title: "serveo (untested)", why: ["free, no account"], cmd: "st expose 3000 --tunnel serveo" },
      ];
}

function mockReport(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    meta: { startedAt: new Date().toISOString(), durationMs: 4200, mode: "quick", tool: { version: "mock" } },
    environment: { os: process.platform, nat: "unknown", netClass: "open", hasGlobalIpv6: false, egressIpv4Consistent: true, dns: [], tools: [] },
    endpoints: [],
    liveTests: [],
    advice: mockAdvice(true),
    channelsUsed: [],
  };
}

export async function handleDoctorApi(req: Request, ctx: ExtApiContextLike): Promise<Response | null> {
  const p = ctx.path || [];
  if (p.length !== 1) return null;

  if (p[0] === "doctor-start" && req.method === "POST") {
    if (!doctorAvailable()) return json({ error: "netcheck not available on this install" }, 404);
    const r = getHub().start({});
    if (r === "conflict") return json({ error: "doctor job already running" }, 409);
    return json(r);
  }

  if (p[0] === "doctor-stop" && req.method === "POST") {
    if (!doctorAvailable()) return json({ error: "netcheck not available" }, 404);
    getHub().stop();
    return json({ stopped: true });
  }

  if (p[0] === "doctor-events" && req.method === "GET") {
    if (!doctorAvailable()) return json({ error: "netcheck not available" }, 404);
    const hub = getHub();
    // 方案 §7-3：连接满员 → 真 503（提示复用现有流；客户端 EventSource 会停在关闭态）
    if (hub.subscriberCount() >= MAX_SUBSCRIBERS) {
      return json({ error: "too many doctor streams — reuse an existing connection" }, 503);
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const lastEventId = req.headers.get("last-event-id") ?? undefined;
        const cleanup = hub.subscribe(controller, req.signal, lastEventId ?? undefined);
        if (!cleanup) {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
      // 客户端断开（EventSource close / fetch cancel）→ 释放订阅与心跳定时器
      cancel() {},
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive" },
    });
  }

  return null;
}
