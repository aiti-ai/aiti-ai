/**
 * pair 模块单测（方案 docs/aiti-bridge-pair-plan.md）
 *
 * 契约：/bridge/pair/* REST 协议 + 统一设备视图（bridge_status.devices 与 /pair/devices 同源）
 *   + 跨 kind 路由（pair↔agent 标注 / pair↔pair inbox / 文件中转三步上传下载）+ token 校验 + MCP 三工具。
 * Run: node --experimental-strip-types --test pair.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createBridge } from "./bridge.ts";

// os.tmpdir() sandbox: the old helper hardcoded "/tmp/..." — on Windows Node resolves it
// against the current drive (D:\tmp\..., polluting the drive root, never cleaned);
// basename for name assertions (split("/") returns the whole string on win paths)
const PAIR_TMP = mkdtempSync(join(tmpdir(), "bridge-pair-test-"));
function tmpDir(tag) {
  return join(PAIR_TMP, tag + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
}

test.after(() => { try { rmSync(PAIR_TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

function mkBridge(tag) {
  const b = createBridge(tmpDir(tag), { name: "t" });
  const H = (p, opt) => b.handle(
    new Request("http://x" + p, opt),
    p.split("?")[0].split("/").filter(Boolean),
    new URLSearchParams((p.split("?")[1] || ""))
  );
  const reg = async (peerId, name) => (await (await H("/bridge/pair/register", { method: "POST", body: JSON.stringify({ peerId, name }) })).json());
  return { b, H, reg };
}

test("register：首次分配 token，同 peerId 幂等复用（刷新不丢身份）", async () => {
  const { H, reg } = mkBridge("reg");
  const r1 = await reg("p_a", "手机A");
  assert.ok(r1.ok && r1.peerId === "p_a" && /^t_/.test(r1.token));
  const r2 = await reg("p_a", "手机A改名");
  assert.equal(r2.token, r1.token, "同 peerId 复用 token");
  const bad = await H("/bridge/pair/inbox?peer=p_a&token=wrong", {});
  assert.equal(bad.status, 401, "错误 token 401");
});

test("统一设备视图：/pair/devices 与 bridge_status.devices 同源（page/agent/pair 三类）", async () => {
  const { b, H, reg } = mkBridge("dev");
  await reg("p_a", "手机A");
  await b.callTool("aiti_hello", { agentId: "pi", sessionId: "s1", name: "pi·A", cwd: "/w" }, { agentId: "pi", id: "s1" });
  const dev = (await (await H("/bridge/pair/devices", {})).json()).devices;
  assert.ok(dev.some((d) => d.kind === "pair" && d.name === "手机A"));
  assert.ok(dev.some((d) => d.kind === "agent" && d.cwd === "/w"));
  const bs = JSON.parse((await b.callTool("bridge_status", {}, { agentId: "pi", id: "s1", agentKey: "pi/s1" })).content[0].text);
  assert.ok(Array.isArray(bs.devices), "bridge_status 带 devices");
  assert.deepEqual(bs.devices.map((d) => d.kind + ":" + d.id).sort(), dev.map((d) => d.kind + ":" + d.id).sort(), "两处同源");
  assert.ok(Array.isArray(bs.sessions), "sessions 保留（存量消费方不破坏）");
});

test("pair→agent：REST message 投递 outbox，[发自 pair: <名>] 标注可见（aiti_inbox 拉取）", async () => {
  const { b, H, reg } = mkBridge("pa");
  await reg("p_a", "手机A");
  await b.callTool("aiti_hello", { agentId: "pi", sessionId: "s1" }, { agentId: "pi", id: "s1" });
  const r = await (await H("/bridge/pair/message", { method: "POST", body: JSON.stringify({ peer: "p_a", token: (await reg("p_a", "手机A")).token, to: "pi/s1", text: "看看报错" }) })).json();
  assert.ok(r.ok, "投递成功");
  const inbox = JSON.parse((await b.callTool("aiti_inbox", {}, { agentId: "pi", id: "s1", agentKey: "pi/s1" })).content[0].text);
  const m = inbox.messages.find((x) => x.kind === "user_message");
  assert.ok(m, "agent 收到");
  assert.ok(m.text.includes("[发自 pair: 手机A]"), "来源标注");
  assert.equal(m.payload.source, "pair", "结构化 source（调用方显式值不被 transport 覆写）");
  assert.equal(m.payload.sourceLabel, "Pair · 手机A", "结构化 sourceLabel");
});

test("agent→pair：aiti_pair_send 名字模糊命中；多候选返回清单不误发", async () => {
  const { b, reg } = mkBridge("ap");
  const t = (await reg("p_a", "手机A")).token;
  await b.callTool("aiti_hello", { agentId: "pi", sessionId: "s1" }, { agentId: "pi", id: "s1" });
  const s = JSON.parse((await b.callTool("aiti_pair_send", { to: "手机", text: "完成" }, { agentId: "pi", id: "s1", agentKey: "pi/s1" })).content[0].text);
  assert.ok(s.ok, "模糊命中直发");
  const ib = (await (await b.pair().handle(new Request("http://x/bridge/pair/inbox?peer=p_a&token=" + t), ["bridge", "pair", "inbox"], new URLSearchParams("peer=p_a&token=" + t))).json());
  assert.ok(ib.pending.some((m) => m.type === "text" && m.from.kind === "agent"), "pair inbox 收到 agent 消息");
  // 多候选：注册第二个同名含"手机"的设备
  await reg("p_b", "手机B");
  const s2 = JSON.parse((await b.callTool("aiti_pair_send", { to: "手机", text: "x" }, { agentId: "pi", id: "s1", agentKey: "pi/s1" })).content[0].text);
  assert.equal(s2.ok, false);
  assert.ok(Array.isArray(s2.candidates) && s2.candidates.length === 2, "多候选返回清单");
});

test("pair→pair：message 跨 pair 投递（inbox 恢复 + 消费即清）", async () => {
  const { H, reg } = mkBridge("pp");
  const ta = (await reg("p_a", "手机A")).token;
  await reg("p_b", "手机B");
  const r = await (await H("/bridge/pair/message", { method: "POST", body: JSON.stringify({ peer: "p_a", token: ta, to: "手机B", text: "直接传你" }) })).json();
  assert.ok(r.ok);
  const ib1 = (await (await H("/bridge/pair/inbox?peer=p_b&token=" + (await reg("p_b", "手机B")).token, {})).json());
  assert.equal(ib1.pending.length, 1);
  assert.equal(ib1.pending[0].from.name, "手机A");
  const ib2 = (await (await H("/bridge/pair/inbox?peer=p_b&token=" + (await reg("p_b", "手机B")).token, {})).json());
  assert.equal(ib2.pending.length, 0, "拉取即清（不重复消费）");
});

test("文件中转：init/chunk/complete 三步 + 下载一致 + 尺寸闸门", async () => {
  const { b, H, reg } = mkBridge("file");
  const t = (await reg("p_a", "手机A")).token;
  const src = tmpDir("src") + ".bin";
  const content = Buffer.from("PAIR-FILE-" + "x".repeat(5000));
  writeFileSync(src, content);
  const init = await (await H("/bridge/pair/file/init", { method: "POST", body: JSON.stringify({ peer: "p_a", token: t, to: "all", name: "a.bin", size: content.length, mime: "application/octet-stream" }) })).json();
  assert.ok(init.ok);
  const c1 = await (await H("/bridge/pair/file/chunk/" + init.fileId + "?n=0", { method: "POST", body: content.subarray(0, 1000) })).json();
  assert.ok(c1.ok && c1.bytes === 1000);
  const c2 = await (await H("/bridge/pair/file/chunk/" + init.fileId + "?n=1", { method: "POST", body: content.subarray(1000) })).json();
  assert.ok(c2.ok && c2.bytes === content.length, "收齐即凑满（c2=" + JSON.stringify(c2) + "）");
  // 未 complete 前下载 → 409
  assert.equal((await H("/bridge/pair/file/" + init.fileId + "?peer=p_a&token=" + t, {})).status, 409, "未 ready 不下载");
  const done = await (await H("/bridge/pair/file/complete/" + init.fileId, { method: "POST" })).json();
  assert.ok(done.ok && done.file.size === content.length);
  // 下载内容一致
  const dl = await H("/bridge/pair/file/" + init.fileId + "?peer=p_a&token=" + t, {});
  assert.equal(dl.status, 200);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(content), "下载内容一致");
  // 超限
  const big = await (await H("/bridge/pair/file/init", { method: "POST", body: JSON.stringify({ peer: "p_a", token: t, to: "all", name: "big.bin", size: 300 * 1024 * 1024 }) })).json();
  assert.ok(big.error, "超 200MB 上限拒绝");
  void b;
});

test("MCP aiti_pair_file：agent 推本地文件 → pair 收 file-meta → 下载一致", async () => {
  const { b, H, reg } = mkBridge("mf");
  const t = (await reg("p_a", "手机A")).token;
  await b.callTool("aiti_hello", { agentId: "pi", sessionId: "s1" }, { agentId: "pi", id: "s1" });
  const src = tmpDir("rep") + ".txt";
  const content = Buffer.from("报告内容".repeat(100));
  writeFileSync(src, content);
  const pf = JSON.parse((await b.callTool("aiti_pair_file", { to: "手机A", path: src }, { agentId: "pi", id: "s1", agentKey: "pi/s1" })).content[0].text);
  assert.ok(pf.ok && pf.fileId && pf.name === basename(src));
  const ib = (await (await H("/bridge/pair/inbox?peer=p_a&token=" + t, {})).json());
  const fm = ib.pending.find((m) => m.type === "file");
  assert.ok(fm && fm.file.fileId === pf.fileId, "file-meta 到达 pair");
  const dl = await H("/bridge/pair/file/" + fm.file.fileId + "?peer=p_a&token=" + t, {});
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(content));
});

test("MCP aiti_pair_fetch：pair 推文件给 agent → 落盘一致（缺省 pair-inbox 目录）", async () => {
  const { b, H, reg } = mkBridge("fetch");
  const t = (await reg("p_a", "手机A")).token;
  await b.callTool("aiti_hello", { agentId: "pi", sessionId: "s1" }, { agentId: "pi", id: "s1" });
  const content = Buffer.from("手机拍的照片");
  const init = await (await H("/bridge/pair/file/init", { method: "POST", body: JSON.stringify({ peer: "p_a", token: t, to: "pi/s1", name: "cam.jpg", size: content.length, mime: "image/jpeg" }) })).json();
  await H("/bridge/pair/file/chunk/" + init.fileId + "?n=0", { method: "POST", body: content });
  await H("/bridge/pair/file/complete/" + init.fileId, { method: "POST" });
  const r = JSON.parse((await b.callTool("aiti_pair_fetch", { fileId: init.fileId }, { agentId: "pi", id: "s1", agentKey: "pi/s1" })).content[0].text);
  assert.ok(r.ok && r.path.includes("pair-inbox") && r.name === "cam.jpg");
  assert.ok(readFileSync(r.path).equals(content), "落盘内容一致");
});

test("agent 发起 pair 文件对 agent 投递：file-meta 进 outbox（aiti_inbox 可见）", async () => {
  const { b, reg } = mkBridge("meta");
  await reg("p_a", "手机A");
  await b.callTool("aiti_hello", { agentId: "pi", sessionId: "s1" }, { agentId: "pi", id: "s1" });
  const src = tmpDir("m2") + ".txt";
  writeFileSync(src, "hi");
  await b.callTool("aiti_pair_file", { to: "pi/s1", path: src }, { agentId: "pi", id: "s1", agentKey: "pi/s1" });
  const inbox = JSON.parse((await b.callTool("aiti_inbox", {}, { agentId: "pi", id: "s1", agentKey: "pi/s1" })).content[0].text);
  const m = inbox.messages.find((x) => x.kind === "pair_file");
  assert.ok(m, "pair_file 消息进 outbox");
  assert.ok(m.payload.file && m.payload.file.fileId, "payload.file 带 fileId");
});

test("设备视图与群发：显式注册 agent 全部可见；群发 all 投其他 pair（跳过发送者）+ 全部已注册 agent", async () => {
  const { b, H, reg } = mkBridge("all");
  const t = (await reg("p_a", "手机A")).token;
  await reg("p_b", "手机B");
  await b.callTool("aiti_hello", { agentId: "pi", sessionId: "s1" }, { agentId: "pi", id: "s1" });
  await b.callTool("aiti_hello", { agentId: "cc", sessionId: "s2" }, { agentId: "cc", id: "s2" });
  const dev = (await (await H("/bridge/pair/devices", {})).json()).devices;
  assert.ok(dev.some((d) => d.id === "pi/s1") && dev.some((d) => d.id === "cc/s2"), "注册 agent 进视图");
  // 群发
  const r = await (await H("/bridge/pair/message", { method: "POST", body: JSON.stringify({ peer: "p_a", token: t, to: "all", text: "广播" }) })).json();
  assert.ok(r.ok);
  assert.ok(r.delivered.some((d) => d.kind === "pair" && d.id === "p_b"), "群发含其他 pair 端");
  assert.ok(!r.delivered.some((d) => d.kind === "pair" && d.id === "p_a"), "跳过发送者自身（本端本地已回显）");
  assert.ok(r.delivered.filter((d) => d.kind === "agent").length === 2, "群发含全部已注册 agent");
  // 发给自己：幂等不报错、不投递
  const self = await (await H("/bridge/pair/message", { method: "POST", body: JSON.stringify({ peer: "p_a", token: t, to: "p_a", text: "自言自语" }) })).json();
  assert.equal(self.ok, true, "自发自 conversation ok（空投递）");
  assert.equal((self.delivered || []).length, 0, "自投递为零");
});

test("TTL 清理：sweep(now) 时间前移 → 掉线 peer/过期文件/孤儿文件三路清空（替代 1h 挂机观察）", async () => {
  const { b, H, reg } = mkBridge("ttl");
  const t = (await reg("p_a", "手机A")).token;
  await reg("p_b", "手机B");
  // 一个 ready 文件 + 一个孤儿文件（registry 丢失，磁盘残留，mtime 回拨 2h）
  const init = await (await H("/bridge/pair/file/init", { method: "POST", body: JSON.stringify({ peer: "p_a", token: t, to: "all", name: "a.bin", size: 10 }) })).json();
  await H("/bridge/pair/file/chunk/" + init.fileId + "?n=0", { method: "POST", body: Buffer.alloc(10, 7) });
  await H("/bridge/pair/file/complete/" + init.fileId, { method: "POST" });
  const { utimesSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const filesDir = dirname(b.pair().getFileInfo(init.fileId).path); // 真实 pair-files 目录（bridge dataDir 下）
  writeFileSync(filesDir + "/f_orphan", "x");
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  utimesSync(filesDir + "/f_orphan", old, old);
  // 时间前移 2h sweep（PAIR_PEER_TTL/PAIR_FILE_TTL 默认 1h）
  b.pair().sweep(Date.now() + 2 * 3600 * 1000);
  const dev = (await (await H("/bridge/pair/devices", {})).json()).devices;
  assert.ok(!dev.some((d) => d.kind === "pair"), "掉线 peer 全部清空（无 SSE 写者）");
  assert.equal(b.pair().getFileInfo(init.fileId), null, "过期文件 registry 清除");
  const { existsSync } = await import("node:fs");
  assert.ok(!existsSync(filesDir + "/" + init.fileId), "过期文件磁盘删除");
  assert.ok(!existsSync(filesDir + "/f_orphan"), "孤儿文件兜底清理");
});

test("上线门槛：外网 X-Real-IP 默认 403（register/events）；内网/直连放行；AITI_PAIR_TOKEN 档 B 带注册 token 放行", async () => {
  const { b, H, reg } = mkBridge("gate");
  const pub = { "x-real-ip": "203.0.113.9" };           // 公网
  const priv = { "x-real-ip": "192.168.122.23" };         // 内网
  // 公网 register → 403
  const d1 = await H("/bridge/pair/register", { method: "POST", headers: pub, body: JSON.stringify({ name: "外来机" }) });
  assert.equal(d1.status, 403, "公网注册默认挡");
  // 公网 events → 403
  const d2 = await H("/bridge/pair/events?peer=x&token=y", { headers: pub });
  assert.equal(d2.status, 403, "公网 SSE 默认挡");
  // 内网 register → 200；直连（无 X-Real-IP）→ 200
  assert.equal((await H("/bridge/pair/register", { method: "POST", headers: priv, body: JSON.stringify({ peerId: "p_in", name: "内网机" }) })).status, 200);
  assert.equal((await H("/bridge/pair/register", { method: "POST", body: JSON.stringify({ peerId: "p_direct", name: "直连机" }) })).status, 200);
  // 档 B：配 AITI_PAIR_TOKEN（createPairModule 工厂内读 env——新桥实例生效）
  process.env.AITI_PAIR_TOKEN = "reg-secret-1";
  try {
    const b2 = createBridge(tmpDir("gate2"), { name: "t2" });
    const H2 = (p, opt) => b2.handle(new Request("http://x" + p, opt), p.split("?")[0].split("/").filter(Boolean), new URLSearchParams(p.split("?")[1] || ""));
    const d3 = await H2("/bridge/pair/register", { method: "POST", headers: pub, body: JSON.stringify({ name: "带token外来机" }) });
    assert.equal(d3.status, 403, "配 token 后无 token 仍挡");
    const d4 = await H2("/bridge/pair/register", { method: "POST", headers: pub, body: JSON.stringify({ name: "带token外来机", regToken: "reg-secret-1" }) });
    assert.equal(d4.status, 200, "带对注册 token 放行（档 B）");
    const d5 = await H2("/bridge/pair/events?peer=x&token=y&reg=reg-secret-1", { headers: pub });
    assert.equal(d5.status, 401, "events 带注册 token 过门槛 → 落到 peer token 校验 401（门槛已过）");
    b2.close();
  } finally { delete process.env.AITI_PAIR_TOKEN; }
});

test("上线门槛：nginx Authelia 透传 remote-user 头 → 外网已登录用户放行（与私网 gate 协同不冲突）", async () => {
  const { H } = mkBridge("gate2");
  const pub = { "x-real-ip": "203.0.113.9", "remote-user": "wind" };
  const r = await H("/bridge/pair/register", { method: "POST", headers: pub, body: JSON.stringify({ peerId: "p_auth", name: "外网已登录" }) });
  assert.equal(r.status, 200, "Authelia 用户头放行");
  const ev = await H("/bridge/pair/events?peer=p_auth&token=" + JSON.parse(await r.text()).token, { headers: pub });
  assert.equal(ev.status, 200, "events 同样放行（SSE 流建立）");
  ev.body?.cancel().catch?.(() => {});
});
