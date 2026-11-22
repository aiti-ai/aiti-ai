/**
 * middleware.ts 单元测试 —— mock 库实例（globalThis.__piServiceTunnels）驱动
 * serviceTunnelsMiddleware。覆盖：vhost pipe/deny/redirect/forward、allowlocal
 * 门禁（含 self-forward token）、fail-closed、自暴露隧道映射、非 vhost 回退。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 自愈路径会走 getServiceTunnels() 真库（st 缺失时懒建）——数据根必须指到
// 临时目录，绝不读写真实 ~/.pi。env 须在动态 import 前就位（integration.ts
// 的 TUNNELS_ROOT 在模块求值时定型）。
process.env.AITI_SERVICE_TUNNELS_DIR = mkdtempSync(join(tmpdir(), "st-middleware-test-"));
process.env.PI_WEB_DATA_DIR = process.env.AITI_SERVICE_TUNNELS_DIR;
mkdirSync(join(process.env.AITI_SERVICE_TUNNELS_DIR, "service-tunnels"), { recursive: true });
mkdirSync(join(process.env.AITI_SERVICE_TUNNELS_DIR, "service-tunnels", "cache"), { recursive: true });

const { serviceTunnelsMiddleware } = await import("./middleware.ts");

function mockSt({ resolveKind = "deny", resolveBody = "not enrolled", resolvePipeUrl, resolveTarget } = {}) {
  const st = {
    proxy: {
      parseHost: (host) => {
        const m = /^(\d{2,5})(?:-([a-z0-9-]+))?\.(st\.localhost|localhost|example\.com)$/.exec(host);
        return m ? { port: Number(m[1]), suffix: m[3], label: m[2] } : null;
      },
      resolve: async (args) => {
        if (resolveKind === "pipe") return { kind: "pipe", port: 5173, url: resolvePipeUrl ?? "/" };
        if (resolveKind === "deny-auth") return { kind: "deny-auth", wwwAuthenticate: 'Basic realm="services"' };
        if (resolveKind === "redirect") return { kind: "redirect", location: "https://login.example.com/" };
        if (resolveKind === "forward") return { kind: "forward", target: resolveTarget ?? "http://127.0.0.1:5173/path" };
        return { kind: "deny", body: resolveBody };
      },
    },
    exposes: () => [],
  };
  return st;
}

function reset() {
  delete globalThis.__piServiceTunnels;
  delete globalThis.__piWebExposeConfig;
  delete globalThis.__piWebAllowLocalOverride;
  delete globalThis.__piWebAllowHostsOverride;
  delete globalThis.__piWebSelfForwardTokens;
  delete globalThis.__piWebAllowLocalTimer;
  delete globalThis.__piWebAllowLocalPendingExpires;
  delete globalThis.__stSelfHealAt;
}

test("无库实例 → handled:false（宿主继续核心门禁）", async () => {
  reset();
  const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/"));
  assert.deepEqual(r, { handled: false });
});

test("非 vhost 主机 → handled:false", async () => {
  reset();
  globalThis.__piServiceTunnels = mockSt();
  const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/"));
  assert.deepEqual(r, { handled: false });
  // 部署域（非 service vhost）同样回退
  const r2 = await serviceTunnelsMiddleware(new Request("http://pi.example.com:8443/dev/"));
  assert.deepEqual(r2, { handled: false });
});

test("vhost deny → 403（未 enroll 端口 fail-closed）", async () => {
  reset();
  globalThis.__piServiceTunnels = mockSt({ resolveKind: "deny", resolveBody: "port 9999 not enrolled" });
  const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/", { headers: { host: "9999.localhost" } }));
  assert.equal(r.handled, true);
  assert.equal(r.response.status, 403);
  const body = await r.response.text();
  assert.ok(body.includes("9999 not enrolled"));
});

// ---- not-enrolled 自愈（实例登记落后于盘 / 实例缺失）----
/** 构造「盘上登记落后/领先」可观测的 mock 实例：restore 前后 resolve 给出不同决策。 */
function selfHealMock() {
  let calls = 0;
  const bindings = new Map();
  return {
    get calls() { return calls; },
    bindings,
    st: {
      proxy: {
        parseHost: (host) => (host === "4321.localhost" ? { port: 4321, suffix: "localhost", label: "" } : null),
        resolve: async () => {
          calls++;
          return bindings.has("4321:")
            ? { kind: "forward", target: "http://127.0.0.1:4321/x" }
            : { kind: "deny", body: "port 4321 not enrolled" };
        },
        restore: (list) => { for (const b of list) bindings.set(`${b.port}:${b.label ?? ""}`, b); },
      },
    },
  };
}

function writeStateFile(bindings) {
  writeFileSync(
    join(process.env.AITI_SERVICE_TUNNELS_DIR, "service-tunnels", "cache", "state.json"),
    JSON.stringify({ bindings }),
  );
}

test("自愈：resolve not enrolled → 从盘重读登记并恰好重试一次（不重启生效）", async () => {
  reset();
  writeStateFile([{ port: 4321, label: "", site: "default" }]);
  const mock = selfHealMock();
  globalThis.__piServiceTunnels = mock.st;
  const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/", { headers: { host: "4321.localhost" } }));
  // 重试拿到 forward 决策 → 手动转发到 127.0.0.1:4321（无监听）→ 502，而非 403 deny
  assert.equal(r.response.status, 502);
  assert.equal(mock.calls, 2, "deny 后应恰好重试一次");
});

test("自愈节流：窗口内第二次 not enrolled 不盘读不重试，窗口外恢复", async () => {
  reset();
  writeStateFile([{ port: 4321, label: "", site: "default" }]);
  const mock = selfHealMock();
  globalThis.__piServiceTunnels = mock.st;
  const req = () => serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/", { headers: { host: "4321.localhost" } }));
  // 模拟刚自愈过（处于节流窗口内）
  globalThis.__stSelfHealAt = Date.now();
  let r = await req();
  assert.equal(r.response.status, 403, "窗口内保持原 deny");
  assert.equal(mock.calls, 1, "窗口内不重试");
  // 窗口外（时间戳清零模拟时间流逝）→ 自愈读到盘上登记 → 重试成功
  globalThis.__stSelfHealAt = 0;
  r = await req();
  assert.equal(r.response.status, 502);
  assert.equal(mock.calls, 3, "窗口外恢复：deny + 重试共两次");
});

test("自愈：st 缺失 → getServiceTunnels 懒重建（实例可复用，非 vhost 仍回退宿主）", async () => {
  reset();
  const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/"));
  assert.deepEqual(r, { handled: false });
  assert.ok(globalThis.__piServiceTunnels, "懒重建出库实例供后续请求复用");
});

test("vhost pipe → handled + x-middleware-rewrite（纯 Response 语义）", async () => {
  reset();
  globalThis.__piServiceTunnels = mockSt({ resolveKind: "pipe" });
  const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/some/path?q=1", { headers: { host: "5173.localhost" } }));
  assert.equal(r.handled, true);
  assert.ok(r.response.headers.get("x-middleware-rewrite"));
  assert.match(r.response.headers.get("x-middleware-rewrite"), /^http:\/\/127\.0\.0\.1:5173/);
});

test("SSRF 防线：pipe 目标为协议相对/绝对 URL → 403（绝不转发到外部主机）", async () => {
  for (const evil of ["//evil.example.com:9999/x", "http://evil.example.com/x"]) {
    reset();
    globalThis.__piServiceTunnels = mockSt({ resolveKind: "pipe", resolvePipeUrl: evil });
    const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/x", { headers: { host: "5173.localhost" } }));
    assert.equal(r.handled, true, `evil=${evil} 必须 handled`);
    assert.equal(r.response.status, 403, `evil=${evil} 必须 403`);
    assert.ok(!r.response.headers.get("x-middleware-rewrite"), "绝不能发出 rewrite");
  }
});

test("SSRF 防线：forward 目标非回环 → 403", async () => {
  reset();
  globalThis.__piServiceTunnels = mockSt({ resolveKind: "forward", resolveTarget: "http://evil.example.com/" });
  const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/", { headers: { host: "5173.localhost" } }));
  assert.equal(r.handled, true);
  assert.equal(r.response.status, 403);
});

test("vhost deny-auth → 401 + www-authenticate", async () => {
  reset();
  globalThis.__piServiceTunnels = mockSt({ resolveKind: "deny-auth" });
  const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/", { headers: { host: "5173.localhost" } }));
  assert.equal(r.handled, true);
  assert.equal(r.response.status, 401);
  assert.ok(r.response.headers.get("www-authenticate").includes("Basic"));
});

test("vhost redirect → 302 + location", async () => {
  reset();
  globalThis.__piServiceTunnels = mockSt({ resolveKind: "redirect" });
  const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/", { headers: { host: "5173.localhost" } }));
  assert.equal(r.handled, true);
  assert.equal(r.response.status, 302);
  assert.equal(r.response.headers.get("location"), "https://login.example.com/");
});

test("vhost forward（HTML）→ 手动转发，上游 Host = 目标地址（非 vhost 域名）", async () => {
  reset();
  const http = await import("node:http");
  const server = http.createServer((req, res) => { res.end(`host=${req.headers.host}`); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  globalThis.__piServiceTunnels = mockSt({ resolveKind: "forward", resolveTarget: `http://127.0.0.1:${port}/path` });
  try {
    const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/", { headers: { host: "5173.localhost", accept: "text/html" } }));
    assert.equal(r.handled, true);
    assert.ok(!r.response.headers.get("x-middleware-rewrite"), "HTML 不应再走 rewrite（rewrite 丢 Host 改动）");
    const body = await r.response.text();
    assert.equal(body, `host=127.0.0.1:${port}`, "上游收到的 Host 必须是目标地址，否则链式 pi-web 网关会按自己的空登记 403");
  } finally {
    server.close();
  }
});

test("vhost forward（websocket upgrade）→ 仍 rewrite 目标", async () => {
  reset();
  globalThis.__piServiceTunnels = mockSt({ resolveKind: "forward" });
  const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/", { headers: { host: "5173.localhost", upgrade: "websocket" } }));
  assert.equal(r.handled, true);
  assert.equal(r.response.headers.get("x-middleware-rewrite"), "http://127.0.0.1:5173/path");
});

test("resolve 抛错 → fail-closed 403（绝不放行）", async () => {
  reset();
  globalThis.__piServiceTunnels = {
    proxy: {
      parseHost: () => ({ port: 5173, label: "" }),
      resolve: async () => { throw new Error("boom"); },
    },
  };
  const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/", { headers: { host: "5173.localhost" } }));
  assert.equal(r.handled, true);
  assert.equal(r.response.status, 403);
});

// ---- allowlocal 直连门禁 ----
function setAllowLocalFalse() {
  globalThis.__piWebExposeConfig = { mode: "proxy", allowlocal: false };
}

test("allowlocal=false：非回环直连 → 403 HTML（自动刷新页）", async () => {
  reset();
  globalThis.__piServiceTunnels = mockSt();
  setAllowLocalFalse();
  const r = await serviceTunnelsMiddleware(new Request("http://192.168.122.48:3000/"));
  assert.equal(r.handled, true);
  assert.equal(r.response.status, 403);
  const body = await r.response.text();
  assert.ok(body.includes("本地直连已禁用"));
});

test("allowlocal=false：回环直连同样 403（防绕过）", async () => {
  reset();
  globalThis.__piServiceTunnels = mockSt();
  setAllowLocalFalse();
  const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/"));
  assert.equal(r.handled, true);
  assert.equal(r.response.status, 403);
});

test("allowlocal=false：self-forward token → 内部转发放行", async () => {
  reset();
  globalThis.__piServiceTunnels = mockSt();
  setAllowLocalFalse();
  const { issueSelfForwardToken } = await import("./proxy-shared.ts");
  const token = issueSelfForwardToken();
  const r = await serviceTunnelsMiddleware(new Request(`http://127.0.0.1:3000/?__piSelfFwd=${token}`));
  assert.deepEqual(r, { handled: false }); // 放行 → 宿主继续
});

test("allowlocal=false：allowHost 例外域名放行", async () => {
  reset();
  globalThis.__piServiceTunnels = mockSt();
  setAllowLocalFalse();
  globalThis.__piWebAllowHostsOverride = ["backup.example.com"];
  const r = await serviceTunnelsMiddleware(new Request("http://backup.example.com:3000/", { headers: { host: "backup.example.com:3000" } }));
  assert.deepEqual(r, { handled: false });
});

test("allowlocal=true（默认）→ 直连放行", async () => {
  reset();
  globalThis.__piServiceTunnels = mockSt();
  const r = await serviceTunnelsMiddleware(new Request("http://192.168.122.48:3000/"));
  assert.deepEqual(r, { handled: false });
});

// ---- 自暴露隧道域名 → vhost 映射 ----
test("自暴露隧道公网域名请求映射到 vhost 后走 resolve 认证", async () => {
  reset();
  const st = mockSt({ resolveKind: "deny", resolveBody: "auth required" });
  st.exposes = () => [
    { site: "pi-web", name: "expose-self-3000", port: 3000, running: true, url: "https://random.trycloudflare.com" },
  ];
  st.proxy.parseHost = (host) => {
    if (host.startsWith("3000-pi-web.")) return { port: 3000, label: "pi-web", suffix: "st.localhost" };
    return null;
  };
  globalThis.__piServiceTunnels = st;
  // 隧道域名 → 映射后应被 vhost 分支处理（resolve 被调用 → deny 403）
  const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/", { headers: { host: "random.trycloudflare.com" } }));
  assert.equal(r.handled, true);
  assert.equal(r.response.status, 403);
});

// ---- basePath 根路径重定向 ----
test("basePath 部署：pi-web 自身 vhost 根路径 → 302 到 basePath", async () => {
  reset();
  process.env.NEXT_PUBLIC_BASE_PATH = "/dev";
  const st = mockSt({ resolveKind: "pipe" });
  st.proxy.parseHost = (host) => (host.startsWith("3000-pi-web.") ? { port: 3000, label: "pi-web" } : null);
  globalThis.__piServiceTunnels = st;
  const r = await serviceTunnelsMiddleware(new Request("http://127.0.0.1:3000/", { headers: { host: "3000-pi-web.st.localhost" } }));
  assert.equal(r.handled, true);
  assert.equal(r.response.status, 302);
  assert.ok(r.response.headers.get("location").includes("/dev/"));
  delete process.env.NEXT_PUBLIC_BASE_PATH;
});
