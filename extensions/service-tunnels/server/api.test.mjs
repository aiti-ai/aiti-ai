/**
 * api.ts 单元测试 —— mock 库实例（globalThis.__piServiceTunnels）驱动 handleApi。
 * 覆盖：GET 状态/服务/日志/detect、POST 全动作、URL 兼容、fail-closed。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "./api.ts";
import { getInjectRegistry } from "./inject-registry.ts";

// 自检端口钉死 3000：产品 getPiWebPort() 读 process.env.PORT（宿主实例的 shell 常导出
// PORT=3001），不剥离则「self-expose/self-stop 回滚哪条 binding」的断言随环境漂移。
delete process.env.PORT;

// ---- mock 库实例 ----
function mockSt(overrides = {}) {
  const users = [
    { provider: "basic", users: [{ name: "alice", displayName: "Alice" }] },
  ];
  const st = {
    internal: { list: () => [{ name: "nginx", port: 80 }] },
    discovery: { getPorts: ({ force }) => [{ port: 5173, pid: 1, process: "node", cmdline: "node server.js", addresses: ["127.0.0.1"] }] },
    tunnels: {
      list: () => [{ name: "t1", type: "command", running: true, pid: 1, url: "https://t.trycloudflare.com", lastOutput: "ok" }],
      configs: () => [{ name: "expose-5173-basic", domain: "x.trycloudflare.com", token: "secret-token" }],
      start: async (name) => ({ started: name }),
      stop: async (name) => { void name; },
      stopAll: async () => {},
      tcpSupport: () => ["cloudflared", "ngrok"],
    },
    exposes: () => [
      { name: "expose-5173-basic", port: 5173, tunnelType: "cloudflared", provider: "basic", running: true, url: "https://x.trycloudflare.com", label: "basic", localUrl: "http://5173.st.localhost", baseUrl: null, domainUrl: null, accessLog: null, errorLog: null, site: "services", startedAt: null },
    ],
    auth: {
      providers: () => ["basic", "authelia"],
      providerOrder: () => ["basic", "authelia"],
      defaultProvider: () => "basic",
      totpProviders: () => ["portal"],
      userManagers: () => ["basic", "portal"],
      users: async (provider, site) => users.filter((u) => !provider || u.provider === provider),
      addUser: async (name) => [name],
      setUserPassword: async (name) => [name],
      removeUser: async (name) => [name],
      totpEnroll: async (name) => ({ qr: "data:image/png;base64,xxx", secret: "SECRET123" }),
      totpDefaultLabel: async () => ({ label: "pi-web@localhost" }),
      totpDisable: async () => {},
      totpStatus: async (name) => ({ enrolled: name === "alice" }),
      totpActivate: async (name) => ({ activated: name }),
      expose: async (port, opts) => ({ port, tunnel: `expose-${port}-${opts.provider ?? "direct"}`, label: opts.label ?? "", url: `https://${port}.trycloudflare.com`, mode: opts.mode ?? "tunnel", site: opts.site ?? "default", protocol: opts.protocol ?? "http", localUrl: null, baseUrl: null }),
    },
    schemas: {
      tunnels: (lang) => ({ cloudflared: [{ key: "domain", label: "Domain" }] }), // 同步（库签名）
      metas: () => ({ cloudflared: { favorite: true, dangerous: false } }),
      authProviders: async () => ({ basic: [{ key: "user", type: "text", label: "User" }] }), // 异步（库签名）
      authMetas: () => ({ basic: { label: "Basic" } }),
    },
    tools: { allowDownload: () => true, list: () => [{ name: "cloudflared", path: null, source: null }], setAllowDownload: (v) => { void v; } },
    daemon: { status: () => ({ running: false }) },
    sites: { list: () => [{ name: "default" }, { name: "pi-web" }, { name: "services" }] },
    proxy: { status: () => ({ mode: "embedded" }), bindings: () => [], addBinding: () => {}, removeBinding: () => {} },
    ...overrides,
  };
  return st;
}

function setSt(st) {
  globalThis.__piServiceTunnels = st;
}

const ctx = { method: "GET", path: [], searchParams: new URLSearchParams(), configDir: "/tmp/st-test-data", core: { fileAccess: { allowRoot: () => {} } } };
const json = (r) => r.json();

test("GET /services — 发现列表 + 后缀 + 隧道 + 平台", async () => {
  setSt(mockSt());
  const res = await handleApi(new Request("http://x/api/extensions/service-tunnels/services?refresh=1"), { ...ctx, path: ["services"], searchParams: new URLSearchParams("refresh=1") });
  assert.equal(res.status, 200);
  const d = await json(res);
  assert.equal(d.services.length, 1);
  assert.equal(d.services[0].port, 5173);
  assert.ok(d.serviceHostSuffixes.includes(".pi.localhost"));
  assert.equal(d.tunnels[0].name, "t1");
  assert.equal(d.platform, process.platform);
});

test("GET /status — 完整状态形状（providers/schemas/exposes/self/presets）", async () => {
  setSt(mockSt());
  const res = await handleApi(new Request("http://x/api/extensions/service-tunnels/status?lang=en"), { ...ctx, path: ["status"], searchParams: new URLSearchParams("lang=en") });
  assert.equal(res.status, 200);
  const d = await json(res);
  assert.ok(Array.isArray(d.services));
  assert.ok(Array.isArray(d.internal));
  assert.equal(d.exposes[0].name, "expose-5173-basic");
  // 掩码：token 只留末 4 位
  assert.equal(d.exposes[0].params.token, "••••oken");
  assert.deepEqual(d.providers, ["basic", "authelia"]);
  assert.ok(d.tunnelSchemas.cloudflared);
  assert.ok(d.authProviderSchemas.basic);
  assert.equal(d.self.port, 3000);
  assert.ok(d.exposePresets);
});

test("GET /status?self-only=1 — 轻量 self 状态", async () => {
  setSt(mockSt());
  const res = await handleApi(new Request("http://x/api/extensions/service-tunnels/status?self-only=1"), { ...ctx, path: ["status"], searchParams: new URLSearchParams("self-only=1") });
  const d = await json(res);
  assert.ok("self" in d);
  assert.ok(!("services" in d));
});

test("GET /status?logs=<name> — 读 expose 日志（tail 50）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "st-logs-"));
  const log = join(dir, "x.access.log");
  writeFileSync(log, Array.from({ length: 60 }, (_, i) => `line${i}`).join("\n"));
  setSt(mockSt({
    exposes: () => [{ name: "e1", accessLog: log, errorLog: null, port: 5173, running: true, url: null, site: "services" }],
  }));
  const res = await handleApi(new Request("http://x/api/extensions/service-tunnels/status?logs=e1"), { ...ctx, path: ["status"], searchParams: new URLSearchParams("logs=e1") });
  const d = await json(res);
  assert.ok(d.access.includes("line10")); // 只 tail 50
  assert.ok(!d.access.includes("line0"));
  rmSync(dir, { recursive: true, force: true });
});

test("GET /status?logs=missing — 404", async () => {
  setSt(mockSt());
  const res = await handleApi(new Request("http://x/api/extensions/service-tunnels/status?logs=nope"), { ...ctx, path: ["status"], searchParams: new URLSearchParams("logs=nope") });
  assert.equal(res.status, 404);
});

test("GET /status?detect=<port> — 协议探测", async () => {
  setSt(mockSt());
  const res = await handleApi(new Request("http://x/api/extensions/service-tunnels/status?detect=5173"), { ...ctx, path: ["status"], searchParams: new URLSearchParams("detect=5173") });
  const d = await json(res);
  assert.equal(d.port, 5173);
  assert.ok(["http", "https", "tcp"].includes(d.protocol));
});

test("POST expose — 调用库 expose + 记录 last-used", async () => {
  let exposed;
  setSt(mockSt({
    auth: { ...mockSt().auth, expose: async (port, opts) => { exposed = { port, opts }; return { port, tunnel: `expose-${port}-direct`, url: `https://${port}.trycloudflare.com`, mode: "proxy", site: "default", protocol: "http" }; } },
  }));
  const res = await handleApi(new Request("http://x/api/extensions/service-tunnels/status", { method: "POST", body: JSON.stringify({ action: "expose", port: 5173, mode: "proxy" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal(res.status, 200);
  const d = await json(res);
  assert.equal(d.port, 5173);
  assert.equal(exposed.opts.mode, "proxy");
  assert.equal(exposed.opts.startTransport, false);
  // last-used 已落盘（可被 preset-load __last__ 读回）
  const last = await handleApi(new Request("http://x/api/extensions/service-tunnels/status", { method: "POST", body: JSON.stringify({ action: "preset-load", id: "__last__" }) }), { ...ctx, method: "POST", path: ["status"] });
  const ld = await json(last);
  assert.equal(ld.config.mode, "proxy");
});

test("POST expose — 非法端口 400 / command 隧道 400", async () => {
  setSt(mockSt());
  const bad = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "expose", port: 999999 }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal(bad.status, 400);
  const cmd = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "expose", port: 5173, tunnel: "command" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal(cmd.status, 400);
});

test("POST tunnel-start/stop/stop-all", async () => {
  let stopped = "";
  setSt(mockSt({ tunnels: { ...mockSt().tunnels, stop: async (name) => { stopped = name; } } }));
  const start = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "tunnel-start", name: "t1" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal((await json(start)).started, "t1");
  await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "tunnel-stop", name: "t1" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal(stopped, "t1");
  const all = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "tunnel-stop-all" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal((await json(all)).ok, true);
});

test("POST user-* — add/set-password/remove/list/managers", async () => {
  setSt(mockSt());
  const add = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "user-add", name: "bob", password: "pw" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal((await json(add)).added, "bob");
  const list = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "user-list" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal((await json(list)).users[0].users[0].name, "alice");
  const missing = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "user-add", name: "bob" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal(missing.status, 400);
});

test("POST totp-* — enroll/default-label/status/activate/disable", async () => {
  setSt(mockSt());
  const enroll = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "totp-enroll", name: "alice", provider: "portal" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.ok((await json(enroll)).secret);
  const label = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "totp-default-label", name: "alice" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.ok((await json(label)).label);
  const st = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "totp-status", name: "alice" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal((await json(st)).enrolled, true);
  const act = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "totp-activate", name: "alice", code: "123456" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal((await json(act)).activated, "alice");
});

test("POST self-* — expose/stop/allowlocal/allowhosts", async () => {
  setSt(mockSt());
  const exp = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "self-expose", mode: "proxy", provider: "none" }) }), { ...ctx, method: "POST", path: ["status"] });
  const ed = await json(exp);
  assert.equal(ed.ok, true);
  // allowlocal=false 需 ttlMs（两阶段）
  const al = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "self-allowlocal", allowLocal: false }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal(al.status, 400);
  const al2 = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "self-allowlocal", allowLocal: false, ttlMs: 1000 }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal((await json(al2)).allowLocal, false);
  const hosts = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "self-allowhosts", hosts: ["backup.example.com"] }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.ok((await json(hosts)).allowHosts.includes("backup.example.com"));
  const stop = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "self-stop" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal((await json(stop)).ok, true);
});

test("POST self-expose — portmap/ipv6 参数（M3 对齐：白名单过滤 + 透传）", async () => {
  const calls = [];
  setSt(mockSt({
    auth: {
      expose: async (port, opts) => {
        calls.push({ port, opts });
        return { url: null, tunnel: "", mode: opts.mode, site: opts.site, label: opts.label, protocol: "http", localUrl: null, baseUrl: null };
      },
    },
  }));
  const res = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({
    action: "self-expose", mode: "portmap", provider: "none",
    portmap: { method: "upnp", gateway: "192.168.1.1", externalPort: 8080, bogus: "drop" },
    ipv6: { address: "2001:db8::1" },
  }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal((await json(res)).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.mode, "portmap");
  // 白名单（深度 1）：bogus 丢弃；method/gateway/externalPort 保留
  assert.deepEqual(calls[0].opts.portmap, { method: "upnp", gateway: "192.168.1.1", externalPort: 8080 });
  // ipv6.address 同等透传（规则统一；实际使用由 mode 决定）
  assert.deepEqual(calls[0].opts.ipv6, { address: "2001:db8::1" });
});

test("POST self-expose — 库返回 error 时回滚预注册 binding（防 exposing 误报）", async () => {
  const removed = [];
  let bindingAdded = false;
  setSt(mockSt({
    auth: { expose: async (port, opts) => ({ url: null, tunnel: "", mode: opts.mode, site: opts.site, label: opts.label, error: "boom" }) },
    proxy: {
      status: () => ({ mode: "embedded" }),
      bindings: () => (bindingAdded ? [{ port: 3000, label: "pi-web", site: "pi-web" }] : []),
      addBinding: () => { bindingAdded = true; },
      removeBinding: (port, label) => { removed.push(`${port}:${label}`); bindingAdded = false; },
    },
  }));
  const res = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "self-expose", mode: "proxy", provider: "none" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal((await json(res)).ok, true);
  assert.ok(removed.includes("3000:pi-web"), "失败暴露应回滚本次预注册 binding");
});

test("POST self-expose — 已有同 label 通道时失败不回滚（不误删既有自暴露）", async () => {
  const removed = [];
  setSt(mockSt({
    auth: { expose: async (port, opts) => ({ url: null, tunnel: "", mode: opts.mode, site: opts.site, label: opts.label, error: "boom" }) },
    proxy: {
      status: () => ({ mode: "embedded" }),
      bindings: () => [{ port: 3000, label: "pi-web", site: "pi-web" }],
      addBinding: () => {},
      removeBinding: (port, label) => { removed.push(`${port}:${label}`); },
    },
  }));
  await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "self-expose", mode: "proxy", provider: "none" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.deepEqual(removed, [], "既有 pi-web 通道不得因本次失败被误删");
});

test("POST tunnel-stop — portmap/ipv6 宿主侧资源撤销（M3 停止闭环）", async () => {
  const stopped = [];
  const tunnelStops = [];
  setSt(mockSt({
    exposes: () => [{ name: "proxy:5173:po", port: 5173, label: "po", mode: "portmap", site: "pi-web", provider: "basic", running: true, url: null, localUrl: null, baseUrl: null, domainUrl: null, accessLog: null, errorLog: null, pid: null, startedAt: null }],
    tunnels: { ...mockSt().tunnels, stop: async (n) => { tunnelStops.push(n); } },
    portmap: { list: () => [{ key: "/tmp/st:portmap:5173:po", backend: "upnp", gateway: "g", externalIp: "1.2.3.4", externalPort: 8080, internalPort: 4000 }], stop: async (k) => { stopped.push(k); return true; } },
    ipv6: { list: () => [{ key: "/tmp/st:ipv6:5173:po", address: "::1", transportPort: 1234 }], stop: async (k) => { stopped.push(k); return true; } },
  }));
  const res = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "tunnel-stop", name: "proxy:5173:po" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal((await json(res)).stopped, "proxy:5173:po");
  // 后缀 `:5173:po` 命中两个 registry（停残留也一并清）
  assert.deepEqual(stopped.sort(), ["/tmp/st:ipv6:5173:po", "/tmp/st:portmap:5173:po"].sort());
  // 契约：先撤宿主侧资源，仍要走到库 tunnels.stop（binding/记录/隧道进程清理）
  assert.ok(tunnelStops.includes("proxy:5173:po"), "tunnels.stop 必须仍被调用");
});

test("POST tunnel-stop — mode 门控：隧道/proxy 记录不得触碰 portmap/ipv6 registry（防误停）", async () => {
  const stopped = [];
  // 隧道记录：无 mode、无 label——suffix 退化为 `:3002:`，会命中空 label 的 key
  setSt(mockSt({
    exposes: () => [{ name: "expose-self-3002", port: 3002, label: undefined, mode: undefined, site: "pi-web", provider: "basic", running: true, url: "https://x.trycloudflare.com", localUrl: null, baseUrl: null, domainUrl: null, accessLog: null, errorLog: null, pid: null, startedAt: null }],
    portmap: { list: () => [{ key: "/tmp/st:portmap:3002:", backend: "upnp", gateway: "g", externalIp: "1.2.3.4", externalPort: 8080, internalPort: 4000 }], stop: async (k) => { stopped.push(k); return true; } },
    ipv6: { list: () => [{ key: "/tmp/st:ipv6:3002:", address: "::1", transportPort: 1234 }], stop: async (k) => { stopped.push(k); return true; } },
  }));
  await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "tunnel-stop", name: "expose-self-3002" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.deepEqual(stopped, [], "隧道记录不得误停同端口空 label 的 portmap/ipv6 资源");
});

test("POST tunnel-stop — 后缀边界：不同 label / 不同端口不得误停", async () => {
  const stopped = [];
  setSt(mockSt({
    exposes: () => [{ name: "proxy:5173:po", port: 5173, label: "po", mode: "portmap", site: "pi-web", provider: "basic", running: true, url: null, localUrl: null, baseUrl: null, domainUrl: null, accessLog: null, errorLog: null, pid: null, startedAt: null }],
    portmap: { list: () => [
      { key: "/tmp/st:portmap:5173:other", backend: "upnp", gateway: "g", externalIp: "1.2.3.4", externalPort: 8081, internalPort: 4001 },
      { key: "/tmp/st:portmap:15173:po", backend: "upnp", gateway: "g", externalIp: "1.2.3.4", externalPort: 8082, internalPort: 4002 },
    ], stop: async (k) => { stopped.push(k); return true; } },
    ipv6: { list: () => [], stop: async () => true },
  }));
  await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "tunnel-stop", name: "proxy:5173:po" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.deepEqual(stopped, [], "仅精确后缀 `:5173:po` 命中，不得跨 label/端口误停");
});

test("POST self-stop — 自暴露停止同样走资源撤销 + binding 清理", async () => {
  const stopped = [];
  const removed = [];
  setSt(mockSt({
    // getPiWebPort() 缺省 3000（PORT 未设时）
    exposes: () => [{ name: "proxy:3000:pi-web", port: 3000, label: "pi-web", mode: "portmap", site: "pi-web", provider: "basic", running: true, url: "http://1.2.3.4:8080", localUrl: null, baseUrl: null, domainUrl: null, accessLog: null, errorLog: null, pid: null, startedAt: null }],
    portmap: { list: () => [{ key: "/tmp/st:portmap:3000:pi-web", backend: "upnp", gateway: "g", externalIp: "1.2.3.4", externalPort: 8080, internalPort: 4000 }], stop: async (k) => { stopped.push(k); return true; } },
    ipv6: { list: () => [], stop: async () => true },
    proxy: { status: () => ({ mode: "embedded" }), bindings: () => [{ port: 3000, label: "pi-web", site: "pi-web" }], addBinding: () => {}, removeBinding: (port, label) => { removed.push(`${port}:${label}`); } },
  }));
  await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "self-stop" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.deepEqual(stopped, ["/tmp/st:portmap:3000:pi-web"], "self-stop 应撤销 portmap 映射");
  assert.ok(removed.includes("3000:pi-web"), "self binding 应被移除");
});

test("POST set-allow-tool-download / user-summary", async () => {
  let val;
  setSt(mockSt({ tools: { allowDownload: () => val, list: () => [], setAllowDownload: (v) => { val = v; } } }));
  await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "set-allow-tool-download", allowDownload: false }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal(val, false);
  const sum = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "user-summary" }) }), { ...ctx, method: "POST", path: ["status"] });
  const d = await json(sum);
  assert.ok(Array.isArray(d.rows));
  assert.ok(d.rows.some((r) => r.provider === "basic"));
});

test("POST preset-save/load/delete 往返 + 敏感值加密", async () => {
  process.env.PI_WEB_EXPOSE_PRESETS_DIR = mkdtempSync(join(tmpdir(), "st-presets-"));
  setSt(mockSt());
  const save = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "preset-save", name: "ngrok方案", presetConfig: { provider: null, tunnel: "ngrok", protocol: "http", mode: "both", site: "default", tunnelParams: { token: "ngrok-secret" }, providerParams: {} } }) }), { ...ctx, method: "POST", path: ["status"] });
  const sd = await json(save);
  assert.ok(sd.saved.id);
  const load = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "preset-load", id: sd.saved.id }) }), { ...ctx, method: "POST", path: ["status"] });
  const ld = await json(load);
  assert.equal(ld.config.tunnelParams.token, "ngrok-secret");
  const del = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "preset-delete", id: sd.saved.id }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal((await json(del)).deleted, true);
  delete process.env.PI_WEB_EXPOSE_PRESETS_DIR;
});

test("POST site-add / site-remove — 增删站点 + 受保护站点拒改拒删", async () => {
  const added = [];
  const removed = [];
  let sites = [{ name: "default" }, { name: "pi-web" }, { name: "services" }];
  setSt(mockSt({
    sites: {
      list: () => sites,
      add: (name, cfg) => { added.push({ name, cfg }); sites = [...sites, { name, ...cfg }]; },
      remove: (name) => { removed.push(name); sites = sites.filter((s) => s.name !== name); },
    },
  }));
  const post = (body) => handleApi(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { ...ctx, method: "POST", path: ["status"] });
  // 增：普通站点（名称归一化小写；provider 透传）
  const ad = await json(await post({ action: "site-add", name: "Team-A", provider: "basic" }));
  assert.equal(ad.ok, true);
  assert.equal(added[0].name, "team-a");
  assert.equal(added[0].cfg.provider, "basic");
  assert.ok(ad.sites.some((s) => s.name === "team-a"));
  assert.deepEqual(ad.protectedSites, ["default", "pi-web"]);
  // 增：provider=auto → 不带 provider（平台默认）
  const ad2 = await json(await post({ action: "site-add", name: "plain", provider: "auto" }));
  assert.equal(ad2.ok, true);
  assert.equal(added[1].cfg.provider, undefined);
  // 删：普通站点
  const rm = await json(await post({ action: "site-remove", name: "services" }));
  assert.equal(rm.ok, true);
  assert.deepEqual(removed, ["services"]);
  assert.ok(!rm.sites.some((s) => s.name === "services"));
  // 删：受保护站点 → 400（default / pi-web）
  assert.equal((await post({ action: "site-remove", name: "pi-web" })).status, 400);
  assert.equal((await post({ action: "site-remove", name: "default" })).status, 400);
  // 增：覆盖受保护站点 → 400（保护配置不被替换）
  assert.equal((await post({ action: "site-add", name: "pi-web", provider: "basic" })).status, 400);
  // 缺名 → 400
  assert.equal((await post({ action: "site-add", name: "" })).status, 400);
  assert.equal((await post({ action: "site-remove" })).status, 400);
});

test("POST site-remove — 库校验抛错 → 400（名称非法等）", async () => {
  setSt(mockSt({
    sites: {
      list: () => [{ name: "default" }, { name: "pi-web" }, { name: "services" }],
      add: () => {},
      remove: () => { throw new Error('invalid site name "x y"'); },
    },
  }));
  const res = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "site-remove", name: "x y" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal(res.status, 400);
  const d = await json(res);
  assert.ok(String(d.error).includes("invalid site name"));
});

test("GET /status — 带回 sites + protectedSites", async () => {
  setSt(mockSt());
  const res = await handleApi(new Request("http://x/api/extensions/service-tunnels/status?lang=en"), { ...ctx, path: ["status"], searchParams: new URLSearchParams("lang=en") });
  const d = await json(res);
  assert.deepEqual(d.protectedSites, ["default", "pi-web"]);
  assert.ok(d.sites.some((s) => s.name === "default"));
});

test("未知 action → 400；未匹配 path → null（404）", async () => {
  setSt(mockSt());
  const unk = await handleApi(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "nonsense" }) }), { ...ctx, method: "POST", path: ["status"] });
  assert.equal(unk.status, 400);
  const nf = await handleApi(new Request("http://x/api/extensions/service-tunnels/nope"), { ...ctx, path: ["nope"] });
  assert.equal(nf, null);
});

test("fail-closed：库抛错 → 500 JSON（不泄漏堆栈细节之外）", async () => {
  setSt(mockSt({ tunnels: { ...mockSt().tunnels, list: () => { throw new Error("boom"); } } }));
  const res = await handleApi(new Request("http://x/api/extensions/service-tunnels/status"), { ...ctx, path: ["status"] });
  assert.equal(res.status, 500);
  const d = await json(res);
  assert.ok(d.error.includes("boom"));
});

test("GET /status 空路径（兼容 /api/extensions/service-tunnels 无 action）", async () => {
  setSt(mockSt());
  const res = await handleApi(new Request("http://x/api/extensions/service-tunnels"), { ...ctx, path: [] });
  assert.equal(res.status, 200);
});

// ---- PATCH /enroll（增量）与 inject-toggle ----
test("PATCH /enroll — 增量登记/更新/移除单端口（不触发全量）", async () => {
  const bindings = [{ port: 8084, label: "", site: "default", provider: "", serviceBasePath: "/dev" }];
  // 模拟库 0.3.41 的 enroll/unenroll/enrolled 高层 API（生产路径）
  setSt(mockSt({ proxy: {
    status: () => ({ mode: "embedded" }),
    bindings: () => bindings,
    enrolled: () => bindings.filter((b) => b.label === "" && b.site === "default" && b.provider === "")
      .map((b) => ({ port: b.port, ...(b.serviceBasePath !== undefined ? { serviceBasePath: b.serviceBasePath } : {}) })),
    enroll: (port, opts = {}) => {
      const existing = bindings.find((b) => b.port === port && b.label === "");
      const bp = opts.serviceBasePath !== undefined ? (opts.serviceBasePath === "" ? undefined : opts.serviceBasePath) : existing?.serviceBasePath;
      if (existing) {
        if (bp === undefined) delete existing.serviceBasePath; else existing.serviceBasePath = bp;
      } else bindings.push({ port, label: "", site: "default", provider: "", ...(bp !== undefined ? { serviceBasePath: bp } : {}) });
    },
    unenroll: (port) => { const i = bindings.findIndex((x) => x.port === port && x.label === ""); if (i >= 0) bindings.splice(i, 1); },
    addBinding: () => {},
    removeBinding: () => {},
  } }));
  // 新增（带 basePath）
  let res = await handleApi(new Request("http://x", { method: "PATCH", body: JSON.stringify({ port: 8080, basePath: "/dev" }) }), { ...ctx, method: "PATCH", path: ["enroll"] });
  assert.equal(res.status, 200);
  let d = await json(res);
  assert.deepEqual(d.ports.map((p) => [p.port, p.serviceBasePath]), [[8084, "/dev"], [8080, "/dev"]]);
  // 更新已存在
  res = await handleApi(new Request("http://x", { method: "PATCH", body: JSON.stringify({ port: 8080, basePath: "" }) }), { ...ctx, method: "PATCH", path: ["enroll"] });
  d = await json(res);
  assert.deepEqual(d.ports.find((p) => p.port === 8080), { port: 8080 });
  // 移除
  res = await handleApi(new Request("http://x", { method: "PATCH", body: JSON.stringify({ port: 8080, remove: true }) }), { ...ctx, method: "PATCH", path: ["enroll"] });
  d = await json(res);
  assert.deepEqual(d.ports.map((p) => p.port), [8084]);
  // 非法端口 → 400
  res = await handleApi(new Request("http://x", { method: "PATCH", body: JSON.stringify({ port: 99999 }) }), { ...ctx, method: "PATCH", path: ["enroll"] });
  assert.equal(res.status, 400);
});

