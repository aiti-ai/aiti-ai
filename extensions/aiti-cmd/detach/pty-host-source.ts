/**
 * aiti-cmd · detached PTY host — the program that owns a terminal session.
 *
 * Modelled on lib/agent-starter (same idea: one process per session, hosted outside
 * pi-web's lifetime, unix socket + framed protocol + in-memory journal + single writer),
 * specialised for PTYs: it spawns node-pty directly instead of piping stdio, and adds
 * resize, so interactive programs (vim/htop/less) keep working.
 *
 *   node pty-host.mjs --config <launch.json>
 *
 * The launch config is one-shot (it carries the session env) and deleted on read.
 *
 * Framing: [1 byte channel][4 byte BE length][payload]
 *   ch0 client→host stdin bytes
 *   ch1 host→client PTY output bytes
 *   ch3 JSON control frames (both directions)
 *
 * Control frames:
 *   host→client  { t:"hello", pid, cols, rows, journalBytes, journalFrames }
 *                { t:"exit", code, signal, durationMs }
 *                { t:"spawn_error", message }
 *                { t:"superseded" }            (a newer client took over)
 *   client→host  { t:"resize", cols, rows }
 *                { t:"kill", signal? }
 *
 * Kept dependency-free on purpose: it must run under a plain `node`, with node-pty
 * resolved from the path recorded in the launch config.
 */
export const PTY_HOST_SOURCE = String.raw`#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";

const CH_INPUT = 0;
const CH_OUTPUT = 1;
const CH_CTRL = 3;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const JOURNAL_LIMIT = 1024 * 1024;
const CLIENT_BUFFER_LIMIT = 8 * 1024 * 1024;
const EXIT_LINGER_MS = 15000;
const KILL_GRACE_MS = 3000;

function parseArgs(argv) {
  let config = "";
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--config") config = argv[++i] || "";
  return { config };
}

function encodeFrame(channel, payload) {
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(channel & 0xff, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}
function control(obj) { return encodeFrame(CH_CTRL, Buffer.from(JSON.stringify(obj), "utf8")); }

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) { process.stderr.write("pty-host: --config is required\n"); process.exit(2); }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(args.config, "utf8")); } catch (e) {
    process.stderr.write("pty-host: cannot read config: " + (e && e.message) + "\n"); process.exit(2);
  }
  try { fs.unlinkSync(args.config); } catch (e) { /* one-shot */ }

  const socketPath = String(cfg.socket || "");
  const readyPath = cfg.ready ? String(cfg.ready) : socketPath + ".ready";
  const entryPath = cfg.registryEntry ? String(cfg.registryEntry) : "";
  const nodeModules = String(cfg.nodeModules || "");

  function cleanup() {
    for (const p of [socketPath, readyPath, entryPath]) { if (p) { try { fs.unlinkSync(p); } catch (e) {} } }
  }

  let pty = null;
  let spawnError = null;
  let exitInfo = null;
  let seq = 0;
  const journal = [];
  let journalBytes = 0;
  function journalPush(buf) {
    if (!buf || !buf.length) return;
    if (buf.length > JOURNAL_LIMIT) {
      journal.length = 0; journalBytes = 0;
      const tail = buf.subarray(buf.length - JOURNAL_LIMIT);
      journal.push(tail); journalBytes = tail.length; return;
    }
    journal.push(buf); journalBytes += buf.length;
    while (journalBytes > JOURNAL_LIMIT && journal.length > 1) {
      const dropped = journal.shift(); journalBytes -= dropped.length;
    }
  }

  let client = null;
  function writeClient(buf) {
    if (!client) return;
    if (client.writableLength > CLIENT_BUFFER_LIMIT) { try { client.destroy(); } catch (e) {} client = null; return; }
    try { client.write(buf); } catch (e) { /* close handler cleans up */ }
  }

  const startedAt = Date.now();
  function sendHandshake(sock) {
    const parts = [];
    if (spawnError) parts.push(control({ t: "spawn_error", message: spawnError }));
    else parts.push(control({ t: "hello", pid: pty ? pty.pid : null, wrapperPid: process.pid, cols: pty ? pty.cols : cfg.cols, rows: pty ? pty.rows : cfg.rows, journalBytes, journalFrames: journal.length, seq }));
    for (const item of journal) parts.push(encodeFrame(CH_OUTPUT, item));
    if (exitInfo) parts.push(control({ t: "exit", code: exitInfo.code, signal: exitInfo.signal, durationMs: Date.now() - startedAt }));
    try { sock.write(parts.length === 1 ? parts[0] : Buffer.concat(parts)); } catch (e) {}
  }

  let lingerTimer = null;
  let killGraceTimer = null;
  let shuttingDown = false;
  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
    if (killGraceTimer) { clearTimeout(killGraceTimer); killGraceTimer = null; }
    try { server.close(); } catch (e) {}
    cleanup();
    process.exit(code === undefined ? 0 : code);
  }
  function finish() {
    if (client) {
      const sock = client; client = null;
      try { sock.end(function () { shutdown(0); }); } catch (e) { shutdown(0); }
      setTimeout(function () { shutdown(0); }, 2000).unref();
      return;
    }
    lingerTimer = setTimeout(function () { shutdown(0); }, EXIT_LINGER_MS);
    lingerTimer.unref();
  }

  function onControl(payload) {
    let f = null;
    try { f = JSON.parse(payload.toString("utf8")); } catch (e) { return; }
    if (!f) return;
    if (f.t === "resize" && pty) {
      const cols = Math.max(2, Math.min(1000, Number(f.cols) || 0));
      const rows = Math.max(2, Math.min(1000, Number(f.rows) || 0));
      try { pty.resize(cols, rows); } catch (e) {}
      return;
    }
    if (f.t === "kill") {
      if (!pty || exitInfo) { finish(); return; }
      const signal = typeof f.signal === "string" && f.signal ? f.signal : "SIGTERM";
      try { pty.kill(signal); } catch (e) {}
      killGraceTimer = setTimeout(function () { try { pty.kill("SIGKILL"); } catch (e) {} }, KILL_GRACE_MS);
      killGraceTimer.unref();
    }
  }

  function attach(sock) {
    if (client && client !== sock) {
      const prev = client; client = null;
      try { prev.write(control({ t: "superseded" })); } catch (e) {}
      try { prev.end(); } catch (e) {}
    }
    client = sock;
    let pending = Buffer.alloc(0);
    sock.on("data", function (chunk) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      while (pending.length - offset >= 5) {
        const channel = pending.readUInt8(offset);
        const length = pending.readUInt32BE(offset + 1);
        if (length > MAX_FRAME_BYTES) { sock.destroy(); return; }
        const end = offset + 5 + length;
        if (pending.length < end) break;
        const payload = pending.subarray(offset + 5, end);
        offset = end;
        if (channel === CH_INPUT) { if (pty && !exitInfo) { try { pty.write(payload.toString("utf8")); } catch (e) {} } }
        else if (channel === CH_CTRL) onControl(payload);
      }
      if (offset) pending = pending.subarray(offset);
    });
    sock.on("error", function () { if (client === sock) client = null; });
    sock.on("close", function () { if (client === sock) client = null; });
    sendHandshake(sock);
  }

  // ---- spawn the PTY -----------------------------------------------------
  try {
    const req = createRequire(path.join(nodeModules || process.cwd(), "index.js"));
    const ptyMod = req("node-pty");
    pty = ptyMod.spawn(String(cfg.file || process.env.SHELL || "/bin/bash"), Array.isArray(cfg.args) ? cfg.args : [], {
      name: "xterm-256color",
      cols: Math.max(2, Number(cfg.cols) || 80),
      rows: Math.max(2, Number(cfg.rows) || 24),
      cwd: cfg.cwd || process.cwd(),
      env: cfg.env || process.env,
    });
  } catch (e) {
    spawnError = (e && e.message) ? e.message : String(e);
  }

  const server = net.createServer(attach);
  server.on("error", function (err) {
    if (err && err.code === "EADDRINUSE") { process.stderr.write("pty-host: session already owned\n"); process.exit(3); }
    process.stderr.write("pty-host: server error: " + (err && err.message ? err.message : String(err)) + "\n");
    cleanup(); process.exit(1);
  });

  function listen() {
    server.listen(socketPath, function () {
      try { fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch (e) {}
    });
  }
  // stale socket from a crashed host: only unlink when nothing listens
  if (fs.existsSync(socketPath)) {
    const probe = net.connect({ path: socketPath });
    let settled = false;
    probe.once("connect", function () {
      if (settled) return; settled = true;
      try { probe.destroy(); } catch (e) {}
      process.stderr.write("pty-host: session already owned\n"); process.exit(3);
    });
    probe.once("error", function () {
      if (settled) return; settled = true;
      try { probe.destroy(); } catch (e) {}
      try { fs.unlinkSync(socketPath); } catch (e) {}
      listen();
    });
  } else {
    listen();
  }

  if (pty) {
    pty.onData(function (data) {
      const buf = Buffer.from(data, "utf8");
      journalPush(buf);
      writeClient(encodeFrame(CH_OUTPUT, buf));
    });
    pty.onExit(function (ev) {
      exitInfo = { code: ev && typeof ev.exitCode === "number" ? ev.exitCode : null, signal: ev && ev.signal ? String(ev.signal) : null };
      writeClient(control({ t: "exit", code: exitInfo.code, signal: exitInfo.signal, durationMs: Date.now() - startedAt }));
      finish();
    });
  } else {
    finish();
  }

  // wrapper dies (systemd stop / SIGTERM): take the PTY with it
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, function () {
      try { if (pty && !exitInfo) pty.kill("SIGHUP"); } catch (e) {}
      cleanup();
      process.exit(0);
    });
  }
}

main();
`;
