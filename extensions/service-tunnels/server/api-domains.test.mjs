/**
 * api 新域测试（P1 服务端）：ddns / extras（port-label、portmap-probe、
 * ipv6-addresses）/ doctor SSE / capabilities。库函数为真实调用（数据落在
 * tmpdir 的 configDir/cacheDir），st 单例经 globalThis 注入 mock。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "./api.ts";
import { resetCapabilitiesCache } from "./capabilities.ts";

const dirs = [];
function makeCtx(path, search = "") {
  return { method: "", path, searchParams: new URLSearchParams(search) };
}
function setSt(st) {
  globalThis.__piServiceTunnels = st;
}
function tmpCfg() {
  const dir = mkdtempSync(join(tmpdir(), "st-ext-domains-"));
  dirs.push(dir);
  mkdirSync(join(dir, "cfg"), { recursive: true });
  mkdirSync(join(dir, "cache"), { recursive: true });
  return dir;
}
const getJson = async (r) => { const body = await r.text(); return body ? JSON.parse(body) : null; };

test.beforeEach(() => {
  globalThis.__stDoctorHub = undefined;
  resetCapabilitiesCache();
  delete process.env.ST_UI_DOCTOR_MOCK;
});

// ── DDNS 域 ──────────────────────────────────────────────────────────────────
test("ddns-registry：POST 保存 → GET 读回（与库同一 registry 文件）", async () => {
  const dir = tmpCfg();
  setSt({ dirs: { configDir: join(dir, "cfg"), cacheDir: join(dir, "cache") } });
  const registry = {
    providerProfiles: { cf: { provider: "cloudflare", token: "tk-123" } },
    profiles: { home: { providerProfile: "cf", zone: "example.com" } },
    entries: [{ name: "web", profile: "home", kind: "portmap", ip: true, txt: true }],
  };
  const post = await handleApi(new Request("http://x/api/extensions/service-tunnels/ddns-registry", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(registry),
  }), makeCtx(["ddns-registry"]));
  assert.equal(post.status, 200);
  // 落盘文件真实存在（库 readDdnsConfigs 同源）
  assert.ok(existsSync(join(dir, "cfg", "ddns.json")), "registry file written (ddns.json)");
  const get = await handleApi(new Request("http://x/ddns-registry"), makeCtx(["ddns-registry"]));
  const data = await getJson(get);
  assert.equal(data.profiles.home.zone, "example.com");
  assert.equal(data.entries[0].kind, "portmap");
});

test("ddns-registry：非法 body → 400（形状校验，不 500）", async () => {
  const dir = tmpCfg();
  setSt({ dirs: { configDir: join(dir, "cfg"), cacheDir: join(dir, "cache") } });
  for (const body of ["not-json-object", JSON.stringify({ entries: "nope" }), JSON.stringify({ providerProfiles: [] })]) {
    const r = await handleApi(new Request("http://x/ddns-registry", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    }), makeCtx(["ddns-registry"]));
    assert.equal(r.status, 400, body);
  }
});

test("ddns-providers：枚举 ≥ 40 家（库 DDNS_PROVIDERS）", async () => {
  const dir = tmpCfg();
  setSt({ dirs: { configDir: join(dir, "cfg"), cacheDir: join(dir, "cache") } });
  const r = await handleApi(new Request("http://x/ddns-providers"), makeCtx(["ddns-providers"]));
  const data = await getJson(r);
  assert.ok(Array.isArray(data.providers) && data.providers.length >= 40);
});

// ── extras 域 ────────────────────────────────────────────────────────────────
test("port-label：st.setServiceLabel（0.3.73+ 实例 API；daemon/embedded 由库内部分派）", async () => {
  const dir = tmpCfg();
  const calls = [];
  setSt({
    dirs: { configDir: join(dir, "cfg"), cacheDir: join(dir, "cache") },
    daemon: { request: async () => null },
    setServiceLabel: async (port, label) => { calls.push({ port, label }); return { port, label: label || undefined }; },
  });
  const post = await handleApi(new Request("http://x/port-label", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ port: 5173, label: "我的博客" }),
  }), makeCtx(["port-label"]));
  assert.equal(post.status, 200);
  assert.deepEqual(calls[0], { port: 5173, label: "我的博客" });
  // 留空 = 清除
  await handleApi(new Request("http://x/port-label", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ port: 5173, label: "" }),
  }), makeCtx(["port-label"]));
  assert.deepEqual(calls[1], { port: 5173, label: "" });
  // 非法端口 400
  const bad = await handleApi(new Request("http://x/port-label", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ port: 99999, label: "x" }),
  }), makeCtx(["port-label"]));
  assert.equal(bad.status, 400);
});

test("portmap-probe：实例有 probe → 透传 report；无 → 404", async () => {
  const dir = tmpCfg();
  const fixture = { gateway: "192.168.1.1", ipClass: "private", upnp: { ok: true }, recommended: "upnp" };
  setSt({ dirs: { configDir: join(dir, "cfg"), cacheDir: join(dir, "cache") }, portmap: { probe: async () => fixture } });
  const r = await handleApi(new Request("http://x/portmap-probe?gateway=192.168.1.1"), makeCtx(["portmap-probe"]));
  assert.equal(r.status, 200);
  assert.deepEqual(await getJson(r), fixture);
  // 实例无 portmap 面（旧库）→ 404
  setSt({ dirs: { configDir: join(dir, "cfg"), cacheDir: join(dir, "cache") } });
  const r2 = await handleApi(new Request("http://x/portmap-probe"), makeCtx(["portmap-probe"]));
  assert.equal(r2.status, 404);
});

test("ipv6-addresses：候选列表 + public 数组（真实本机数据，形状断言）", async () => {
  const dir = tmpCfg();
  setSt({ dirs: { configDir: join(dir, "cfg"), cacheDir: join(dir, "cache") } });
  const r = await handleApi(new Request("http://x/ipv6-addresses"), makeCtx(["ipv6-addresses"]));
  assert.equal(r.status, 200);
  const data = await getJson(r);
  assert.ok(Array.isArray(data.addresses));
  assert.ok(Array.isArray(data.public));
  for (const a of data.addresses) {
    assert.ok(typeof a.address === "string" && typeof a.scope === "string" && typeof a.iface === "string");
  }
});

// ── doctor 域 ────────────────────────────────────────────────────────────────
test("doctor：mock 关 → 404；ST_UI_DOCTOR_MOCK=1 → start 200/重复 409/SSE 帧流/stop 收口", async () => {
  const dir = tmpCfg();
  setSt({ dirs: { configDir: join(dir, "cfg"), cacheDir: join(dir, "cache") } });
  // 未开 mock → 全部 404
  let r = await handleApi(new Request("http://x/doctor-start", { method: "POST", body: "{}" }), makeCtx(["doctor-start"]));
  assert.equal(r.status, 404);
  process.env.ST_UI_DOCTOR_MOCK = "1";
  globalThis.__stDoctorHub = undefined;
  r = await handleApi(new Request("http://x/doctor-start", { method: "POST", body: "{}" }), makeCtx(["doctor-start"]));
  assert.equal(r.status, 200);
  assert.deepEqual(await getJson(r), { started: true, mock: true });
  // 重复 start → 409
  const r2 = await handleApi(new Request("http://x/doctor-start", { method: "POST", body: "{}" }), makeCtx(["doctor-start"]));
  assert.equal(r2.status, 409);
  // SSE：订阅 → 收到 id 帧序列
  const sse = await handleApi(new Request("http://x/doctor-events"), makeCtx(["doctor-events"]));
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const ids = [];
  // 单次串行读（并发 read() 会排队，队列深于产出速率时永远等不到）
  const readUntil = async (deadline) => {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((res) => setTimeout(() => res("TIMEOUT"), deadline - Date.now())),
      ]);
      if (chunk === "TIMEOUT" || chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      for (const m of buf.matchAll(/^id: (\d+)$/gm)) {
        const id = Number(m[1]);
        if (!ids.includes(id)) ids.push(id);
      }
    }
  };
  await readUntil(Date.now() + 2500);
  await handleApi(new Request("http://x/doctor-stop", { method: "POST", body: "{}" }), makeCtx(["doctor-stop"]));
  assert.ok(ids.length >= 3, "got sse frames: " + ids.join(","));
  assert.ok(ids.every((id, i) => i === 0 || id === ids[i - 1] + 1), "ids monotonic");
  try { await reader.cancel(); } catch { /* stream may have ended */ }
});

// ── capabilities ─────────────────────────────────────────────────────────────
test("/status 附 capabilities：真实 0.3.68 面（portIdentity/portmap/ipv6/ddns 全开，netcheck 关）", async () => {
  const dir = tmpCfg();
  // 最小 status 面（其余字段被 mockSt 系测试覆盖；这里只验 capabilities 接线）
  const st = {
    // 实例能力面（真实 0.3.68 实例自带；mock 显式补齐供 exposeModes 断言）
    portmap: { probe: async () => ({}) },
    ipv6: { detect: async () => [] },
    discovery: { getPorts: () => [], discoverPorts: () => [] },
    internal: { list: () => [] }, tunnels: { list: () => [], configs: () => [], tcpSupport: () => [] },
    exposes: () => [], proxy: { bindings: () => [], enrolled: () => [], status: () => ({}) },
    auth: { providers: () => [], providerOrder: () => [], defaultProvider: () => "", userManagers: () => [], totpProviders: () => [], biometricProviders: () => [], schemas: undefined },
    schemas: { tunnels: () => ({}), metas: () => ({}), authProviders: async () => ({}), authMetas: () => ({}) },
    sites: { list: () => [] }, tools: { allowDownload: () => false, list: () => [] },
    dirs: { configDir: join(dir, "cfg"), cacheDir: join(dir, "cache") },
    daemon: { status: () => ({ running: false }), request: async () => null },
    state: () => ({}),
  };
  setSt(st);
  const r = await handleApi(new Request("http://x/status"), makeCtx(["status"]));
  const data = await getJson(r);
  const caps = data.capabilities;
  assert.ok(caps, "capabilities section present");
  assert.equal(caps.netcheck, false);
  assert.equal(caps.ddnsRegistry, true);
  assert.ok(caps.exposeModes.includes("portmap"));
  assert.ok(caps.exposeModes.includes("ipv6"));
  assert.match(caps.libVersion ?? "", /^0\.3\.\d+/);
});

test.after(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
