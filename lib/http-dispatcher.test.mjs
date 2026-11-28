import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
];

test("configures HTTP_PROXY, HTTPS_PROXY, and NO_PROXY for global fetch", async (t) => {
  const originalEnv = new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];

  const connectTargets = [];
  const forwardedRequests = [];
  const proxy = createServer((req, res) => {
    forwardedRequests.push(`${req.method} ${req.url}`);
    res.writeHead(204, { Connection: "close" });
    res.end();
  });
  proxy.on("connect", (req, socket) => {
    connectTargets.push(req.url);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");

  t.after(async () => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve, reject) => {
      proxy.close((error) => error ? reject(error) : resolve());
    });
  });

  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.NO_PROXY = "bypass.invalid";

  const jiti = createJiti(import.meta.url);
  const { configureHttpDispatcher } = await jiti.import("./http-dispatcher.ts");
  const { getGlobalDispatcher } = await import("undici");

  assert.throws(() => configureHttpDispatcher(-1), /Invalid HTTP idle timeout/);
  configureHttpDispatcher(2_000);

  const dispatcher = getGlobalDispatcher();
  configureHttpDispatcher(5_000);
  assert.equal(getGlobalDispatcher(), dispatcher, "configuration should be idempotent");

  const httpResponse = await fetch("http://target.invalid/through-http-proxy", {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(httpResponse.status, 204);
  assert.deepEqual(forwardedRequests, ["GET http://target.invalid/through-http-proxy"]);
  assert.deepEqual(connectTargets, []);

  await assert.rejects(fetch("https://target.invalid/through-https-proxy", {
    signal: AbortSignal.timeout(2_000),
  }));
  assert.deepEqual(connectTargets, ["target.invalid:443"]);

  const forwardedRequestCount = forwardedRequests.length;
  const connectTargetCount = connectTargets.length;
  await assert.rejects(fetch("http://bypass.invalid:9/no-proxy", {
    signal: AbortSignal.timeout(2_000),
  }));
  assert.equal(forwardedRequests.length, forwardedRequestCount);
  assert.equal(connectTargets.length, connectTargetCount);
});

test("reads httpIdleTimeoutMs from the agent settings file", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-http-idle-"));
  const settingsPath = join(agentDir, "settings.json");
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const jiti = createJiti(import.meta.url);
  const { readHttpIdleTimeoutMs } = await jiti.import("./http-dispatcher.ts");

  assert.equal(readHttpIdleTimeoutMs(agentDir), undefined, "no settings file keeps the default");

  writeFileSync(settingsPath, "{ not json");
  assert.equal(readHttpIdleTimeoutMs(agentDir), undefined, "unparsable settings keep the default");

  writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
  assert.equal(readHttpIdleTimeoutMs(agentDir), undefined, "a settings file without the key keeps the default");

  writeFileSync(settingsPath, JSON.stringify({ httpIdleTimeoutMs: -1 }));
  assert.equal(readHttpIdleTimeoutMs(agentDir), undefined, "a value the CLI rejects keeps the default");

  writeFileSync(settingsPath, JSON.stringify({ httpIdleTimeoutMs: null }));
  assert.equal(readHttpIdleTimeoutMs(agentDir), undefined, "a null value keeps the default");

  writeFileSync(settingsPath, JSON.stringify(["httpIdleTimeoutMs"]));
  assert.equal(readHttpIdleTimeoutMs(agentDir), undefined, "settings that are not an object keep the default");

  writeFileSync(settingsPath, JSON.stringify({ httpIdleTimeoutMs: 1_200_000 }));
  assert.equal(readHttpIdleTimeoutMs(agentDir), 1_200_000, "the configured timeout is used");

  writeFileSync(settingsPath, JSON.stringify({ httpIdleTimeoutMs: 0 }));
  assert.equal(readHttpIdleTimeoutMs(agentDir), 0, "0 disables the timeout");

  writeFileSync(settingsPath, JSON.stringify({ httpIdleTimeoutMs: "disabled" }));
  assert.equal(readHttpIdleTimeoutMs(agentDir), 0, "the CLI's disabled spelling disables the timeout");

  writeFileSync(settingsPath, `\ufeff${JSON.stringify({ httpIdleTimeoutMs: 900_000 })}`);
  assert.equal(readHttpIdleTimeoutMs(agentDir), 900_000, "a byte-order mark is allowed");

  // Without an argument the agent directory comes from pi's own override.
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  assert.equal(readHttpIdleTimeoutMs(), 900_000, "PI_CODING_AGENT_DIR picks the directory");
});

test("resolves PI_CODING_AGENT_DIR as pi's getAgentDir() does", async (t) => {
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const jiti = createJiti(import.meta.url);
  const { defaultAgentDir } = await jiti.import("./http-dispatcher.ts");

  const previous = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });

  for (const value of [undefined, "", "~", "~/agent", "~\\agent", "/abs/agent", "rel/agent", " /padded ", "file:///tmp/agent", "/c/Users/agent", "/mnt/d/agent"]) {
    if (value === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = value;
    assert.equal(defaultAgentDir(), getAgentDir(), `PI_CODING_AGENT_DIR=${JSON.stringify(value)}`);
  }
});

test("setHttpProxy switches the next fetch between the proxy and direct (fork forwarding semantics)", async (t) => {
  const originalEnv = new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  t.after(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const origin = createServer((_req, res) => {
    res.writeHead(200, { Connection: "close" }).end("direct-origin");
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  t.after(() => new Promise((resolve, reject) => origin.close((e) => e ? reject(e) : resolve())));
  const originUrl = `http://127.0.0.1:${origin.address().port}`;

  const forwarded = [];
  const proxy = createServer((_req, res) => {
    forwarded.push(String(Date.now()));
    res.writeHead(200, { Connection: "close" }).end("via-proxy");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => new Promise((resolve, reject) => proxy.close((e) => e ? reject(e) : resolve())));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

  // Fresh process: the dispatcher is a process-wide singleton.
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createJiti } from "jiti";
    const { configureHttpDispatcher, setHttpProxy } = await createJiti(import.meta.url).import("./http-dispatcher.ts");
    configureHttpDispatcher(2_000);
    const response = await fetch(process.argv[1], { signal: AbortSignal.timeout(2_000) });
    assert.equal(await response.text(), "direct-origin");
    // [fork] http:// origins are forwarded (no CONNECT tunnel): saving a proxy sends
    // the next request through it as an absolute-form proxy request.
    setHttpProxy(process.argv[2]);
    const viaProxy = await fetch(process.argv[1], { signal: AbortSignal.timeout(2_000) });
    assert.equal(await viaProxy.text(), "via-proxy");
    assert.throws(() => setHttpProxy("socks5:"), /Invalid proxy URL/);
    setHttpProxy(undefined);
    const direct = await fetch(process.argv[1], { signal: AbortSignal.timeout(2_000) });
    assert.equal(await direct.text(), "direct-origin");
  `, originUrl, proxyUrl], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, NODE_USE_ENV_PROXY: "0" },
  });
  assert.equal(forwarded.length, 1, "only the proxied window goes through the proxy");
});
