import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";

async function loadSubject() {
  return import("./service-ports.ts");
}

/** Read a child's stdout until a regex matches (or timeout). */
async function readUntil(stream, pattern, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => done(null), timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = pattern.exec(buf);
      if (m) done(m);
    };
    const done = (result) => {
      clearTimeout(timer);
      stream.off("data", onData);
      resolve(result);
    };
    stream.on("data", onData);
  });
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = connect(0); // probe
    srv.once("connect", () => { srv.destroy(); reject(new Error("unreachable")); });
    srv.once("error", () => {
      const port = 20_000 + Math.floor(Math.random() * 30_000);
      srv.destroy();
      resolve(port);
    });
  });
}

test("decodes /proc/net/tcp IPv4 addresses (little-endian)", async () => {
  const { decodeIpv4 } = await loadSubject();
  assert.equal(decodeIpv4("0100007F"), "127.0.0.1");
  assert.equal(decodeIpv4("00000000"), "0.0.0.0");
  assert.equal(decodeIpv4("C0A80132"), "50.1.168.192");
});

test("decodes /proc/net/tcp6 addresses (little-endian 32-bit groups)", async () => {
  const { decodeIpv6 } = await loadSubject();
  assert.equal(decodeIpv6("00000000000000000000000000000000"), "::");
  // ::1 on loopback — verified against a live listener on /proc/net/tcp6
  assert.equal(decodeIpv6("00000000000000000000000001000000"), "::1");
  // IPv4-mapped ::ffff:127.0.0.1
  assert.equal(decodeIpv6("0000000000000000FFFF00000100007F"), "::ffff:7f00:1");
});

test("service host suffixes skip IP literals", async () => {
  const { getServiceHostSuffixes } = await loadSubject();
  const prev = process.env.PI_WEB_HOSTNAME;
  process.env.PI_WEB_HOSTNAME = "127.0.0.1";
  try {
    const suffixes = getServiceHostSuffixes();
    assert.ok(!suffixes.includes(".127.0.0.1"), suffixes.join(","));
    assert.ok(suffixes.includes(".pi.localhost"));
  } finally {
    if (prev === undefined) delete process.env.PI_WEB_HOSTNAME;
    else process.env.PI_WEB_HOSTNAME = prev;
  }
});

test("identifies pi-web command lines", async () => {
  const { isPiWebProcess } = await loadSubject();
  assert.equal(isPiWebProcess("node /app/node_modules/next/dist/bin/next dev -p 30141"), true);
  assert.equal(isPiWebProcess("next-server (v16.2.12)"), true);
  assert.equal(isPiWebProcess("node C:\\app\\node_modules\\next\\dist\\bin\\next start -p 30141"), true);
  assert.equal(isPiWebProcess("node /app/bin/pi-web.js"), true);
  assert.equal(isPiWebProcess("node server.js"), false);
  assert.equal(isPiWebProcess("node /app/tests/run.js"), false);
  assert.equal(isPiWebProcess(""), false);
});

test("parses lsof LISTEN lines (macOS)", async () => {
  const { parseLsofAddress } = await loadSubject();
  assert.deepEqual(parseLsofAddress("*:8080 (LISTEN)"), { address: "*", port: 8080 });
  assert.deepEqual(parseLsofAddress("127.0.0.1:5173 (LISTEN)"), { address: "127.0.0.1", port: 5173 });
  assert.deepEqual(parseLsofAddress("[::1]:9000 (LISTEN)"), { address: "::1", port: 9000 });
  assert.equal(parseLsofAddress("*:8080 (ESTABLISHED)"), null);
});

test("parses netstat LISTENING lines (Windows)", async () => {
  const { parseNetstatAddress } = await loadSubject();
  assert.deepEqual(parseNetstatAddress("0.0.0.0:8080"), { address: "0.0.0.0", port: 8080 });
  assert.deepEqual(parseNetstatAddress("127.0.0.1:5173"), { address: "127.0.0.1", port: 5173 });
  assert.deepEqual(parseNetstatAddress("[::]:9000"), { address: "::", port: 9000 });
  assert.equal(parseNetstatAddress("garbage"), null);
});

test("discovers a port opened by our own child process", { timeout: 20_000 }, async () => {
  if (process.platform !== "linux") return; // /proc backend
  const { discoverServicePorts } = await loadSubject();

  const port = await pickFreePort();
  const child = spawn(
    process.execPath,
    ["-e", `
      const s = require("http").createServer((q, r) => r.end("ok"));
      s.listen(${port}, "127.0.0.1", () => process.stdout.write("READY"));
      setInterval(() => {}, 1000);
    `],
    { stdio: ["ignore", "pipe", "inherit"] },
  );

  try {
    const ready = await readUntil(child.stdout, /READY/);
    assert.ok(ready, "child should start listening");

    const services = discoverServicePorts();
    const found = [...services.values()].find((s) => s.port === port);
    assert.ok(found, `discovered ${[...services.keys()].join(", ")} but not ${port}`);
    assert.equal(found.pid, child.pid);
    assert.ok(found.addresses.includes("127.0.0.1"), `addresses ${found.addresses.join(", ")}`);
  } finally {
    child.kill("SIGKILL");
  }
});

test("strips the basePath before forwarding to services", async () => {
  const { stripBasePath } = await loadSubject();
  assert.equal(stripBasePath("/", "/dev"), "/");
  assert.equal(stripBasePath("/dev", "/dev"), "/");
  assert.equal(stripBasePath("/dev/foo", "/dev"), "/foo");
  assert.equal(stripBasePath("/dev/foo?a=1", "/dev"), "/foo?a=1");
  assert.equal(stripBasePath("/foo", "/dev"), "/foo"); // no basePath prefix → untouched
  assert.equal(stripBasePath("/devfoo", "/dev"), "/devfoo"); // not a segment boundary
  assert.equal(stripBasePath("/dev/foo", ""), "/dev/foo"); // root deployment
});

test("expands wildcard binds into concrete addresses", async () => {
  const { expandListeningAddresses } = await loadSubject();
  const expanded = expandListeningAddresses(["0.0.0.0"]);
  assert.ok(expanded.includes("127.0.0.1"), expanded.join(", "));
  assert.ok(expanded.length >= 1);
  assert.deepEqual(expandListeningAddresses(["127.0.0.1"]), ["127.0.0.1"]);
  assert.deepEqual(expandListeningAddresses(["::"]).filter((a) => a === "::1"), ["::1"]);
});

test("finds a daemonized grandchild via the env marker", { timeout: 20_000 }, async () => {
  if (process.platform !== "linux") return; // environ marker lives in /proc
  const { discoverServicePorts } = await loadSubject();

  // bash backgrounds node and exits; node is re-parented (no tree link), but
  // it inherited PI_WEB_CHILD_MARKER at spawn, so discovery still finds it.
  const child = spawn("bash", [
    "-c",
    `"${process.execPath}" -e '
      const s = require("http").createServer((q, r) => r.end("ok"));
      s.listen(0, "127.0.0.1", () => process.stdout.write("PORT=" + s.address().port + "\\n"));
      setInterval(() => {}, 1000);
    ' &`,
  ], { stdio: ["ignore", "pipe", "inherit"] });

  let daemonPid = 0;
  try {
    const m = await readUntil(child.stdout, /PORT=(\d+)/);
    assert.ok(m, "daemon should report a port");
    const port = Number(m[1]);

    const services = discoverServicePorts();
    const found = [...services.values()].find((s) => s.port === port);
    assert.ok(found, `discovered ${[...services.keys()].join(", ")} but not ${port}`);
    daemonPid = found.pid;

    // Prove the tree link is really gone: the daemon's parent is no longer us.
    const status = readFileSync(`/proc/${daemonPid}/status`, "utf8");
    const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]);
    assert.notEqual(ppid, process.pid, "daemon should have been re-parented");
  } finally {
    child.kill("SIGKILL");
    if (daemonPid) {
      try { process.kill(daemonPid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});
