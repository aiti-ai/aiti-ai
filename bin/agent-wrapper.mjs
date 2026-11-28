#!/usr/bin/env node
/**
 * agent-starter wrapper — hosts one agent process outside pi-web's lifetime.
 *
 *   pi-web wrapper --config <launch.json>
 *
 * Responsibilities (each one is a facade detail — callers only see stdio):
 *   1. own the agent process lifecycle (spawn with the recorded options),
 *   2. serve a unix socket so a pi-web instance can attach/detach freely,
 *   3. journal output (4 MB ring) so an attach replays the agent's history,
 *   4. enforce single writer (a newer client supersedes the old one),
 *   5. clean up (socket, ready marker, registry entry) when the agent is gone,
 *   6. idle reap: with no client attached, an agent that produces no output
 *      for cfg.idleTimeoutMs is stopped (SIGTERM, then SIGKILL after the kill
 *      grace). A client (pi-web) attached disables the reaper — the host owns
 *      the lifecycle then. Output resets the timer, so a streaming turn keeps
 *      the process alive; a silent stretch longer than the timeout ends in a
 *      SIGTERM, which the agent treats as an orderly shutdown (pending work
 *      finishes first).
 *
 * Framing: [1 byte channel][4 byte BE length][payload]
 *   ch0 stdin (client -> agent), ch1 stdout, ch2 stderr, ch3 control JSON.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import childProcess from "node:child_process";

const CH_STDIN = 0;
const CH_STDOUT = 1;
const CH_STDERR = 2;
const CH_CTRL = 3;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const JOURNAL_LIMIT = 4 * 1024 * 1024;
const LOG_LIMIT = 4 * 1024 * 1024;
const CLIENT_BUFFER_LIMIT = 8 * 1024 * 1024;
const EXIT_LINGER_MS = 15000;
const KILL_GRACE_MS = 3000;
const IDLE_LOG_MARK = "wrapper: idle reap (no output, no client)\n";

function parseArgs(argv) {
  let config = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") config = argv[++i] || "";
  }
  return { config };
}

function readConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  // One-shot: the file carries the full agent env (credentials included).
  try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
  return raw;
}

function encodeFrame(channel, payload) {
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(channel & 0xff, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function control(obj) {
  return encodeFrame(CH_CTRL, Buffer.from(JSON.stringify(obj), "utf8"));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) {
    process.stderr.write("wrapper: --config is required\n");
    process.exit(2);
  }
  const cfg = readConfig(args.config);
  const key = String(cfg.key || "");
  const socketPath = String(cfg.socket || "");
  const readyPath = String(cfg.ready || socketPath + ".ready");
  const logPath = String(cfg.log || "");
  const entryPath = String(cfg.registryEntry || "");
  // Idle reap timeout in ms (same value pi-web's in-process GC uses, handed
  // over at spawn time). 0 disables the reaper.
  const idleTimeoutMs = Number(cfg.idleTimeoutMs) > 0 ? Number(cfg.idleTimeoutMs) : 0;

  // ---- per-session stderr log (4 MB cap, truncated when it grew) -----------
  let logFd = null;
  let logBytes = 0;
  function openLog() {
    if (!logPath) return;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
      let size = 0;
      try { size = fs.statSync(logPath).size; } catch (e) { size = 0; }
      if (size > LOG_LIMIT) {
        fs.writeFileSync(logPath, "", { mode: 0o600 });
        size = 0;
      }
      logFd = fs.openSync(logPath, "a", 0o600);
      logBytes = size;
    } catch (e) {
      logFd = null;
    }
  }
  function appendLog(buf) {
    if (logFd === null || logBytes >= LOG_LIMIT) return;
    const room = LOG_LIMIT - logBytes;
    const slice = buf.length > room ? buf.subarray(0, room) : buf;
    try {
      fs.writeSync(logFd, slice);
      logBytes += slice.length;
    } catch (e) { /* log is diagnostics only */ }
  }

  // ---- journal ring -------------------------------------------------------
  const journal = [];
  let journalBytes = 0;
  function appendJournal(channel, buf) {
    if (buf.length === 0) return;
    if (buf.length > JOURNAL_LIMIT) {
      journal.length = 0;
      journalBytes = 0;
      const tail = buf.subarray(buf.length - JOURNAL_LIMIT);
      journal.push({ channel, buf: tail });
      journalBytes = tail.length;
      return;
    }
    journal.push({ channel, buf });
    journalBytes += buf.length;
    while (journalBytes > JOURNAL_LIMIT && journal.length > 1) {
      const dropped = journal.shift();
      journalBytes -= dropped.buf.length;
    }
  }

  // Replay only complete lines: the ring's tail can end mid-line (a huge RPC
  // response truncated by the ring limit). A partial tail would glue onto the
  // agent's next live line on every future attach, producing an unparseable
  // or oversized frame client-side. Walk back to the last newline boundary.
  function trimmedJournalForReplay() {
    const items = journal.slice();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.channel !== CH_STDOUT && item.channel !== CH_STDERR) break;
      const idx = item.buf.lastIndexOf(0x0a);
      if (idx >= 0) {
        if (idx + 1 < item.buf.length) items[i] = { channel: item.channel, buf: item.buf.subarray(0, idx + 1) };
        break;
      }
      items.pop();
    }
    return items;
  }

  let client = null;
  let handshakeSent = false;
  let child = null;
  let hello = null;
  let spawnError = null;
  let exitInfo = null;
  let shuttingDown = false;
  let everConnected = false;
  let explicitStop = false;
  let lingerTimer = null;
  let killGraceTimer = null;
  let idleTimer = null;

  // ---- idle reap (no client attached, no output) ---------------------------
  // Same lifecycle contract as pi-web's in-process session GC: while a client
  // (pi-web) is attached the host manages the agent, so the reaper is
  // disarmed; the moment the last client goes away the timer starts, every
  // output byte re-arms it, and a fire stops the agent. The SIGTERM lets a
  // mid-turn agent finish orderly before the SIGKILL grace.
  function disarmIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }
  function armIdle() {
    disarmIdle();
    if (!idleTimeoutMs || shuttingDown || !child || exitInfo) return;
    idleTimer = setTimeout(function () { idleTimer = null; reapIdle(); }, idleTimeoutMs);
    idleTimer.unref();
  }
  function reapIdle() {
    if (client || shuttingDown || !child || exitInfo) return;
    appendLog(Buffer.from(IDLE_LOG_MARK, "utf8"));
    try { child.kill("SIGTERM"); } catch (e) { /* already gone */ }
    killGraceTimer = setTimeout(function () {
      try { child.kill("SIGKILL"); } catch (e) { /* already gone */ }
    }, KILL_GRACE_MS);
    killGraceTimer.unref();
  }

  function writeClient(buf) {
    if (!client) return;
    if (client.writableLength > CLIENT_BUFFER_LIMIT) {
      // Slow consumer: drop the connection, keep journaling for the next attach.
      try { client.destroy(); } catch (e) { /* ignore */ }
      client = null;
      handshakeSent = false;
      return;
    }
    try { client.write(buf); } catch (e) { /* close handler cleans up */ }
  }

  function cleanupFiles() {
    for (const p of [socketPath, readyPath, entryPath]) {
      if (!p) continue;
      try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
    }
  }

  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
    if (killGraceTimer) { clearTimeout(killGraceTimer); killGraceTimer = null; }
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch (e) { /* ignore */ }
      logFd = null;
    }
    try { server.close(); } catch (e) { /* ignore */ }
    cleanupFiles();
    process.exit(code === undefined ? 0 : code);
  }

  /** Send the terminal outcome (exit/spawn_error) to the current client, then shut down. */
  function finish(terminalQueued) {
    if (client) {
      if (!terminalQueued) {
        const buf = spawnError
          ? control({ t: "spawn_error", message: spawnError })
          : control({ t: "exit", code: exitInfo ? exitInfo.code : null, signal: exitInfo ? exitInfo.signal : null });
        try { client.write(buf); } catch (e) { /* ignore */ }
      }
      const sock = client;
      client = null;
      handshakeSent = false;
      try {
        sock.end(function () { shutdown(0); });
      } catch (e) {
        shutdown(0);
      }
      // Safety net: never hang on a half-closed socket.
      setTimeout(function () { shutdown(0); }, 2000).unref();
      return;
    }
    // Nobody attached yet and no explicit stop: keep the socket up briefly so a
    // starting pi-web can learn the outcome instead of guessing (fail-loud).
    // Once anything attached, or on an explicit stop, exit immediately.
    if (everConnected || explicitStop) { shutdown(0); return; }
    lingerTimer = setTimeout(function () { shutdown(0); }, EXIT_LINGER_MS);
    lingerTimer.unref();
  }

  function sendHandshake(sock) {
    if (!sock) return;
    const parts = [];
    if (spawnError) {
      parts.push(control({ t: "spawn_error", message: spawnError }));
    } else if (hello) {
      // Journal size travels with the handshake so a client can tell how much
      // replay to expect (diagnostics; the framing itself needs no metadata).
      parts.push(control(Object.assign({}, hello, { journalBytes: journalBytes, journalFrames: journal.length })));
    }
    for (const item of trimmedJournalForReplay()) parts.push(encodeFrame(item.channel, item.buf));
    if (exitInfo) parts.push(control({ t: "exit", code: exitInfo.code, signal: exitInfo.signal }));
    try {
      if (parts.length === 1) sock.write(parts[0]);
      else if (parts.length > 1) sock.write(Buffer.concat(parts));
    } catch (e) { /* close handler cleans up */ }
    handshakeSent = true;
    if (exitInfo || spawnError) finish(true);
  }

  /**
   * A liveness probe (registry.probeEndpoint: connect + destroy) and the
   * stale-socket check must NOT take the single client slot: superseding the
   * live connection on every probe killed the page's event stream (2026-11-23:
   * a hosting badge probe disconnected the chat, queue_update frames never
   * arrived, and the queue panel stayed empty until a reload).
   *
   * So a socket becomes the client only when it identifies itself — the host
   * sends a control hello_ack right after connect; a {t:"probe"} frame closes
   * the socket without touching the current client; and a socket that stays
   * connected without a word past IDENTIFY_GRACE_MS is promoted anyway (older
   * hosts never send hello_ack; their attach waits for our hello).
   */
  const IDENTIFY_GRACE_MS = 1000;
  function attachClient(sock) {
    let promoted = false;
    let identifyTimer = null;
    let pending = Buffer.alloc(0);
    const buffered = [];
    function applyFrame(channel, payload) {
      if (channel === CH_STDIN) {
        if (child && child.stdin && child.stdin.writable) child.stdin.write(payload);
      } else if (channel === CH_CTRL) {
        onControl(payload);
      }
    }
    function promote() {
      if (promoted || sock.destroyed) return;
      promoted = true;
      if (identifyTimer) { clearTimeout(identifyTimer); identifyTimer = null; }
      everConnected = true;
      disarmIdle();
      if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
      if (client && client !== sock) {
        const previous = client;
        client = null;
        try { previous.write(control({ t: "superseded" })); } catch (e) { /* ignore */ }
        try { previous.end(); } catch (e) { /* ignore */ }
        try { setTimeout(function () { previous.destroy(); }, 500).unref(); } catch (e) { /* ignore */ }
      }
      client = sock;
      handshakeSent = false;
      // Handshake at promotion time: the journal replay is current (frames
      // emitted while this socket was pending are in it, not lost to a gap).
      if (hello || spawnError) sendHandshake(sock);
      // Commands that arrived before identification (a real client's first
      // request) run after the handshake, in order.
      for (const frame of buffered) applyFrame(frame.channel, frame.payload);
      buffered.length = 0;
    }
    function onFrame(channel, payload) {
      if (!promoted) {
        let ctrl = null;
        if (channel === CH_CTRL) {
          try { ctrl = JSON.parse(payload.toString("utf8")); } catch (e) { ctrl = null; }
        }
        if (ctrl && ctrl.t === "probe") {
          // A liveness probe: never a client. No handshake, no supersede.
          try { sock.destroy(); } catch (e) { /* ignore */ }
          return;
        }
        if (!(ctrl && ctrl.t === "hello_ack")) buffered.push({ channel, payload });
        promote();
        return;
      }
      applyFrame(channel, payload);
    }
    sock.on("data", function (chunk) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let offset = 0;
      while (pending.length - offset >= 5) {
        const channel = pending.readUInt8(offset);
        const length = pending.readUInt32BE(offset + 1);
        if (length > MAX_FRAME_BYTES) { sock.destroy(); return; }
        const end = offset + 5 + length;
        if (pending.length < end) break;
        const payload = pending.subarray(offset + 5, end);
        offset = end;
        onFrame(channel, payload);
        if (sock.destroyed) return;
      }
      if (offset > 0) pending = pending.subarray(offset);
    });
    sock.on("error", function () {
      if (identifyTimer) { clearTimeout(identifyTimer); identifyTimer = null; }
      if (client === sock) { client = null; handshakeSent = false; armIdle(); }
    });
    sock.on("close", function () {
      if (identifyTimer) { clearTimeout(identifyTimer); identifyTimer = null; }
      if (client === sock) { client = null; handshakeSent = false; armIdle(); }
    });
    // Compatibility: an older host attaches and only reads (never identifies).
    // Promote it after the grace so its handshake still arrives.
    identifyTimer = setTimeout(promote, IDENTIFY_GRACE_MS);
    identifyTimer.unref?.();
  }

  function onControl(payload) {
    let frame = null;
    try { frame = JSON.parse(payload.toString("utf8")); } catch (e) { return; }
    if (!frame || frame.t !== "kill") return;
    if (!child || exitInfo) { finish(); return; }
    const signal = typeof frame.signal === "string" && frame.signal ? frame.signal : "SIGTERM";
    try { child.kill(signal); } catch (e) { /* already gone */ }
    killGraceTimer = setTimeout(function () {
      try { child.kill("SIGKILL"); } catch (e) { /* already gone */ }
    }, KILL_GRACE_MS);
    killGraceTimer.unref();
  }

  // ---- socket server ------------------------------------------------------
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const server = net.createServer(function (sock) {
    // Sockets deliver Buffers by default; the frame parser needs raw bytes.
    attachClient(sock);
  });
  server.on("error", function (err) {
    // A live socket at this path means another wrapper owns the session.
    if (err && err.code === "EADDRINUSE") {
      process.stderr.write("wrapper: session already owned (" + socketPath + ")\n");
      process.exit(3);
    }
    process.stderr.write("wrapper: server error: " + (err && err.message ? err.message : String(err)) + "\n");
    try { server.close(); } catch (e) { /* ignore */ }
    cleanupFiles();
    process.exit(1);
  });

  // Windows named pipes have no filesystem entry: listen directly (a live pipe
  // makes listen fail with EADDRINUSE, which the error handler reports).
  const IS_PIPE = process.platform === "win32"; // named pipe endpoint: no fs entry
  // Stale socket file from a crashed wrapper: only unlink when nothing listens.
  function startServer() {
    if (!IS_PIPE && fs.existsSync(socketPath)) {
      const probe = net.connect({ path: socketPath });
      let settled = false;
      const retry = function () {
        if (settled) return;
        settled = true;
        try { probe.destroy(); } catch (e) { /* ignore */ }
        try { fs.unlinkSync(socketPath); } catch (e) { /* ignore */ }
        listen();
      };
      probe.once("connect", function () {
        if (settled) return;
        settled = true;
        try { probe.destroy(); } catch (e) { /* ignore */ }
        process.stderr.write("wrapper: session already owned (" + socketPath + ")\n");
        process.exit(3);
      });
      probe.once("error", retry);
      probe.setTimeout(500, retry);
      return;
    }
    listen();
  }

  function listen() {
    server.listen(socketPath, function () {
      if (!IS_PIPE) {
        try { fs.chmodSync(socketPath, 0o600); } catch (e) { /* ignore */ }
      }
      try { fs.writeFileSync(readyPath, String(process.pid), { mode: 0o600 }); } catch (e) { /* ignore */ }
      spawnAgent();
    });
  }

  function spawnAgent() {
    const opts = {
      cwd: cfg.cwd || process.cwd(),
      env: cfg.env && typeof cfg.env === "object" ? cfg.env : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    };
    if (cfg.shell) opts.shell = cfg.shell === true ? true : cfg.shell;
    try {
      child = childProcess.spawn(String(cfg.command), Array.isArray(cfg.args) ? cfg.args.map(String) : [], opts);
    } catch (err) {
      spawnError = err && err.message ? err.message : String(err);
      if (client) sendHandshake(client);
      else finish();
      return;
    }
    child.on("spawn", function () {
      armIdle();
      hello = {
        t: "hello",
        pid: child.pid,
        wrapperPid: process.pid,
        sessionId: cfg.sessionId,
        agentKey: cfg.agentKey,
        runner: cfg.runner,
      };
      if (client && !handshakeSent) sendHandshake(client);
    });
    child.on("error", function (err) {
      if (exitInfo) return;
      spawnError = err && err.message ? err.message : String(err);
      if (client) sendHandshake(client);
      else finish();
    });
    if (child.stdout) {
      child.stdout.on("data", function (buf) {
        appendJournal(CH_STDOUT, buf);
        if (!client) armIdle();
        if (client && handshakeSent) writeClient(encodeFrame(CH_STDOUT, buf));
      });
      child.stdout.on("error", function () { /* child died mid-read */ });
    }
    if (child.stderr) {
      child.stderr.on("data", function (buf) {
        appendLog(buf);
        appendJournal(CH_STDERR, buf);
        if (!client) armIdle();
        if (client && handshakeSent) writeClient(encodeFrame(CH_STDERR, buf));
      });
      child.stderr.on("error", function () { /* child died mid-read */ });
    }
    if (child.stdin) {
      child.stdin.on("error", function () { /* EPIPE when the agent exits first */ });
    }
    child.on("exit", function (code, signal) {
      exitInfo = { code: typeof code === "number" ? code : null, signal: signal || null };
      disarmIdle();
      if (killGraceTimer) { clearTimeout(killGraceTimer); killGraceTimer = null; }
      if (client && handshakeSent) {
        finish();
      } else if (client) {
        sendHandshake(client);
      } else {
        finish();
      }
    });
  }

  function onSignal(signal) {
    explicitStop = true;
    if (child && !exitInfo) {
      try { child.kill(signal === "SIGINT" ? "SIGTERM" : signal); } catch (e) { /* ignore */ }
      killGraceTimer = setTimeout(function () {
        try { child.kill("SIGKILL"); } catch (e) { /* ignore */ }
      }, KILL_GRACE_MS);
      killGraceTimer.unref();
      return;
    }
    shutdown(0);
  }
  process.on("SIGTERM", function () { onSignal("SIGTERM"); });
  process.on("SIGINT", function () { onSignal("SIGINT"); });
  process.on("uncaughtException", function (err) {
    try { process.stderr.write("wrapper: uncaught: " + (err && err.stack ? err.stack : String(err)) + "\n"); } catch (e) { /* ignore */ }
    if (child && !exitInfo) {
      try { child.kill("SIGTERM"); } catch (e) { /* ignore */ }
    }
    setTimeout(function () { shutdown(1); }, 200);
  });

  openLog();
  startServer();
}

main();
