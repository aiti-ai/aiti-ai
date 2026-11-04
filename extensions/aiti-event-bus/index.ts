/**
 * aiti-event-bus · 页面事件总线（pi-web 扩展）
 *
 * 方案：docs/pi-web-ext-dependency-injection-plan.md §4-E（P0.5，2026-09-06 拍板）
 *
 * 职责：页面事件总线归口本扩展持有。core `lib/agent-page-events.ts` 不删不改，退为兜底宿主
 * + core 自用通道（SessionSidebar running）。机制 = **链式接管**（git-trace __aitiTraceEmit
 * sink 同款，本仓已验证）：全部发布（含 core running、plan-first pf:remind、model-check
 * mc:avail、editor ed-watch）都走 `globalThis.__piPageEvents.publish` 全局口，本扩展 startup
 * 时把槽的 publish 换成 wrapper 双喂（core 槽 + 本总线）——core 零改动拿到全部帧。
 *
 * 面：
 *   - SSE   GET /api/extensions/aiti-event-bus/events —— 扩展唯一新 SSE（全帧；
 *           message JSON 帧契约与 core route 一致，named heartbeat 30s 判活保活）
 *   - 服务  ctx.services.provide("aiti-event-bus.publish", { publish }) —— core P0
 *           services 落地后生效；缺席时静默跳过（过渡期全局口并行，规范同款防御式）
 *   - client 页面级单例 SSE + registerExtService("aiti-event-bus.subscribe",
 *           subscribePageFrames)（同上防御式；消费方判空回退 window.__piPageEventsClient）
 *
 * 稳态拓扑：2 条 SSE——core route（SessionSidebar 自用 running）+ 本扩展 /events（其余页面消费）。
 */
import { createEventBus, installPageEventSlot, frameMatches, type SlotChain, type PageFrame } from "./bus-core.ts";

// 模块级状态（reload = 新模块实例 → 全新总线；旧 SSE 连接由 shutdown 统一断开，
// 客户端 EventSource 自动重连到新实例的总线）
const bus = createEventBus();
let takeover: SlotChain | null = null;
const streams = new Set<() => void>(); // 每条 SSE 连接的 cleanup（reload/禁用时统一断开）

// 总线实例 id（reload = 新实例 = 新 id）：hello/heartbeat 帧携带，客户端据此发现
// 「连接已换到新总线」（见 client broker noteBusId）。模块级 const——reload 后必变。
const BUS_ID = "bus_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// 跨 reload 的流注册表（globalThis，handle-store/bridge-running 同款防 reload 丢状态模式）。
// shutdown 设计上会断开全部 SSE（客户端自动重连自愈），但宿主 reload 未必走到每个扩展的
// shutdown——漏调时旧流变僵尸：帧 sink 随旧总线实例丢弃（帧全停），而流本身与每连接心跳
// setInterval 闭包仍存活（心跳照发）→ 客户端「心跳健康、帧全停」，健康兜底永不触发，
// 只能手动刷新。新实例 startup 时统一关闭旧实例残留流，EventSource 断流自动重连 →
// hello（新 busId）→ 重发订阅，完全自愈；客户端零配合也正确。
const STREAMS_SLOT = "__aitiEventBusStreams";

// ---------- v0.2 主题订阅（按连接过滤） ----------
// 订阅协议：SSE 建连先推 named hello 帧（{conn}）→ 客户端拿 connId 后
// POST /subscribe {conn, types:[...]} 声明本连接关心的 type 集合（整体覆盖语义）。
// - types 覆盖前转发按白名单过滤（frameMatches）；未声明（types=null）的连接全帧（v0.1 兼容）。
// - 高频流扩展（aiti-cmd 终端 cmd-<id>）靠它避免无关帧到达订阅方。
// - EventSource 断线重连后新连接对象订阅集为空 → 客户端在 hello 后重发全集。
interface ConnEntry {
  types: Set<string> | null;
  write: (frame: PageFrame) => void;
  /** 客户端最后一次 POST /heartbeat 时刻：半开连接（TCP 未断、页面已死）的僵尸检测 */
  lastSeen: number;
  /** 曾发过心跳 → 受超时清理管理；v0.1 旧客户端不发心跳，永不超时（兼容） */
  managed: boolean;
  cleanup: () => void;
}
const conns = new Map<string, ConnEntry>();

// 僵尸连接扫描：managed 且 6min 无心跳 → cleanup（断连、退订、从 conns 删除）。
// 客户端 broker 每 90s 心跳一次（开页方案 §8：45→90s 减半空闲请求），4 次容忍。
// 这是连接管理（回收死连接），
// 不是推送拦截——各生产方帧照发，无人听时由各自后端自行停推（aiti-cmd /alive 范式）。
const HEARTBEAT_TIMEOUT_MS = 6 * 60 * 1000;
let connSweeper: ReturnType<typeof setInterval> | null = null;

export default {
  id: "aiti-event-bus",
  name: "页面事件总线",
  version: "0.2.1",
  icon: "icon.svg",
  client: "dist/aiti-event-bus-client.mjs",
  description: "页面事件总线归口：链式接管 __piPageEvents；v0.2 主题订阅（按 type 白名单过滤转发）",
  // 统一 SSE 端口最高加载优先级（方案：docs/aiti-event-bus-统一SSE端口-加载优先级保障-方案.md）：
  // startAll 按 priority 降序启动——总线 startup（__piPageEvents 访问器接管 + 路由注册）
  // 先于一切消费扩展执行；shutdown 对称逆序（总线最后停，消费方先退订）。
  startupPriority: 100,

  server: {
    startup(ctx: any) {
      // 旧实例残留流交接关闭（STREAMS_SLOT 注释：shutdown 漏调时防僵尸流）。
      // cleanup 幂等（closed 守卫 + 从各自实例 streams Set 删除），重复调用安全。
      const gRec = globalThis as Record<string, unknown>;
      const prevStreams = gRec[STREAMS_SLOT];
      if (prevStreams instanceof Set) {
        for (const cleanup of [...prevStreams]) {
          try { (cleanup as () => void)(); } catch { /* noop */ }
        }
      }
      gRec[STREAMS_SLOT] = streams;
      // 访问器属性接管（bus-core）：读恒得 wrapper（双喂），赋值（turbopack dev 下
      // instrumentation/路由各自再求值 agent-page-events 的重赋值）被 setter 吸收为
      // 「前任更新」——换函数式接管会被冲掉，此机制免役。
      takeover = installPageEventSlot(globalThis as Record<string, unknown>, "__piPageEvents", bus);
      // 服务出口（core P0 services 落地后生效；缺席静默——§4-E 过渡期全局口并行）。
      // 惰性现取全局槽：即使槽位后来被其他接管者换手，发布路径仍正确（§7-3 惰性 getter 规范）。
      ctx.services?.provide?.("aiti-event-bus.publish", {
        publish: (type: string, data?: Record<string, unknown>) => {
          const now = (globalThis as Record<string, any>).__piPageEvents;
          (now?.publish ?? bus.publish)(type, data ?? {});
        },
      });
      // publish-local（v0.2）：直连总线、不经全局槽——不双喂 core prev（/api/agent/running/events）。
      // 供高频帧生产方（aiti-cmd 终端 cmd-<id>）使用：低频状态帧继续走 "aiti-event-bus.publish"
      // （双喂，兼容 core route 现有消费者）；大流量帧走 local 避免污染 core route 订阅方
      //（session-manager/SessionSidebar 等）。注意：local 帧不会出现在 core route 上。
      ctx.services?.provide?.("aiti-event-bus.publish-local", {
        publish: (type: string, data?: Record<string, unknown>) => {
          bus.publish(type, data ?? {});
        },
      });
      console.log("[aiti-event-bus] 就绪 · 访问器接管 __piPageEvents（SSE sink=" + bus.sinkCount + "）");

      // 连接保活扫描（unref 不阻退出；reload = 新模块实例，旧实例 shutdown 停表）
      if (!connSweeper) {
        connSweeper = setInterval(() => {
          const now = Date.now();
          for (const c of [...conns.values()]) {
            if (c.managed && now - c.lastSeen > HEARTBEAT_TIMEOUT_MS) {
              try { c.cleanup(); } catch { /* noop */ }
            }
          }
        }, 60_000);
        (connSweeper as unknown as { unref?: () => void }).unref?.();
      }
    },

    shutdown() {
      // 断开全部 SSE 连接：客户端 EventSource 自动重连到 reload 后的新总线实例
      for (const cleanup of [...streams]) {
        try { cleanup(); } catch { /* noop */ }
      }
      if (connSweeper) { clearInterval(connSweeper); connSweeper = null; }
      // 清跨 reload 登记（仅当还是自己登记的——防 reload 堆叠时误删新实例的注册表）
      const gSd = globalThis as Record<string, unknown>;
      if (gSd[STREAMS_SLOT] === streams) gSd[STREAMS_SLOT] = null;
      // 守卫恢复：仅当访问器仍是自己装的才卸下还原（防热重载堆叠）
      takeover?.restore();
      takeover = null;
    },

    async api(req: Request, ctx: any) {
      if (req.method === "GET" && ctx.path?.[0] === "events") return eventsSse(req);
      if (req.method === "POST" && ctx.path?.[0] === "subscribe") return subscribeApi(req);
      if (req.method === "POST" && ctx.path?.[0] === "heartbeat") return heartbeatApi(req);
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  },
};

// POST /heartbeat {conn} —— 客户端连接保活：刷新 lastSeen 并标记 managed。
// 半开连接（页面关了但 TCP 未断）不再被心跳刷新 → 扫描器 3min 后 cleanup。
function heartbeatApi(req: Request): Response {
  return req.json().then((body: { conn?: unknown } | null) => {
    const connId = typeof body?.conn === "string" ? body.conn : "";
    const c = connId ? conns.get(connId) : null;
    if (!c) return new Response(JSON.stringify({ ok: false, code: "STALE_CONN", error: "unknown conn" }), { status: 404, headers: { "content-type": "application/json" } });
    c.lastSeen = Date.now();
    c.managed = true;
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }).catch(() => new Response(JSON.stringify({ ok: false, error: "bad body" }), { status: 400, headers: { "content-type": "application/json" } }));
}

// POST /subscribe {conn, types:[...]|null} —— 声明该连接的 type 白名单（整体覆盖；
// 空数组=合法空白名单；null=恢复全帧，供全帧订阅者后来加入时清除残留白名单）
async function subscribeApi(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null) as { conn?: unknown; types?: unknown } | null;
  const connId = typeof body?.conn === "string" ? body.conn : "";
  const c = connId ? conns.get(connId) : null;
  if (!c) {
    // code:"STALE_CONN"（方案 §3-D1）：conn 失效（服务端 reload 重建 conns / 半开清理）
    // 与「路由缺失 404」（扩展禁用/卸载）区分——客户端据此静默重建连接而非报错。
    return new Response(JSON.stringify({ ok: false, code: "STALE_CONN", error: "unknown conn（连接已失效，请跟随下次 hello 重建）" }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }
  if (body!.types !== null && (!Array.isArray(body!.types) || body!.types.some((t) => typeof t !== "string"))) {
    return new Response(JSON.stringify({ ok: false, error: "types 必须是 string 数组或 null（恢复全帧）" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
  c.types = body!.types === null ? null : new Set(body!.types as string[]);
  // 白名单变更诊断（2026-11-04「列表状态失聪」定案用）：低频（仅订阅变化），
  // 出问题时 journal 直接显示各连接的 types 状态——running 是否在列一眼可见。
  console.log(`[aiti-event-bus] subscribe conn=${connId.slice(-8)} types=${body!.types === null ? "ALL" : `[${(body!.types as string[]).join(",")}]`}`);
  return new Response(JSON.stringify({ ok: true, count: c.types ? c.types.size : -1 }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// GET /events —— 扩展唯一新 SSE（帧契约与 core /api/agent/running/events 一致）
// v0.2：建连即推 named hello（{conn}）；转发按连接订阅集过滤（未声明=全帧，兼容 v0.1）
function eventsSse(req: Request): Response {
  const connId = "c_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        streams.delete(cleanup);
        conns.delete(connId);
        clearInterval(heartbeat);
        unsub();
        console.log(`[aiti-event-bus] SSE close conn=${connId.slice(-8)}`);
        try { controller.close(); } catch { /* already closed */ }
      };
      const entry: ConnEntry = {
        types: null, // 未声明订阅 = 全帧（v0.1 兼容）；POST /subscribe 后切白名单
        lastSeen: Date.now(),
        managed: false, // 首次 /heartbeat 后受超时清理；旧客户端（不发心跳）永不超时
        cleanup: () => {}, // 下方赋值（cleanup 定义在后）
        write: (frame) => {
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)); }
          catch { /* controller already closed */ }
        },
      };
      const unsub = bus.addSink((frame) => {
        if (!frameMatches(frame, entry.types)) return; // 白名单过滤：不匹配的帧不出 SSE
        entry.write(frame);
      });
      conns.set(connId, entry); // 注册后 POST /subscribe 才能找到本连接
      console.log(`[aiti-event-bus] SSE open conn=${connId.slice(-8)}`);
      entry.cleanup = cleanup; // 供僵尸连接扫描器超时清理（cleanup 定义在上方）
      // named hello：客户端据此拿 connId 去 POST /subscribe（不进 message 帧分发）；
      // busId 供客户端发现总线实例更换（reload）
      try { controller.enqueue(encoder.encode(`event: hello\ndata: ${JSON.stringify({ conn: connId, busId: BUS_ID })}\n\n`)); } catch { /* noop */ }
      // named event 心跳（非 message 帧，不进订阅方帧分发）：过代理保活 + 客户端判活；
      // busId 同步携带（心跳是旧实例僵尸流唯一的活着的输出，客户端靠它比对实例）
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ busId: BUS_ID })}\n\n`)); }
        catch { /* controller already closed */ }
      }, 30_000);
      streams.add(cleanup);
      req.signal?.addEventListener("abort", cleanup);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // 禁 nginx 缓冲（同 core running/events）：否则心跳/小帧被攒着延迟送达
      "X-Accel-Buffering": "no",
    },
  });
}
