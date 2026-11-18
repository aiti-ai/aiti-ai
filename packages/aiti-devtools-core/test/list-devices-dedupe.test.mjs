/**
 * listDevices dedupe + row identity regression test.
 *
 * Two separate registration paths can describe the SAME physical page:
 *   1. the AI connection (GET /bridge/sse?role=ai + POST /bridge/ai/page) → aiConns row
 *   2. an injected-page SSE (GET /bridge/sse?role=page with a claimed instanceId) → pages row
 * Before the fix both rows were listed: the pair panel showed the operator's own browser twice
 * ("Windows · Edge 自己" with a device label, plus the document title row without one).
 *
 * Contract:
 *   - one page appears exactly once in GET /bridge/pair/devices (aiConns row wins, pages row skipped)
 *   - page rows carry the canonical `instanceId` (pair self detection / sender naming)
 *   - injected pages that never opened an AI window still show up (pages row survives)
 *
 * Run: node --experimental-strip-types --test --test-force-exit test/list-devices-dedupe.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge } from "../src/bridge.ts";
import { startHttpServer } from "../src/http.ts";

async function startBridge(tag) {
  const dataDir = mkdtempSync(join(tmpdir(), "devices-" + tag + "-"));
  const b = createBridge(dataDir, { name: tag });
  const { server, url } = await startHttpServer(b, { port: 0, host: "127.0.0.1" });
  const base = url.replace(/\/$/, "");
  return {
    base, server, dataDir,
    close: async () => { try { await server.close(); } catch {} try { rmSync(dataDir, { recursive: true, force: true }); } catch {} },
  };
}

/** Open an SSE registration and keep it alive; returns a closer. */
async function openSse(base, query) {
  const res = await fetch(base + "/bridge/sse?" + query);
  assert.ok(res.ok, "SSE 连接成功: " + query);
  const reader = res.body.getReader();
  const pump = (async () => { try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch { /* closed */ } })();
  return { close: async () => { try { await reader.cancel(); } catch {} try { await pump; } catch {} } };
}

const devices = (base) => fetch(base + "/bridge/pair/devices").then((r) => r.json()).then((b) => b.devices);

test("one physical page = one device row (aiConns + pages dedupe)", { timeout: 30000 }, async (t) => {
  const A = await startBridge("a");
  t.after(() => A.close());

  // claim a bridge identity, then run both registration paths for it
  const claim = await fetch(A.base + "/bridge/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageKey: "dedupe-test" }) }).then((r) => r.json());
  assert.ok(claim.instanceId, "claim 成功");
  const iid = claim.instanceId;

  const aiConn = await openSse(A.base, "instanceId=" + encodeURIComponent(iid) + "&role=ai&url=http://x/workbench");
  t.after(() => aiConn.close());
  const pageConn = await openSse(A.base, "instanceId=" + encodeURIComponent(iid) + "&secret=" + encodeURIComponent(claim.secret || "") + "&role=page&url=http://x/workbench&title=Workbench");
  t.after(() => pageConn.close());

  const reg = await fetch(A.base + "/bridge/ai/page", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ instanceId: iid, pageId: iid + "/host", title: "Workbench", url: "http://x/workbench" }),
  }).then((r) => r.json());
  assert.equal(reg.ok, true, "宿主页注册成功");

  const rows = (await devices(A.base)).filter((d) => d.kind === "page" && d.instanceId === iid);
  assert.equal(rows.length, 1, "同一页面只出现一行（aiConns 行胜出，pages 行被跳过）: " + JSON.stringify(rows.map((r) => r.id)));
  assert.equal(rows[0].id, iid + "/host", "行 id = 宿主页 pageId");
  assert.equal(rows[0].instanceId, iid, "行携带 canonical instanceId");
  assert.ok(rows[0].deviceLabel !== undefined, "设备摘要字段保留");
});

test("injected page without an AI window still lists (pages row survives)", { timeout: 30000 }, async (t) => {
  const A = await startBridge("b");
  t.after(() => A.close());

  const claim = await fetch(A.base + "/bridge/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageKey: "inject-only" }) }).then((r) => r.json());
  const iid = claim.instanceId;
  const pageConn = await openSse(A.base, "instanceId=" + encodeURIComponent(iid) + "&secret=" + encodeURIComponent(claim.secret || "") + "&role=page&url=http://inject.test/&title=Injected");
  t.after(() => pageConn.close());

  const rows = (await devices(A.base)).filter((d) => d.kind === "page" && d.instanceId === iid);
  assert.equal(rows.length, 1, "注入页面仍可见（无 AI 窗）");
  assert.equal(rows[0].id, iid, "注入页面行 id = instanceId");
});
