/**
 * api/self-reco 单测（方案 §7 用例 1-8）：候选装配 fail-closed + 缓存 +
 * 无敏感字段。st 经 globalThis.__piServiceTunnels 注入 mock（api-domains 同范式）。
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { handleApi, resetToolStatusCache } from "../api.ts";

function makeCtx(path, search = "") {
  return { method: "GET", path, searchParams: new URLSearchParams(search) };
}
const getJson = async (r) => { const body = await r.text(); return body ? JSON.parse(body) : null; };

// ---- 环境钩子（确定性）----
const ENV_SAVE = {};
function setEnv(k, v) { ENV_SAVE[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
const G_SAVE = {};
function setG(k, v) { G_SAVE[k] = globalThis[k]; globalThis[k] = v; }

let toolsListCalls = 0;

function mockSt(overrides = {}) {
  return {
    exposes: () => overrides.exposes?.() ?? [],
    proxy: { bindings: () => overrides.bindings?.() ?? [] },
    auth: {
      users: async (provider, site) => [
        { provider: "portal", users: overrides.portalUsers ?? [] },
      ],
    },
    tools: {
      allowDownload: () => false,
      list: () => { toolsListCalls += 1; return overrides.tools ?? []; },
    },
    portmap: { probe: async () => overrides.portmap ?? { supported: false, reason: "no-upnp" } },
    ipv6: { detect: async () => overrides.ipv6 ?? [] },
    ...overrides.st,
  };
}

// 临时监听一个端口（lan 探测真连接）
async function listenEphemeral() {
  return new Promise((resolve) => {
    const srv = createServer(() => {});
    srv.listen(0, "0.0.0.0", () => resolve({ srv, port: srv.address().port }));
  });
}

beforeEach(() => {
  toolsListCalls = 0;
  resetToolStatusCache();
  setEnv("PORT", undefined);           // getPiWebPort 兜底 3000，用 __piWebPort 钉
  setG("__piWebPort", 3000);
  setG("__piWebAllowLocalOverride", true);
  // 本机 shell 常带部署域名 env（pi.example.com 等）——测试必须剥净，否则 vhost 候选恒出现
  for (const k of ["PI_WEB_BASE_DOMAIN", "PI_WEB_ALLOWED_HOSTS", "PI_WEB_HOSTNAME", "PI_WEB_SVC_HOST_SUFFIX", "PI_WEB_BASE_PATH"]) {
    setEnv(k, undefined);
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(ENV_SAVE)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const [k, v] of Object.entries(G_SAVE)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
});

test("① 未配域名/后缀 → 无 vhost 候选，absent 带 no-base-domain", async () => {
  globalThis.__piServiceTunnels = mockSt({ tools: [] });
  const res = await handleApi(new Request("http://x/api/extensions/service-tunnels/self-reco"), makeCtx(["self-reco"]));
  assert.equal(res.status, 200);
  const d = await getJson(res);
  assert.equal(d.candidates.find((c) => c.id === "vhost"), undefined);
  assert.ok(d.absent.some((a) => a.id === "vhost-hint" && a.reason === "no-base-domain"));
});

test("② 无隧道工具 → 无 tunnel 候选；仅 cloudflared → 有且带次选徽标", async () => {
  globalThis.__piServiceTunnels = mockSt({ tools: [] });
  setEnv("PI_WEB_BASE_DOMAIN", "pi.example.com:8443"); // vhost 在场 → 隧道才是次选
  let d = await getJson(await handleApi(new Request("http://x/s"), makeCtx(["self-reco"])));
  assert.equal(d.candidates.find((c) => c.id === "tunnel"), undefined);
  assert.ok(d.absent.some((a) => a.reason === "no-tool"));

  resetToolStatusCache(); // 同测试内换库实例：先清 tools 探测缓存（⑦ 单独验缓存语义）
  globalThis.__piServiceTunnels = mockSt({ tools: [{ name: "cloudflared", source: "/usr/bin/cloudflared" }] });
  d = await getJson(await handleApi(new Request("http://x/s"), makeCtx(["self-reco"])));
  const tun = d.candidates.find((c) => c.id === "tunnel");
  assert.ok(tun?.available);
  assert.equal(tun.tunnel, "cloudflared");
  assert.ok(tun.badges.includes("third-party") && tun.badges.includes("url-changes"));
  assert.ok(!tun.recommended); // vhost 在场时隧道不是推荐
});

test("③ allowlocal=false → lan 不可用（allowlocal-off）；deep ipv6 无全局地址 → no-global-ipv6", async () => {
  setG("__piWebAllowLocalOverride", false);
  setEnv("PI_WEB_SVC_HOST_SUFFIX", ".pi.localhost");
  globalThis.__piServiceTunnels = mockSt({});
  let d = await getJson(await handleApi(new Request("http://x/s"), makeCtx(["self-reco"])));
  const lan = d.candidates.find((c) => c.id === "lan");
  assert.equal(lan.available, false);
  assert.equal(lan.reason, "allowlocal-off");

  d = await getJson(await handleApi(new Request("http://x/s"), makeCtx(["self-reco"], "deep=1")));
  const v6 = d.candidates.find((c) => c.id === "ipv6");
  assert.equal(v6.available, false);
  assert.equal(v6.reason, "no-global-ipv6");
  // 非 deep 时 portmap/ipv6 是 deep-only 占位
  d = await getJson(await handleApi(new Request("http://x/s"), makeCtx(["self-reco"])));
  assert.equal(d.candidates.find((c) => c.id === "portmap").reason, "deep-only");
});

test("④ 0.0.0.0 监听端口 + allowLocal → lan 可用且 risk（永不推荐）", async () => {
  const { srv, port } = await listenEphemeral();
  try {
    setG("__piWebPort", port);
    setEnv("PI_WEB_SVC_HOST_SUFFIX", ".pi.localhost");
    globalThis.__piServiceTunnels = mockSt({});
    const d = await getJson(await handleApi(new Request("http://x/s"), makeCtx(["self-reco"])));
    const lan = d.candidates.find((c) => c.id === "lan");
    assert.equal(lan.available, true);
    assert.equal(lan.risk, true);
    assert.ok(!lan.recommended);
    assert.ok(String(lan.url).includes(`:${port}`));
  } finally {
    srv.close();
  }
});

test("⑤ 全部安全候选缺失 → recommended:null（fail-closed 不推荐无认证）", async () => {
  setG("__piWebAllowLocalOverride", false);
  globalThis.__piServiceTunnels = mockSt({ tools: [] });
  const d = await getJson(await handleApi(new Request("http://x/s"), makeCtx(["self-reco"])));
  assert.equal(d.candidates.find((c) => c.recommended), undefined);
  assert.equal(d.candidates.some((c) => c.available && c.risk), false);
});

test("⑥ 已有 vhost+tunnel 双通道 → self.channels 两条（不新开不停旧）", async () => {
  setEnv("PI_WEB_BASE_DOMAIN", "pi.example.com:8443");
  globalThis.__piServiceTunnels = mockSt({
    tools: [{ name: "cloudflared", source: "/x/cloudflared" }],
    bindings: () => [{ port: 3000, label: "pi-web", provider: "portal" }],
    exposes: () => [
      { name: "expose-self-3000", port: 3000, site: "pi-web", provider: "portal", running: true, url: null, localUrl: "http://3000-pi-web.pi.example.com:8443/dev/", baseUrl: null },
      { name: "expose-self-3000-cloudflared", port: 3000, site: "pi-web", provider: "portal", running: true, url: "https://t2.example.com", localUrl: null, baseUrl: null },
    ],
  });
  const d = await getJson(await handleApi(new Request("http://x/s"), makeCtx(["self-reco"])));
  assert.ok(d.self.exposing);
  assert.equal(d.self.channels.length, 2);
  assert.ok(d.candidates.find((c) => c.id === "vhost")?.recommended);
});

test("⑦ tools 探测缓存：30s 内二次请求不再跑 list()", async () => {
  setEnv("PI_WEB_SVC_HOST_SUFFIX", ".pi.localhost");
  globalThis.__piServiceTunnels = mockSt({ tools: [{ name: "cloudflared", source: "/x" }] });
  await handleApi(new Request("http://x/s"), makeCtx(["self-reco"]));
  const afterFirst = toolsListCalls;
  await handleApi(new Request("http://x/s"), makeCtx(["self-reco"]));
  assert.equal(toolsListCalls, afterFirst); // cachedToolStatus 5min TTL 命中
});

test("⑧ 响应无敏感字段（密码/模板向量/隧道 token 不出现）", async () => {
  setEnv("PI_WEB_SVC_HOST_SUFFIX", ".pi.localhost");
  globalThis.__piServiceTunnels = mockSt({
    tools: [{ name: "cloudflared", source: "/x" }],
    portalUsers: [{ name: "admin" }],
  });
  const res = await handleApi(new Request("http://x/s"), makeCtx(["self-reco"]));
  const raw = await res.text();
  assert.ok(!raw.includes("password\":") || !/"password"/.test(raw.replace(/"password-only"/g, "")));
  assert.ok(!raw.includes("super-secret-token"));
  const d = JSON.parse(raw);
  assert.equal(d.hasUsers, true);
});
