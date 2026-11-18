/**
 * pair module unit tests (channel unification docs/pair-pageid-channel-unification-plan.md + re-audit fix docs/pair-reaudit-and-fix-plan.md)
 *
 * Contract: pair widget uses page identity (instanceId self-attestation via bridge validInstance) over REST;
 * single downlink = aiConns pair_msg (chat/files). No standalone pair SSE registration (widget side);
 * peers Map only holds explicitly registered external web devices (fed relay compat), surfaced via listPeers.
 * notify/identify go through MCP user_notify (REST /notify removed).
 * Run: node --experimental-strip-types --test pair.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPairModule } from "./pair.ts";
import { createBridge } from "./bridge.ts";

const PAIR_TMP = mkdtempSync(join(tmpdir(), "bridge-pair-test-"));
function tmpDir(tag) {
  return join(PAIR_TMP, tag + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
}
test.after(() => { try { rmSync(PAIR_TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

const SELF_ID = "ai-self";
const SELF_SECRET = "sec-self";
const OTHER_ID = "ai-other";

/** Direct module test (deps mock: validateInstance only knows ai-self/ai-other; routeSend recorded) */
function mkPair(tag, opts = {}) {
  const calls = { routeSend: [] };
  const devices = opts.devices || [
    { kind: "page", id: SELF_ID + "/host", name: "本页", online: true },
    { kind: "page", id: OTHER_ID + "/host", name: "其他页面 · Chrome", online: true },
    { kind: "agent", id: "pi/s1", name: "测试 agent", online: true },
  ];
  const p = createPairModule({
    TAG: "[t]",
    dataDir: opts.dataDir || tmpDir(tag),
    cors: {},
    json: (body, status) => new Response(JSON.stringify(body), { status: status || 200, headers: { "content-type": "application/json" } }),
    sseResponse: () => { throw new Error("SSE 不应再被 pair 模块使用"); },
    getDevices: () => (typeof opts.devices === "function" ? opts.devices() : devices),
    routeSend: (fromDev, to, payload) => { calls.routeSend.push({ fromDev, to, payload }); return { ok: true, delivered: [{ kind: "page", id: to }] }; },
    validateInstance: (iid) => !opts.verifyFail && (iid === SELF_ID || iid === OTHER_ID),
  });
  const H = (p2, opt) => p.handle(
    new Request("http://x" + p2, opt),
    p2.split("?")[0].split("/").filter(Boolean),
    new URLSearchParams(p2.split("?")[1] || "")
  );
  const AUTH = { instanceId: SELF_ID, secret: SELF_SECRET, pageId: SELF_ID + "/host" };
  return { p, H, AUTH, calls, devices };
}

test("message: page identity auth (unknown instanceId 401; valid -> routeSend, from = page identity)", async () => {
  const { H, AUTH, calls } = mkPair("msg");
  const bad = await (await H("/bridge/pair/message", { method: "POST", body: JSON.stringify({ ...AUTH, instanceId: "ai-wrong", to: OTHER_ID + "/host", text: "x" }) })).json();
  assert.ok(String(bad.error).indexOf("bad instanceId") === 0, "unknown instanceId rejected");
  const ok = await (await H("/bridge/pair/message", { method: "POST", body: JSON.stringify({ ...AUTH, to: OTHER_ID + "/host", text: "hello" }) })).json();
  assert.ok(ok.ok, "delivery ok");
  const call = calls.routeSend[calls.routeSend.length - 1];
  assert.equal(call.fromDev.id, SELF_ID + "/host", "from=页面 pageId");
  assert.equal(call.fromDev.kind, "page", "from kind=page");
  assert.equal(call.payload.text, "hello");
  const empty = await (await H("/bridge/pair/message", { method: "POST", body: JSON.stringify({ ...AUTH, to: "all", text: " " }) })).json();
  assert.equal(empty.error, "bad request（需要 text）", "empty text rejected");
});

test("notify REST removed (A6): /bridge/pair/notify falls through to 404 (handle -> null)", async () => {
  const { H, AUTH } = mkPair("notify-gone");
  const r = await H("/bridge/pair/notify", { method: "POST", body: JSON.stringify({ ...AUTH, to: "all", title: "t", body: "b" }) });
  assert.equal(r, null, "notify branch removed (handle -> null, bridge answers 404)");
});

test("file relay: init/chunk/complete (page identity) + size cap rejection", async () => {
  const { H, AUTH } = mkPair("file");
  const content = Buffer.from("PAIR-FILE-" + "x".repeat(5000));
  const init = await (await H("/bridge/pair/file/init", { method: "POST", body: JSON.stringify({ ...AUTH, to: OTHER_ID + "/host", name: "a.bin", size: content.length, mime: "application/octet-stream" }) })).json();
  assert.ok(init.ok && init.fileId);
  const bad = await (await H("/bridge/pair/file/init", { method: "POST", body: JSON.stringify({ instanceId: "ai-wrong", secret: "x", to: "all", name: "x", size: 1 }) })).json();
  assert.ok(String(bad.error).indexOf("bad instanceId") === 0, "unknown instanceId rejected");
  const c1 = await (await H("/bridge/pair/file/chunk/" + init.fileId + "?n=0", { method: "POST", body: content.subarray(0, 1000) })).json();
  assert.ok(c1.ok && c1.bytes === 1000);
  const c2 = await (await H("/bridge/pair/file/chunk/" + init.fileId + "?n=1", { method: "POST", body: content.subarray(1000) })).json();
  assert.ok(c2.ok && c2.bytes === content.length);
  // 未 complete 前下载 → 409
  assert.equal((await H("/bridge/pair/file/" + init.fileId + "?instanceId=" + SELF_ID + "&secret=" + SELF_SECRET, {})).status, 409, "not ready -> no download");
  const done = await (await H("/bridge/pair/file/complete/" + init.fileId, { method: "POST" })).json();
  assert.ok(done.ok && done.file.size === content.length);
  // 超限
  const big = await (await H("/bridge/pair/file/init", { method: "POST", body: JSON.stringify({ ...AUTH, to: "all", name: "big.bin", size: 300 * 1024 * 1024 }) })).json();
  assert.ok(big.error, "over 200MB cap rejected");
});

test("file download receiver check (A4 normalization): receiver passes via pageId / bare iid / device name, stranger rejected", async () => {
  const { p, H, AUTH } = mkPair("dl");
  const content = Buffer.from("RECEIVER-DOWNLOAD-OK");
  const init = await (await H("/bridge/pair/file/init", { method: "POST", body: JSON.stringify({ ...AUTH, to: OTHER_ID + "/host", name: "a.bin", size: content.length }) })).json();
  await H("/bridge/pair/file/chunk/" + init.fileId + "?n=0", { method: "POST", body: content });
  await H("/bridge/pair/file/complete/" + init.fileId, { method: "POST" });
  const url = (iid) => "/bridge/pair/file/" + init.fileId + "?instanceId=" + encodeURIComponent(iid) + "&secret=x";
  // receiver via full pageId form — 403 before the fix
  assert.equal((await H(url(OTHER_ID + "/host"), {})).status, 200, "receiver pageId-form download 200 (fix #2)");
  // receiver via bare iid
  assert.equal((await H(url(OTHER_ID), {})).status, 200, "receiver bare instanceId download 200");
  // sender self
  assert.equal((await H(url(SELF_ID), {})).status, 200, "sender self download 200");
  // unrelated third party
  const p3 = mkPair("dl3", { verifyFail: false });
  void p3;
  const stranger = createPairModule({ TAG: "[s]", dataDir: tmpDir("dl-stranger"), cors: {}, json: (b, st) => new Response(JSON.stringify(b), { status: st || 200 }), sseResponse: () => { throw new Error("no"); }, getDevices: () => [], routeSend: () => ({ ok: true, delivered: [] }), validateInstance: () => true });
  const HS = (p2, opt) => stranger.handle(new Request("http://x" + p2, opt), p2.split("?")[0].split("/").filter(Boolean), new URLSearchParams(p2.split("?")[1] || ""));
  // stranger downloads from its own bridge registry -> 404 (separate registry per instance)
  assert.equal((await HS(url(OTHER_ID + "/host"), {})).status, 404, "unrelated instance registry has no such file");
});

test("file download receiver check: to=device name (listDevices row) -> receiver 200 (aiti_pair_file by-name push)", async () => {
  const { H, AUTH } = mkPair("dl-name");
  const content = Buffer.from("BY-NAME-DOWNLOAD");
  const init = await (await H("/bridge/pair/file/init", { method: "POST", body: JSON.stringify({ ...AUTH, to: "其他页面 · Chrome", name: "n.bin", size: content.length }) })).json();
  await H("/bridge/pair/file/chunk/" + init.fileId + "?n=0", { method: "POST", body: content });
  await H("/bridge/pair/file/complete/" + init.fileId, { method: "POST" });
  const dl = await H("/bridge/pair/file/" + init.fileId + "?instanceId=" + OTHER_ID + "&secret=x", {});
  assert.equal(dl.status, 200, "to=device name -> that named device can download");
  const dl2 = await H("/bridge/pair/file/" + init.fileId + "?instanceId=" + SELF_ID + "&secret=x", {});
  assert.equal(dl2.status, 200, "sender self can always download");
});

test("listPeers outputs explicitly registered external web devices (A2: peers keyed), page devices never duplicated here", async () => {
  const { p, H, AUTH } = mkPair("peers");
  assert.deepEqual(p.listPeers(), [], "no pair devices initially");
  const reg = await (await H("/bridge/pair/register", { method: "POST", body: JSON.stringify({ name: "外部手机", ua: "test" }) })).json();
  assert.ok(reg.ok && reg.peerId && reg.token, "register works (fed relay compat)");
  // idempotent peerId reuse
  const reg2 = await (await H("/bridge/pair/register", { method: "POST", body: JSON.stringify({ peerId: reg.peerId, name: "外部手机" }) })).json();
  assert.equal(reg2.peerId, reg.peerId, "peerId idempotent reuse");
  const rows = p.listPeers();
  assert.equal(rows.length, 1, "one pair device row");
  assert.equal(rows[0].id, reg.peerId, "id=peerId");
  assert.equal(rows[0].kind, "pair", "kind=pair");
  assert.equal(rows[0].pending, 0, "pending field exposed");
  void AUTH;
});

test("resolvePeerFuzzy: exact peerId / unique name / ambiguous name / no match", () => {
  const { p, H } = mkPair("fuzzy");
  void H;
  const r1 = p.register({ name: "手机A" });
  const r2 = p.register({ name: "手机B" });
  assert.equal(p.resolvePeerFuzzy(r1.peerId).hit.peerId, r1.peerId, "exact peerId");
  assert.equal(p.resolvePeerFuzzy("手机A").hit.peerId, r1.peerId, "unique name hit");
  const multi = p.register({ name: "重复" });
  p.register({ peerId: "p_dup1", name: "重复" });
  void multi;
  assert.ok(p.resolvePeerFuzzy("重复").multiple, "same name -> multiple candidates");
  assert.ok(p.resolvePeerFuzzy("不存在").none, "no match");
  void r2;
});

test("rename (B3/decision #4): POST /pair/name -> nameFor applied + message fromDev prefers custom name", async () => {
  const { p, H, AUTH, calls } = mkPair("name");
  const bad = await (await H("/bridge/pair/name", { method: "POST", body: JSON.stringify({ instanceId: "ai-wrong", name: "x" }) })).json();
  assert.ok(String(bad.error).indexOf("bad instanceId") === 0, "unknown instanceId rejected");
  const r = await (await H("/bridge/pair/name", { method: "POST", body: JSON.stringify({ ...AUTH, name: "张三的工作台" }) })).json();
  assert.ok(r.ok && r.name === "张三的工作台", "rename ok");
  assert.equal(p.nameFor(SELF_ID), "张三的工作台", "nameFor applied");
  assert.equal(p.nameFor(SELF_ID + "/host"), "张三的工作台", "nameFor accepts pageId form");
  // page identity prefers custom name (no msg.name) — verified via message endpoint's routeSend fromDev.name
  await H("/bridge/pair/message", { method: "POST", body: JSON.stringify({ ...AUTH, to: "all", text: "x" }) });
  const last = calls.routeSend[calls.routeSend.length - 1];
  assert.equal(last.fromDev.name, "张三的工作台", "page identity name = custom name");
  const empty = await (await H("/bridge/pair/name", { method: "POST", body: JSON.stringify({ ...AUTH, name: "  " }) })).json();
  assert.ok(empty.error, "empty name rejected");
});

test("sweep: expired relay file cleared from registry + disk + expired custom names cleaned", async () => {
  const dataDir = tmpDir("sweep");
  const { p, H, AUTH } = mkPair("sweep", { dataDir });
  const init = await (await H("/bridge/pair/file/init", { method: "POST", body: JSON.stringify({ ...AUTH, to: "all", name: "a.bin", size: 10 }) })).json();
  await H("/bridge/pair/file/chunk/" + init.fileId + "?n=0", { method: "POST", body: Buffer.alloc(10, 7) });
  await H("/bridge/pair/file/complete/" + init.fileId, { method: "POST" });
  const info = p.getFileInfo(init.fileId);
  await H("/bridge/pair/name", { method: "POST", body: JSON.stringify({ ...AUTH, name: "临时代号" }) });
  assert.ok(p.nameFor(SELF_ID));
  p.sweep(Date.now() + 2 * 3600 * 1000); // shift clock forward 2h (FILE_TTL default 1h)
  assert.equal(p.getFileInfo(init.fileId), null, "expired file cleared from registry");
  const { existsSync } = await import("node:fs");
  assert.ok(!existsSync(info.path), "expired file deleted from disk");
  assert.equal(p.nameFor(SELF_ID), null, "expired custom name cleaned");
});

test("integration: message auth under createBridge (claim instanceId+secret) -> agent delivery intact + pair device fallback routing (A3)", async () => {
  const b = createBridge(tmpDir("integ"), { name: "t" });
  const H = (p2, opt) => b.handle(
    new Request("http://x" + p2, opt),
    p2.split("?")[0].split("/").filter(Boolean),
    new URLSearchParams(p2.split("?")[1] || "")
  );
  const claim = await (await H("/bridge/claim", { method: "POST", body: JSON.stringify({ pageKey: "t-page", hostUrl: "http://x/" }) })).json();
  await b.callTool("aiti_hello", { agentId: "pi", sessionId: "s1" }, { agentId: "pi", id: "s1" });
  const r = await (await H("/bridge/pair/message", { method: "POST", body: JSON.stringify({ instanceId: claim.instanceId, secret: claim.secret, to: "pi/s1", text: "来自页面" }) })).json();
  assert.ok(r.ok, "page identity delivery ok");
  const inbox = JSON.parse((await b.callTool("aiti_inbox", {}, { agentId: "pi", id: "s1", agentKey: "pi/s1" })).content[0].text);
  const m = inbox.messages.find((x) => x.kind === "user_message");
  assert.ok(m, "agent received");
  assert.ok(m.text.includes("[发自 pair: "), "source label preserved");
  assert.ok(m.payload.source === "pair", "structured source");
  const bad = await (await H("/bridge/pair/message", { method: "POST", body: JSON.stringify({ instanceId: "ai-not-registered", secret: "x", to: "pi/s1", text: "x" }) })).json();
  assert.ok(String(bad.error).indexOf("bad instanceId") === 0, "unknown instanceId rejected");
  // agent-session sender: labeled with the agent-style attribution prefix (never pair/human) +
  // fromDevice.kind=agent; omitting to rejects the default broadcast
  await b.callTool("aiti_hello", { agentId: "pi2", sessionId: "s2" }, { agentId: "pi2", id: "s2" });
  const sent = JSON.parse((await b.callTool("aiti_pair_send", { to: "pi2/s2", text: "会话互连" }, { agentId: "pi", id: "s1", agentKey: "pi/s1" })).content[0].text);
  assert.ok(sent.ok, "agent->agent 定向发送 ok");
  const inbox2 = JSON.parse((await b.callTool("aiti_inbox", {}, { agentId: "pi2", id: "s2", agentKey: "pi2/s2" })).content[0].text);
  const m2 = inbox2.messages.find((x) => x.kind === "user_message");
  assert.ok(m2 && m2.text.includes("[发自 session: "), "agent 发送方标 session（非 pair/人）");
  assert.ok(m2.payload && m2.payload.fromDevice && m2.payload.fromDevice.kind === "agent", "fromDevice.kind=agent（接收端措辞依据）");
  const noTo = JSON.parse((await b.callTool("aiti_pair_send", { text: "无目标" }, { agentId: "pi", id: "s1", agentKey: "pi/s1" })).content[0].text);
  assert.ok(!noTo.ok && Array.isArray(noTo.candidates), "省略 to 拒绝缺省群发并返回候选清单");
  // A3: after registering a pair device, message to=peerId/name -> deliverToPeer
  const reg = await (await H("/bridge/pair/register", { method: "POST", body: JSON.stringify({ name: "外部手机" }) })).json();
  const toPeer = await (await H("/bridge/pair/message", { method: "POST", body: JSON.stringify({ instanceId: claim.instanceId, secret: claim.secret, to: reg.peerId, text: "给 pair 设备" }) })).json();
  assert.ok(toPeer.ok, "pair fallback routing hits peerId");
  const inboxPeers = b.pair().listPeers().filter((x) => x.id === reg.peerId);
  assert.ok(inboxPeers.length === 1 && b.pair(), "pair device in unified view");
  const toPeerByName = await (await H("/bridge/pair/message", { method: "POST", body: JSON.stringify({ instanceId: claim.instanceId, secret: claim.secret, to: "外部手机", text: "按名" }) })).json();
  assert.ok(toPeerByName.ok, "pair fallback routing hits name");
  void H;
});


test("page inbox (dual-write catch-up): notePageInbox/pullPageInbox + seq continuation", () => {
  const { p, H, AUTH } = mkPair("pinbox");
  p.notePageInbox("ai-x", { id: "m1", type: "text", text: "a" });
  p.notePageInbox("ai-x", { id: "m2", type: "text", text: "b" });
  const pull1 = p.pullPageInbox("ai-x", 0);
  assert.equal(pull1.items.length, 2);
  assert.equal(pull1.seq, 2);
  const pull2 = p.pullPageInbox("ai-x", 1);
  assert.equal(pull2.items.length, 1);
  assert.equal(pull2.items[0].env.id, "m2");
  p.notePageInbox("ai-x/host", { id: "m3", type: "text", text: "c" }); // pageId form maps to bare iid
  const pull3 = p.pullPageInbox("ai-x/host", 2);
  assert.equal(pull3.items.length, 1);
  assert.equal(pull3.items[0].env.id, "m3");
  assert.deepEqual(p.pullPageInbox("unknown", 0).items, []);
  void H; void AUTH;
});
