/**
 * pair E2E —— 真 HTTP 双桥联邦 + 上线门槛全链路（自动化；widget UI 层为手工浏览器验收）
 *
 * 拓扑：桥 A = startHttpServer 真端口（权威桥/8777 同构 REST 面）；桥 B = 同进程实例（联邦代理宿主，
 * deliver 经 pair-fed 回调捕获）。跨实例走真 socket，语义与 dev/prod 内嵌桥联邦一致。
 *
 * 覆盖：双桥隔离 → fed devices 并集 → 出站文本/文件两跳（重放）→ 入站中继（from 原样）→
 *       fed 文件同机直读代理下载 → 上线门槛（公网 403 / remote-user / regToken / 内网）。
 *
 * SAFETY: ports are always 0 (system-assigned). NEVER grep+kill by port range for
 * cleanup - the first draft killed openclaw-gateway(18789), a production service
 * listening in the same range (service auto-restarted). Lifecycle is owned by
 * the test: t.after calls srv.close(), runner uses --test-force-exit.
 *
 * Run: node --experimental-strip-types --test --test-force-exit test/pair-e2e.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge } from "../src/bridge.ts";
import { startHttpServer } from "../src/http.ts";
import { createPairFed } from "../../../extensions/aiti-devtools/server/pair-fed.ts";

async function startBridge(tag) {
  const dataDir = mkdtempSync(join(tmpdir(), "pair-e2e-" + tag + "-"));
  const b = createBridge(dataDir, { name: tag });
  const { server, url } = await startHttpServer(b, { port: 0, host: "127.0.0.1" }); // port 0 = 系统分配
  const port = Number(new URL(url).port);
  const H = (path, opt) => fetch(url.replace(/\/$/, "") + path, opt);
  const POST = (path, body) => H(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { b, server, url, port, dataDir, H, POST,
    close: async () => { try { await server.close(); } catch {} },
    reg: async (peerId, name, headers) => (await (await H("/bridge/pair/register", { method: "POST", headers: { "Content-Type": "application/json", ...(headers || {}) }, body: JSON.stringify({ peerId, name }) })).json()),
  };
}

test("pair E2E：双桥隔离 → 联邦并集 → 双向文本（from 保留）→ 文件两跳 + 代理下载 → gate", { timeout: 30000 }, async (t) => {
  const A = await startBridge("a");
  const B = await startBridge("b");
  t.after(() => { try { fed.stop(); } catch {} try { A.close(); } catch {} try { B.close(); } catch {} try { rmSync(A.dataDir, { recursive: true, force: true }); rmSync(B.dataDir, { recursive: true, force: true }); } catch {} });

  // ---- 两桥各自注册（隔离态）----
  const tokA = (await A.reg("p_a_dev", "A桥设备")).token;
  const tokB = (await B.reg("p_b_dev", "B桥设备")).token;
  const devA = await (await A.H("/bridge/pair/devices")).json();
  assert.ok(devA.devices.some((d) => d.name === "A桥设备") && !devA.devices.some((d) => d.name === "B桥设备"), "无联邦时两桥互不可见");

  // ---- 联邦代理（宿主=桥 B；权威桥=A）——index.ts 接线的测试重建 ----
  const inbound = []; // 桥 B 侧入站捕获（index.ts deliverToAllLocalPeers 测试重建：全量投本地 peers）
  const fed = createPairFed({
    TAG: "[e2e]", cacheDir: join(B.dataDir, "fed-cache"),
    log: (m) => console.log("[fed]", m),
    deliverToAllLocalPeers: (env) => {
      inbound.push(env);
      let n = 0;
      for (const p of B.b.pair().listPeers()) if (B.b.pair().deliverToPeer(p.id, env)) n++;
      return n;
    },
  });
  fed.configure({ enabled: true, url: A.url.replace(/\/$/, "") + "/aiti", filesDir: join(A.dataDir, "aiti-bridge", "pair-files") });
  await new Promise((r) => setTimeout(r, 400)); // relay 注册 + SSE 建立

  // devices 并集数据源：fed.fedDevices()（index.ts 的 HTTP 拦截合并层已 dev 真机验证；E2E 聚焦模块+真桥组合）
  const fedRows = await fed.fedDevices();
  assert.ok(fedRows.some((d) => d.name === "A桥设备" && d.id.startsWith("fed:")), "并集含权威桥设备（fed: 前缀命名空间）");
  const fedTarget = fedRows.find((d) => d.name === "A桥设备").id;

  // ---- 出站文本（B 桥设备 → fed: 目标）----
  const probeA = await (await A.H("/bridge/pair/devices")).json();
  console.log("[e2e] A devices:", JSON.stringify(probeA.devices.map((d) => d.name + "/" + d.id + "/online=" + d.online)));
  console.log("[e2e] fedTarget:", fedTarget, "| A.url:", A.url);
  const relayCred = JSON.parse(readFileSync(join(B.dataDir, "fed-cache", "pair-fed-cred.json"), "utf8"));
  const manual = await (await A.POST("/bridge/pair/message", { peer: relayCred.peerId, token: relayCred.token, to: "p_a_dev", text: "手动复现" })).json();
  console.log("[e2e] manual relay send:", JSON.stringify(manual).slice(0, 160));
  // 出站转发：index.ts 对 fed: 目标调 fed.fedSendText（E2E 直调同函数；消息 from = relay 中继身份）
  const outMsg = await fed.fedSendText(fedTarget, "B→A 跨桥 ✓");
  assert.ok(outMsg.ok, "出站投递成功: " + JSON.stringify(outMsg));
  const inboxA = await (await A.H("/bridge/pair/inbox?peer=p_a_dev&token=" + tokA)).json();
  const m0 = inboxA.pending.find((m) => m.type === "text" && m.text.includes("B→A 跨桥"));
  assert.ok(m0 && m0.text.includes("B→A 跨桥"), "A 桥目标收到: " + JSON.stringify(inboxA.pending));
  assert.equal(m0.from.name, "pi-web 桥", "8777 侧看到中继身份（v1 非对称语义）");

  // ---- 入站文本（A 桥设备 → relay）→ B 桥 inbox（from 原样保留）----
  const regA2 = await A.reg("p_a_sender", "A桥发送机");
  await A.POST("/bridge/pair/message", { peer: "p_a_sender", token: regA2.token, to: "p_a_dev", text: "占位" }); // 消费 join 噪音
  const relayPeer = (await (await A.H("/bridge/pair/devices")).json()).devices.find((d) => d.name === "pi-web 桥" && d.online);
  assert.ok(relayPeer, "relay 在权威桥在线");
  const inMsg = await (await A.POST("/bridge/pair/message", { peer: "p_a_sender", token: regA2.token, to: relayPeer.id, text: "A→B 入站 ✓" })).json();
  assert.ok(inMsg.ok, "入站投递给 relay");
  await new Promise((r) => setTimeout(r, 600));
  const inboxB = await (await B.H("/bridge/pair/inbox?peer=p_b_dev&token=" + tokB)).json();
  const m1 = inboxB.pending.find((m) => m.text && m.text.includes("A→B 入站"));
  assert.ok(m1, "B 桥设备经中继收到");
  assert.equal(m1.from.name, "A桥发送机", "envelope 原样中继（from 原始发送者）");

  // ---- 出站文件两跳（B → fed: 目标：本地中转 → complete 重放到 A）----
  const content = "两跳文件内容 " + Date.now();
  const body = Buffer.from(content, "utf8");
  const init = await (await B.POST("/bridge/pair/file/init", { peer: "p_b_dev", token: tokB, to: fedTarget, name: "two-hop.txt", size: body.length, mime: "text/plain" })).json();
  assert.ok(init.ok, "file init: " + JSON.stringify(init));
  await B.H("/bridge/pair/file/chunk/" + init.fileId + "?n=0", { method: "POST", body: body });
  const doneResp = await (await B.POST("/bridge/pair/file/complete/" + init.fileId)).json();
  assert.ok(doneResp.ok, "本地中转 complete");
  // 重放：index.ts 在 complete 拦截后自动调 fedSendFile；E2E 显式调用（同函数同参数）
  const info = B.b.pair().getFileInfo(init.fileId);
  assert.ok(info && info.status === "ready" && fed.isFed(info.to), "本地中转记录 to=fed: 原样保留");
  const replay = await fed.fedSendFile(info, info.to);
  assert.ok(replay.ok, "三步重放到权威桥");
  const inboxA2 = await (await A.H("/bridge/pair/inbox?peer=p_a_dev&token=" + tokA)).json();
  const fm = inboxA2.pending.find((m) => m.type === "file" && m.file && m.file.name === "two-hop.txt");
  assert.ok(fm, "A 桥目标收到重放 file-meta");
  const dlA = await A.H("/bridge/pair/file/" + fm.file.fileId + "?peer=p_a_dev&token=" + tokA);
  assert.equal(await dlA.text(), content, "重放文件下载内容一致");

  // ---- 入站文件（A → relay）→ B inbox file-meta → fed 同机直读代理下载 ----
  const fileContent2 = "代理下载直读 " + Date.now();
  const fileBody = Buffer.from(fileContent2, "utf8");
  const initA = await (await A.POST("/bridge/pair/file/init", { peer: "p_a_sender", token: regA2.token, to: relayPeer.id, name: "proxy-dl.txt", size: fileBody.length, mime: "text/plain" })).json();
  await A.H("/bridge/pair/file/chunk/" + initA.fileId + "?n=0", { method: "POST", body: fileBody });
  await A.POST("/bridge/pair/file/complete/" + initA.fileId);
  await new Promise((r) => setTimeout(r, 1500));
  const inboxB2 = await (await B.H("/bridge/pair/inbox?peer=p_b_dev&token=" + tokB)).json();
  const fmB = inboxB2.pending.find((m) => m.type === "file" && m.file && m.file.name === "proxy-dl.txt");
  assert.ok(fmB, "B 桥收到 file-meta（中继）");
  // 代理下载（index.ts：本地 registry miss → fed 同机直读桥 A pair-files）
  const localHit = B.b.pair().getFileInfo(fmB.file.fileId);
  assert.equal(localHit, null, "fileId 不在本地 registry（在权威桥）");
  console.log("[e2e] proxy debug: fileId=" + fmB.file.fileId, "| A pair-files listing:", (() => { try { return readdirSync(join(A.dataDir, "aiti-bridge", "pair-files")); } catch (e) { return "ERR " + e.message; } })());
  let proxyPath = null;
  for (let i = 0; i < 10; i++) {
    proxyPath = fed.fedFileProxy(fmB.file.fileId);
    if (proxyPath) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(proxyPath, "同机直读命中桥 A pair-files");
  assert.equal(readFileSync(proxyPath.path, "utf8"), fileContent2, "代理直读内容一致");
  // meta.name = fileId（fed 代理只读磁盘，原始名在权威桥内存 registry）——index.ts 下载命名走 meta.name || fileId 兜底
  assert.equal(proxyPath.meta.name, fmB.file.fileId, "代理 meta.name = fileId（v1 已知限制：fed 下载文件名退化为 fileId）");

  // ---- 上线门槛（真 HTTP 面）----
  const PUB = { "x-real-ip": "203.0.113.9" };
  const AUTH = { "x-real-ip": "203.0.113.9", "remote-user": "wind" };
  assert.equal((await A.H("/bridge/pair/register", { method: "POST", headers: PUB, body: JSON.stringify({ name: "x" }) })).status, 403, "公网无凭据 403");
  assert.equal((await A.H("/bridge/pair/register", { method: "POST", headers: AUTH, body: JSON.stringify({ name: "authed" }) })).status, 200, "Authelia remote-user 放行");
  assert.equal((await A.H("/bridge/pair/register", { method: "POST", body: JSON.stringify({ name: "direct" }) })).status, 200, "直连（无头=内网）放行");
});

test("pair E2E：桥进程生命周期（devices/SSE 断连恢复后 relay 重连）", { timeout: 20000 }, async (t) => {
  const A = await startBridge("a2");
  const B = await startBridge("b2");
  t.after(() => { try { fed.stop(); } catch {} try { A.close(); } catch {} try { globalThis.__e2eSrvClose?.(); } catch {} try { B.close(); } catch {} try { rmSync(A.dataDir, { recursive: true, force: true }); rmSync(B.dataDir, { recursive: true, force: true }); } catch {} });

  const tokA = (await A.reg("p_a", "A设备")).token;
  let delivered = 0;
  const fed = createPairFed({
    TAG: "[e2e2]", cacheDir: join(B.dataDir, "fed-cache"),
    log: (m) => console.log("[fed]", m),
    deliverToAllLocalPeers: () => { delivered += 1; return 1; },
  });
  fed.configure({ enabled: true, url: A.url.replace(/\/$/, "") + "/aiti", filesDir: join(A.dataDir, "aiti-bridge", "pair-files") });
  await new Promise((r) => setTimeout(r, 400));

  // 权威桥重启语义（close+重建 = 8777 restart 同构）：SSE 断 → relay 退避重连 → 恢复投递
  const oldUrl = A.url;
  fed.configure({ enabled: false }); // 先停 relay（挂起的 SSE 连接会阻塞 close/端口释放）
  await new Promise((r) => setTimeout(r, 200));
  await A.close();
  const b2 = createBridge(A.dataDir, { name: "a2b" });
  const srv = await startHttpServer(b2, { port: Number(new URL(oldUrl).port), host: "127.0.0.1" });
  globalThis.__e2eSrvClose = () => srv.close();
  // 生产语义：权威桥重启期间联邦代理保持开启——重启完成后重新启用（关闭后再开启能重启循环）
  fed.configure({ enabled: true, url: oldUrl.replace(/\/$/, "") + "/aiti", filesDir: join(A.dataDir, "aiti-bridge", "pair-files") });

  // 重启窗口陈旧 keep-alive socket 会让首个 POST 撞 UND_ERR_SOCKET（undici 对 POST 不自动重试）→ 退避重试
  const withRetry = async (fn, n = 6) => { let e; for (let i = 0; i < n; i++) { try { return await fn(); } catch (x) { e = x; await new Promise((r) => setTimeout(r, 400)); } } throw e; };
  const reg2 = await withRetry(() => A.H("/bridge/pair/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ peerId: "p_a", name: "A设备" }) })).then((r) => r.json());
  assert.ok(reg2.ok, "权威桥重启后设备重新注册（凭据持久化幂等）");
  await new Promise((r) => setTimeout(r, 300)); // close 后 socket 释放窗口（relay abort 异步）
  const regB2 = await B.reg("p_b", "B设备");
  await new Promise((r) => setTimeout(r, 4000)); // relay 退避重连窗口
  await A.POST("/bridge/pair/message", { peer: "p_a", token: reg2.token, to: "p_b_peer_unknown", text: "重启后投递" }).catch(() => {});
  // relay 重连后（凭据幂等）devices 并集恢复
  let union = [];
  for (let i = 0; i < 20; i++) {
    union = await fed.fedDevices();
    const direct = await (await A.H("/aiti/bridge/pair/devices")).json().catch((e) => ({ err: String(e) }));
    console.log("[e2e2] poll", i, "fedDevices:", JSON.stringify(union.map((d) => d.name)), "| direct A:", JSON.stringify((direct.devices || direct).map ? (direct.devices || direct).map((d) => d.name) : direct));
    if (union.some((d) => d.fed && d.name === "A设备")) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(union.some((d) => d.fed && d.name === "A设备"), "重启恢复后并集含权威桥设备: " + JSON.stringify(union.map((d) => d.name)));
  void delivered;
});
