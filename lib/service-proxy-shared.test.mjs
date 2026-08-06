import assert from "node:assert/strict";
import test from "node:test";

const mod = await import("./service-proxy-shared.ts");

function resetState() {
  globalThis.__piWebExposeConfig = undefined;
  globalThis.__piWebAllowLocalOverride = undefined;
  globalThis.__piWebPort = undefined;
}

test("allowlocal: defaults to true without config", () => {
  resetState();
  assert.equal(mod.getAllowLocal(), true);
});

test("allowlocal: false when PI_WEB_EXPOSE sets allowlocal=false", () => {
  resetState();
  globalThis.__piWebExposeConfig = { mode: "proxy", allowlocal: false };
  assert.equal(mod.getAllowLocal(), false);
});

test("allowHosts: explicit allowHost + runtime override only (no auto deployment domains)", () => {
  resetState();
  const prev = process.env.PI_WEB_BASE_DOMAIN;
  try {
    process.env.PI_WEB_BASE_DOMAIN = "deploy.example.com:57442,backup.example.com";
    globalThis.__piWebExposeConfig = { allowHost: ["front.example.com", "x.example.org"] };
    let hosts = mod.getAllowLocalHosts();
    // deployment domains are NOT auto-excepted (they must go through proxy auth)
    assert.ok(!hosts.includes("deploy.example.com"), "deployment domain not auto-allowed");
    assert.ok(!hosts.includes("backup.example.com"));
    assert.ok(hosts.includes("front.example.com"), "explicit allowHost");
    // runtime override is additive
    mod.setAllowLocalHosts(["extra.example.net"]);
    hosts = mod.getAllowLocalHosts();
    assert.ok(hosts.includes("extra.example.net"));
    assert.ok(hosts.includes("front.example.com"), "env allowHost stays");
  } finally {
    if (prev === undefined) delete process.env.PI_WEB_BASE_DOMAIN;
    else process.env.PI_WEB_BASE_DOMAIN = prev;
    resetState();
  }
});

test("allowlocal: runtime override beats env config", () => {
  resetState();
  globalThis.__piWebExposeConfig = { allowlocal: false };
  mod.setAllowLocal(true);
  assert.equal(mod.getAllowLocal(), true);
  mod.setAllowLocal(false);
  assert.equal(mod.getAllowLocal(), false);
});

test("port: PORT env ?? 30141, overridable", () => {
  resetState();
  const prev = process.env.PORT;
  try {
    delete process.env.PORT;
    assert.equal(mod.getPiWebPort(), 30141);
    process.env.PORT = "41777";
    resetState(); // port is cached on globalThis once read
    assert.equal(mod.getPiWebPort(), 41777);
    mod.setPiWebPort(5000);
    assert.equal(mod.getPiWebPort(), 5000);
  } finally {
    if (prev === undefined) delete process.env.PORT;
    else process.env.PORT = prev;
  }
});

test("self tunnel host maps to its proxy vhost (auth flows through proxy)", () => {
  resetState();
  globalThis.__piServiceTunnels = {
    exposes: () => [
      {
        name: "expose-self-30141",
        port: 30141,
        site: "pi-web",
        running: true,
        url: "https://alice.ngrok-free.app",
      },
      { name: "other", port: 9000, site: "services", running: true, url: "https://svc.trycloudflare.com" },
    ],
    proxy: {
      // mimic the library: only its default suffixes + deployment domains
      parseHost: (h) => /\.(st\.localhost|service-tunnel\.localhost|localhost|example\.com)$/.test(h) && /^\d{2,5}-/.test(h)
        ? { port: Number(h.split("-")[0]) }
        : null,
    },
  };
  const mapped = mod.mapSelfTunnelToVhost("alice.ngrok-free.app");
  assert.ok(
    ["30141-pi-web.st.localhost", "30141-pi-web.service-tunnel.localhost", "30141-pi-web.localhost", "30141-pi-web.example.com"].includes(mapped ?? ""),
    `self tunnel domain maps to a parseable pi-web vhost (got ${mapped})`,
  );
  assert.equal(mod.mapSelfTunnelToVhost("svc.trycloudflare.com"), null, "services-site tunnel is not mapped");
  assert.equal(mod.mapSelfTunnelToVhost("unknown.example.com"), null, "unknown host is not mapped");
  delete globalThis.__piServiceTunnels;
});

test("self-forward tokens: valid, unobservable capability, TTL-bounded", () => {
  resetState();
  try {
    // no token yet → invalid
    assert.equal(mod.isValidSelfForwardToken("anything"), false);
    assert.equal(mod.isValidSelfForwardToken(""), false);

    // issued token is valid
    const t1 = mod.issueSelfForwardToken();
    assert.ok(t1.length >= 32, "random token");
    assert.equal(mod.isValidSelfForwardToken(t1), true);

    // concurrent forwards keep their own tokens valid (no one-shot clobber)
    const t2 = mod.issueSelfForwardToken();
    assert.notEqual(t1, t2);
    assert.equal(mod.isValidSelfForwardToken(t1), true);
    assert.equal(mod.isValidSelfForwardToken(t2), true);

    // expired tokens are invalid
    globalThis.__piWebSelfForwardTokens = new Map([[t1, Date.now() - 31_000]]);
    assert.equal(mod.isValidSelfForwardToken(t1), false, "expired token rejected");

    // clear resets everything
    mod.clearSelfForwardTokens();
    assert.equal(mod.isValidSelfForwardToken(t2), false);
  } finally {
    mod.clearSelfForwardTokens();
    resetState();
  }
});

test("expose env: plain k=v parsing with dotted keys", async () => {
  const { parseExposeEnv } = await import("./service-tunnels-integration.ts");
  const cfg = parseExposeEnv("mode=both,auth=portal,tunnel=cloudflared,allowlocal=false,user.name=admin,user.password=pw,tunnel.domain=alice.ngrok-free.app,provider.oidc.issuerUrl=https://x");
  assert.deepEqual(cfg, {
    mode: "both",
    auth: "portal",
    tunnel: "cloudflared",
    allowlocal: false,
    user: { name: "admin", password: "pw" },
    tunnelParams: { domain: "alice.ngrok-free.app" },
    providerParams: { oidc: { issuerUrl: "https://x" } },
  });
  // mode defaults to "none": config-only (allowlocal/allowHost), no self-expose
  const noMode = parseExposeEnv("allowlocal=false,allowHost=front.example.com");
  assert.equal(noMode.mode, "none");
  assert.equal(noMode.allowlocal, false);
  assert.deepEqual(noMode.allowHost, ["front.example.com"]);
  // explicit none stays none
  assert.equal(parseExposeEnv("mode=none,allowHost=a.com").mode, "none");
  // invalid mode stays fail-closed
  assert.equal(parseExposeEnv("mode=explode"), null);
  // repeatable allowHost key merges into an array
  const withHosts = parseExposeEnv("mode=proxy,allowHost=front.example.com,allowHost=x.example.org");
  assert.deepEqual(withHosts.allowHost, ["front.example.com", "x.example.org"]);
  // space-separated single key also works
  const space = parseExposeEnv("mode=proxy,allowHost=a.example.com b.example.com");
  assert.deepEqual(space.allowHost, ["a.example.com", "b.example.com"]);
  assert.equal(parseExposeEnv("mode=weird"), null, "invalid mode → fail-closed");
  assert.equal(parseExposeEnv(""), null, "empty → null");
  // unknown key warns but keeps the rest
  const partial = parseExposeEnv("mode=proxy,bogus=1");
  assert.deepEqual(partial, { mode: "proxy" });
});

test("allowlocal two-phase: temporary TTL auto-restores; confirm makes it permanent", async () => {
  const mod = await import("./service-proxy-shared.ts");
  // 临时关闭:立即生效,TTL 后自动恢复(回到默认 true)
  mod.setAllowLocalTemporary(false, 120);
  assert.equal(mod.getAllowLocal(), false, "临时关闭立即生效");
  let p = mod.getAllowLocalPending();
  assert.equal(p.pending, true, "待二次确认");
  assert.ok(p.expiresAt > Date.now(), "有过期时间");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(mod.getAllowLocal(), true, "TTL 到期自动恢复");
  assert.equal(mod.getAllowLocalPending().pending, false, "pending 清除");
  // 二次确认:永久(取消 TTL)
  mod.setAllowLocalTemporary(false, 500);
  assert.equal(mod.getAllowLocal(), false);
  mod.confirmAllowLocal(false);
  assert.equal(mod.getAllowLocalPending().pending, false, "确认后无 pending");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(mod.getAllowLocal(), false, "TTL 被取消,不自动恢复");
  // 清理:恢复默认
  mod.confirmAllowLocal(true);
  assert.equal(mod.getAllowLocal(), true);
});
