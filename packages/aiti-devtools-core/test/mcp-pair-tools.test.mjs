/**
 * aiti_* MCP tools regression after the device-view changes (pair delivery + listDevices dedupe).
 *
 * The audit question: does the pair rework touch the aiti_* command family?
 *   - aiti_pair_send / aiti_pair_file go through routePairSend → listDevices rows + deliverToInstance
 *     (both changed: pages rows are deduped against aiConns rows, delivery matches aiSelfReg AND aiPageReg,
 *     and the receiver instanceId is resolved canonically) — so this file pins the tool-visible contract.
 *   - bridge_status exposes listDevices verbatim → must still list one row per physical page, keep the
 *     host-page id, and add the canonical instanceId (additive).
 *   - aiti_hello / aiti_inbox (agents registry), user_notify / aiti_user_* (resolveAiTarget +
 *     interactOnPage) and page_exec/snapshot/logs/network do NOT go through the changed matcher; their
 *     own suites (user-notify-target) cover them.
 *
 * Run: node --experimental-strip-types --test --test-force-exit test/mcp-pair-tools.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge } from "../src/bridge.ts";
import { startHttpServer } from "../src/http.ts";

async function startBridge(tag) {
  const dataDir = mkdtempSync(join(tmpdir(), "mcp-pair-" + tag + "-"));
  const b = createBridge(dataDir, { name: tag });
  const { server, url } = await startHttpServer(b, { port: 0, host: "127.0.0.1" });
  const base = url.replace(/\/$/, "");
  return {
    base, server, dataDir,
    close: async () => { try { await server.close(); } catch {} try { rmSync(dataDir, { recursive: true, force: true }); } catch {} },
  };
}

/** Fake AI window: persistent role=ai SSE collecting downlink envelopes. */
async function connectAiWindow(base, instanceId) {
  const res = await fetch(base + "/bridge/sse?instanceId=" + encodeURIComponent(instanceId) + "&role=ai&url=http://x/workbench");
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
          try { received.push(JSON.parse(line.slice(6))); } catch { /* heartbeat */ }
        }
      }
    } catch { /* closed */ }
  })();
  return { received, close: async () => { try { await reader.cancel(); } catch {} try { await pump; } catch {} } };
}

const mcpTool = (base, name, args) => fetch(base + "/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", "accept": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "t_" + Math.random().toString(36).slice(2, 6), method: "tools/call", params: { name, arguments: args } }),
}).then((r) => r.json()).then((j) => ({ isError: !!(j.result && j.result.isError), text: j.result && j.result.content && j.result.content[0] ? j.result.content[0].text : "", json: (() => { try { return JSON.parse(j.result.content[0].text); } catch { return null; } })() }));

const waitFor = async (pred, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return false;
};

test("aiti_* MCP tools keep working on the deduped device view", { timeout: 30000 }, async (t) => {
  const A = await startBridge("a");
  t.after(() => A.close());

  const iid = "ai-pairtest";
  const win = await connectAiWindow(A.base, iid);
  t.after(() => win.close());
  // The browser reports two identities on connect: the AI-window self registration (carries the device
  // info used for the device row name/label) and the host page identity.
  const selfReg = await fetch(A.base + "/bridge/self/page", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instanceId: iid, url: "http://x/workbench", title: "Workbench",
      device: { browser: "Edge", version: "157.0.0.0", os: "Linux", screen: "1920x1080", deviceType: "desktop" },
      deviceLabel: "Edge · Linux · 1920x1080",
    }),
  }).then((r) => r.json());
  assert.equal(selfReg.ok, true, "AI 窗自注册成功");
  const reg = await fetch(A.base + "/bridge/ai/page", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instanceId: iid, pageId: "hw1/host", title: "Workbench", url: "http://x/workbench",
      device: { browser: "Edge", version: "157.0.0.0", os: "Linux", screen: "1920x1080", deviceType: "desktop" },
      deviceLabel: "Edge · Linux · 1920x1080",
    }),
  }).then((r) => r.json());
  assert.equal(reg.ok, true, "宿主页注册成功");

  // ---- 1) bridge_status: one row per page, host-page id kept, canonical instanceId added ----
  const st = await mcpTool(A.base, "bridge_status", {});
  assert.equal(st.isError, false, "bridge_status 正常返回");
  const pageRows = (st.json.devices || []).filter((d) => d.kind === "page");
  assert.equal(pageRows.length, 1, "同一页面只有一行: " + JSON.stringify(pageRows.map((r) => r.id)));
  assert.equal(pageRows[0].id, "hw1/host", "行 id 仍是宿主页 pageId");
  assert.equal(pageRows[0].instanceId, iid, "新增 canonical instanceId（向后兼容的增量字段）");
  assert.equal(pageRows[0].name, "Linux · Edge", "设备名 = OS · 浏览器");
  assert.ok(String(pageRows[0].deviceLabel).indexOf("Edge") === 0, "deviceLabel 来自客户端自报设备");
  assert.ok((st.json.sessions || []).length >= 1, "sessions 明细不受 devices 去重影响");

  // ---- 2) aiti_pair_send by bare instanceId (the id the dedupe removed from device rows) ----
  const r1 = await mcpTool(A.base, "aiti_pair_send", { to: iid, text: "by-iid" });
  assert.equal(r1.isError, false, "裸 instanceId 仍可达（模糊命中 → 行 id）: " + r1.text);
  assert.equal(r1.json.ok, true);
  assert.deepEqual(r1.json.delivered, [{ kind: "page", id: "hw1/host" }]);
  assert.ok(await waitFor(() => win.received.some((m) => m.type === "pair_msg" && m.text === "by-iid")), "AI 窗收到 pair_msg");

  // ---- 2b) frame form of the instanceId also addresses the page (ai-xxx/ai and ai-xxx/host) ----
  for (const to of [iid + "/ai", iid + "/host"]) {
    const rf = await mcpTool(A.base, "aiti_pair_send", { to, text: "frame:" + to });
    assert.equal(rf.json.ok, true, "instanceId 帧形式可达: " + to + " → " + rf.text);
    assert.deepEqual(rf.json.delivered, [{ kind: "page", id: "hw1/host" }]);
    assert.ok(await waitFor(() => win.received.some((m) => m.type === "pair_msg" && m.text === "frame:" + to)), "AI 窗收到 " + to);
  }

  // ---- 3) aiti_pair_send by host pageId (row id) ----
  const r2 = await mcpTool(A.base, "aiti_pair_send", { to: "hw1/host", text: "by-pageid" });
  assert.equal(r2.json.ok, true, "行 id 直达: " + r2.text);
  assert.ok(await waitFor(() => win.received.some((m) => m.type === "pair_msg" && m.text === "by-pageid")));

  // ---- 4) aiti_pair_send by device name ----
  const r3 = await mcpTool(A.base, "aiti_pair_send", { to: "Linux · Edge", text: "by-name" });
  assert.equal(r3.json.ok, true, "设备名可投递: " + r3.text);
  assert.ok(await waitFor(() => win.received.some((m) => m.type === "pair_msg" && m.text === "by-name")));

  // ---- 5) explicit broadcast still reaches the page (sender = agent, not a page) ----
  const r4 = await mcpTool(A.base, "aiti_pair_send", { to: "all", text: "broadcast" });
  assert.equal(r4.json.ok, true, "显式广播: " + r4.text);
  assert.ok(await waitFor(() => win.received.some((m) => m.type === "pair_msg" && m.text === "broadcast")));

  // ---- 6) unknown target: error, no crash, no delivery ----
  const r5 = await mcpTool(A.base, "aiti_pair_send", { to: "no-such-device", text: "nowhere" });
  assert.equal(r5.isError, true, "无匹配设备 → isError");
  assert.ok(/无匹配设备/.test(r5.text), "错误信息可读: " + r5.text);

  // ---- 7) omitted target: still refused (blast guard), never a silent broadcast ----
  const r6 = await mcpTool(A.base, "aiti_pair_send", { text: "no target" });
  assert.equal(r6.isError, true, "缺省 to 仍然拒绝");
  assert.ok(/不再默认群发/.test(r6.text), "缺省群发守卫保留");
  assert.equal(win.received.filter((m) => m.type === "pair_msg" && m.text === "no target").length, 0, "守卫后无投递");
});

test("aiti_pair_file: file-meta reaches the page row id (same routePairSend path)", { timeout: 30000 }, async (t) => {
  const A = await startBridge("b");
  t.after(() => A.close());
  const iid = "ai-filetest";
  const win = await connectAiWindow(A.base, iid);
  t.after(() => win.close());
  await fetch(A.base + "/bridge/ai/page", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ instanceId: iid, pageId: "hw2/host", title: "W", url: "http://x/w", device: { browser: "Chrome", os: "Linux" } }),
  });

  // small file → pair REST upload from an agent identity is not available, so drive the tool with a real file
  const file = join(A.dataDir, "hello.txt");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, "hi");
  const r = await mcpTool(A.base, "aiti_pair_file", { to: "hw2/host", path: file });
  assert.equal(r.isError, false, "aiti_pair_file 成功: " + r.text);
  assert.ok(await waitFor(() => win.received.some((m) => m.type === "pair_msg" && m.file && m.file.name === "hello.txt")), "页面收到文件卡片帧");
});
