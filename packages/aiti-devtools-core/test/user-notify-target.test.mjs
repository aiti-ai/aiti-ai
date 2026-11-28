/**
 * user_notify targeted-delivery regression tests (fix: the old implementation ignored args.pageId
 * and always blasted aiConns → the pair device "identify" card popped up on the sender's own screen).
 *
 * Contract (bridge.ts tools/call user_notify):
 *   - explicit pageId (bare instanceId / full pageId / url/title) → targeted single delivery: the
 *     target AI-window connection (aiSelfReg/aiPageReg matched by instanceId) first, fallback to
 *     notify-only injected pages; miss = error.
 *   - default (no pageId) → broadcast to all AI windows + the session default page (unchanged).
 *
 * Run: node --experimental-strip-types --test --test-force-exit test/user-notify-target.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge } from "../src/bridge.ts";
import { startHttpServer } from "../src/http.ts";

// SAFETY: ports always 0 (system-assigned); lifecycle owned by the test (t.after close).
async function startBridge(tag) {
  const dataDir = mkdtempSync(join(tmpdir(), "notify-target-" + tag + "-"));
  const b = createBridge(dataDir, { name: tag });
  const { server, url } = await startHttpServer(b, { port: 0, host: "127.0.0.1" });
  const base = url.replace(/\/$/, "");
  return {
    base, server, dataDir,
    close: async () => { try { await server.close(); } catch {} try { rmSync(dataDir, { recursive: true, force: true }); } catch {} },
  };
}

/** Fake AI window: persistent GET /bridge/sse?role=ai stream collecting downlink envelopes (writer.write → SSE data lines) */
async function connectFakeAiWindow(base, instanceId) {
  const res = await fetch(base + "/bridge/sse?instanceId=" + encodeURIComponent(instanceId) + "&role=ai&url=http://x/cockpit.html");
  assert.ok(res.ok, "AI 窗 SSE 连接成功");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const received = [];
  let buf = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try { received.push(JSON.parse(line.slice(6))); } catch { /* heartbeats and other non-JSON */ }
        }
      }
    } catch { /* connection closed */ }
  })();
  return {
    received,
    close: async () => { try { await reader.cancel(); } catch {} try { await pump; } catch {} },
  };
}

const callNotify = (base, args) => fetch(base + "/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", "accept": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "t_" + Math.random().toString(36).slice(2, 6), method: "tools/call", params: { name: "user_notify", arguments: args } }),
}).then((r) => r.json());

test("user_notify：显式 pageId 定向单投（不群发）→ 未命中报错 → 缺省仍广播", { timeout: 30000 }, async (t) => {
  const A = await startBridge("a");
  t.after(() => A.close());
  const win1 = await connectFakeAiWindow(A.base, "ai-win1");
  const win2 = await connectFakeAiWindow(A.base, "ai-win2");
  t.after(() => { win1.close(); win2.close(); });

  // ---- 1) explicit bare instanceId (same id space as pair devices) → only the target AI window receives, the other does not ----
  const r1 = await callNotify(A.base, { title: "🔎 找到我了", body: "win1 · 定向", pageId: "ai-win1" });
  const out1 = r1.result.content[0].text;
  assert.equal(r1.result.isError, false, "定向投递成功");
  assert.equal(JSON.parse(out1).notified, true, "notified:true");
  await new Promise((r) => setTimeout(r, 150));
  const hits1 = win1.received.filter((m) => m.type === "interaction" && m.interaction && m.interaction.kind === "notify");
  assert.equal(hits1.length, 1, "目标窗收到 1 条 notify（实际 " + hits1.length + "）");
  assert.equal(hits1[0].interaction.body, "win1 · 定向");
  assert.equal(hits1[0].frameId, "ai", "AI 窗定向帧 frameId=ai");
  const hits2 = win2.received.filter((m) => m.type === "interaction");
  assert.equal(hits2.length, 0, "非目标窗零投递（实际 " + hits2.length + "）");

  // ---- 2) target offline → isError (no more pretending notified:true) ----
  const r2 = await callNotify(A.base, { title: "t", body: "b", pageId: "ai-gone" });
  assert.equal(r2.result.isError, true, "未命中报错");
  assert.ok(String(r2.result.content[0].text).indexOf("未") >= 0, "错误文案");

  // ---- 3) no pageId → original broadcast behavior (both windows receive) ----
  const r3 = await callNotify(A.base, { title: "广播", body: "all-windows" });
  assert.equal(r3.result.isError, false, "广播成功");
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(win1.received.some((m) => m.type === "interaction" && m.interaction && m.interaction.body === "all-windows"), "窗1 收到广播");
  assert.ok(win2.received.some((m) => m.type === "interaction" && m.interaction && m.interaction.body === "all-windows"), "窗2 收到广播");
});

test("user_notify：宿主页身份 om183/host 家族定向（via=ai 转发宿主）+ iid/ai 仍走 self", { timeout: 30000 }, async (t) => {
  const B = await startBridge("b");
  t.after(() => B.close());
  const winA = await connectFakeAiWindow(B.base, "ai-winA");
  const winB = await connectFakeAiWindow(B.base, "ai-winB");
  t.after(() => { winA.close(); winB.close(); });

  // winA registers a host-page identity (om183/host form, same as POST /bridge/ai/page)
  const reg = await fetch(B.base + "/bridge/ai/page", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ instanceId: "ai-winA", pageId: "hst42/host", title: "T", url: "http://x/dev", frames: [{ id: "host" }, { id: "f1" }] }),
  }).then((r) => r.json());
  assert.equal(reg.ok, true, "宿主页注册成功");

  // 1) pageId=hst42/host (the form recommended by the from-attribution line) → only the owning window receives, via=ai frameId=host
  const r1 = await callNotify(B.base, { title: "t", body: "host-hit", pageId: "hst42/host" });
  assert.equal(r1.result.isError, false, "宿主页身份定向成功：" + JSON.stringify(r1.result.content));
  assert.equal(JSON.parse(r1.result.content[0].text).pageId, "hst42/host");
  await new Promise((r) => setTimeout(r, 150));
  const hitA = winA.received.filter((m) => m.type === "interaction" && m.interaction && m.interaction.body === "host-hit");
  assert.equal(hitA.length, 1, "归属窗收到 1 条（实际 " + hitA.length + "）");
  assert.equal(hitA[0].via, "ai", "via=ai（转发宿主）");
  assert.equal(hitA[0].frameId, "host", "frameId=host");
  assert.equal(winB.received.filter((m) => m.type === "interaction").length, 0, "非归属窗零投递");

  // 2) frame-tree id hst42/f1 → frameId passes through fN
  const r2 = await callNotify(B.base, { title: "t", body: "frame-hit", pageId: "hst42/f1" });
  assert.equal(r2.result.isError, false);
  await new Promise((r) => setTimeout(r, 150));
  const hitF = winA.received.filter((m) => m.type === "interaction" && m.interaction && m.interaction.body === "frame-hit");
  assert.equal(hitF.length, 1, "帧树 id 定向命中");
  assert.equal(hitF[0].frameId, "f1", "frameId=fN 透传");

  // 3) the iid/ai form still goes to the self window (frameId=ai via=self), no fallback
  const r3 = await callNotify(B.base, { title: "t", body: "self-hit", pageId: "ai-winA/ai" });
  assert.equal(r3.result.isError, false);
  await new Promise((r) => setTimeout(r, 150));
  const hitS = winA.received.filter((m) => m.type === "interaction" && m.interaction && m.interaction.body === "self-hit");
  assert.equal(hitS.length, 1);
  assert.equal(hitS[0].via, "self");
  assert.equal(hitS[0].frameId, "ai");
});

test("user_notify：根页面窗口宿主回退 id <iid>/host（listDevices 广告形态）sessions 可见且可定向", { timeout: 30000 }, async (t) => {
  const C = await startBridge("c");
  t.after(() => C.close());
  const winC = await connectFakeAiWindow(C.base, "ai-winC");
  t.after(() => { winC.close(); });

  // without registering /bridge/ai/page (root-page form: host identity never registered) →
  // sessions should show an ai-winC/host fallback row (same source as the device view)
  const arr = await fetch(C.base + "/bridge/sessions").then((r) => r.json());
  assert.ok(Array.isArray(arr) && arr.some((r) => r.pageId === "ai-winC/host"),
    "sessions 含回退行 ai-winC/host：" + JSON.stringify(Array.isArray(arr) ? arr.map((r) => r.pageId) : arr));

  const r1 = await callNotify(C.base, { title: "t", body: "fallback-hit", pageId: "ai-winC/host" });
  assert.equal(r1.result.isError, false, "回退 id 定向成功：" + JSON.stringify(r1.result.content));
  assert.equal(JSON.parse(r1.result.content[0].text).pageId, "ai-winC/host");
  await new Promise((r) => setTimeout(r, 150));
  const hit = winC.received.filter((m) => m.type === "interaction" && m.interaction && m.interaction.body === "fallback-hit");
  assert.equal(hit.length, 1, "归属窗收到 1 条（实际 " + hit.length + "）");
  assert.equal(hit[0].via, "ai", "via=ai（转发宿主）");
  assert.equal(hit[0].frameId, "host", "frameId=host");
});
