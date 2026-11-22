import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Integration tests for the aiti-desktop-widget shell itself (screen behaviour, not JS).
 *
 * Runs against `target/release/aiti-desktop-widget` by default; set `AITI_DESKTOP_WIDGET_BIN` to
 * test an installed binary. GUI assertions need a reachable DISPLAY + xdotool;
 * when DISPLAY is absent a private Xvfb + openbox is started on :98. Drag checks
 * additionally need a window manager (openbox) and are skipped without one.
 *
 *   node --test tests/shell.test.mjs
 *   DISPLAY=:95 node --test tests/shell.test.mjs
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (bin) => {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

function resolveBinary() {
  const fromEnv = String(process.env.AITI_DESKTOP_WIDGET_BIN || "").trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const built = join(root, "target", "release", process.platform === "win32" ? "aiti-desktop-widget.exe" : "aiti-desktop-widget");
  if (existsSync(built)) return built;
  const installed = join(homedir(), ".pi", "bin", process.platform === "win32" ? "aiti-desktop-widget.exe" : "aiti-desktop-widget");
  return existsSync(installed) ? installed : "";
}

const BIN = resolveBinary();
const spawned = [];

function displayAlive(display) {
  try {
    execFileSync("xdpyinfo", [], { env: { ...process.env, DISPLAY: display }, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function startPrivateDisplay() {
  if (!has("Xvfb")) return "";
  const display = ":98";
  if (existsSync("/tmp/.X98-lock")) return "";
  const xvfb = spawn("Xvfb", [display, "-screen", "0", "1920x1080x24"], { stdio: "ignore" });
  spawned.push(xvfb);
  return display;
}

let DISPLAY = String(process.env.DISPLAY || "").trim();
if (!DISPLAY || !displayAlive(DISPLAY)) {
  DISPLAY = startPrivateDisplay();
  // Fixed settle: Xvfb opens its socket within a few hundred ms (no polling).
  if (DISPLAY) await sleep(1200);
}

let wm = "";
if (DISPLAY) {
  if (has("openbox")) {
    const proc = spawn("openbox", [], { env: { ...process.env, DISPLAY }, stdio: "ignore" });
    spawned.push(proc);
    wm = "openbox";
    await sleep(600);
  }
  if (has("picom")) {
    const proc = spawn("picom", [], { env: { ...process.env, DISPLAY }, stdio: "ignore" });
    spawned.push(proc);
    await sleep(600);
  }
}

after(() => {
  for (const proc of spawned.reverse()) {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* gone */
    }
  }
});

const guiSkip = !BIN
  ? "no aiti-desktop-widget binary (build: cargo build --release)"
  : !DISPLAY || !displayAlive(DISPLAY)
    ? "no reachable DISPLAY and Xvfb unavailable"
    : !has("xdotool")
      ? "xdotool missing"
      : false;

function startWidget(args) {
  const child = spawn(BIN, args, {
    env: { ...process.env, DISPLAY },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  const waiters = [];
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr = (stderr + data.toString()).slice(-4000);
  });
  child.stdout.on("data", (data) => {
    buffer += data.toString();
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(event);
      for (const waiter of [...waiters]) {
        if (!waiter.pred(event)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    }
  });
  const closed = new Promise((resolveClose) => child.once("close", resolveClose));
  return {
    child,
    events,
    stderr: () => stderr,
    wait(pred, label, timeoutMs = 10000) {
      const seen = events.find(pred);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolveWait, rejectWait) => {
        const waiter = { pred, resolve: resolveWait, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          rejectWait(new Error(`timeout waiting for ${label}; events=${JSON.stringify(events)} stderr=${stderr}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    closed,
    async close() {
      try {
        child.stdin.write(JSON.stringify({ cmd: "close" }) + "\n");
      } catch {
        /* gone */
      }
      await Promise.race([closed, sleep(3000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

function geometry(title) {
  const id = execFileSync("xdotool", ["search", "--name", title], {
    env: { ...process.env, DISPLAY },
    encoding: "utf8",
  })
    .trim()
    .split("\n")[0];
  const out = execFileSync("xdotool", ["getwindowgeometry", id], {
    env: { ...process.env, DISPLAY },
    encoding: "utf8",
  });
  const match = /Position: (-?\d+),(-?\d+)/.exec(out);
  return { id, x: Number(match[1]), y: Number(match[2]) };
}

function request(port, path, headers = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers, method: "GET" }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolveRequest({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", rejectRequest);
    req.end();
  });
}

const fixture = mkdtempSync(join(tmpdir(), "aiti-desktop-widget-test-"));
writeFileSync(
  join(fixture, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><title>WIDGET TEST</title>' +
    '<link rel="stylesheet" href="style.css"></head><body><div id="grip">local</div></body></html>',
);
writeFileSync(join(fixture, "style.css"), "html,body{margin:0;background:transparent}#grip{color:#fff}");
writeFileSync(join(fixture, "asset.txt"), "0123456789");
after(() => {
  try {
    rmSync(fixture, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test("--html serves a loopback page, blocks traversal and supports ranges", { skip: guiSkip }, async () => {
  const widget = startWidget([
    "--html", `${join(fixture, "index.html")}?mode=test&x=1`,
    "--width", "900", "--height", "140",
    "--display", "0", "--center", "true",
    "--title", "WIDGET-HTML",
    "--click-through", "true",
  ]);
  try {
    const ready = await widget.wait((event) => event.t === "ready", "ready");
    assert.equal(ready.display, 0);
    assert.ok(Array.isArray(ready.monitors) && ready.monitors.length >= 1);
    assert.ok(ready.url.startsWith("http://127.0.0.1:"), ready.url);
    assert.ok(ready.url.endsWith("?mode=test&x=1"), ready.url);
    const port = Number(ready.url.split(":")[2].split("/")[0]);

    const moved = await widget.wait((event) => event.t === "moved" && event.x === 510 && event.y === 470, "centered moved");
    assert.equal(moved.x, 510);
    assert.equal(moved.y, 470);
    await sleep(250);
    const placed = geometry("WIDGET-HTML");
    assert.deepEqual({ x: placed.x, y: placed.y }, { x: 510, y: 470 });

    const page = await request(port, "/index.html");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.match(page.body, /WIDGET TEST/);
    const css = await request(port, "/style.css");
    assert.equal(css.status, 200);
    assert.match(css.headers["content-type"], /text\/css/);

    const ranged = await request(port, "/asset.txt", { Range: "bytes=2-5" });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers["content-range"], "bytes 2-5/10");
    assert.equal(ranged.body, "2345");

    for (const path of ["/%2e%2e/%2e%2e/etc/passwd", "/..%5c..%5cetc%5cpasswd"]) {
      const escaped = await request(port, path);
      assert.equal(escaped.status, 403, path);
    }
    const missing = await request(port, "/nope.html");
    assert.equal(missing.status, 404);
  } finally {
    await widget.close();
  }
});

test("stdin move/center/displays place the window on a monitor", { skip: guiSkip }, async () => {
  const widget = startWidget([
    "--html", join(fixture, "index.html"),
    "--width", "900", "--height", "140",
    "--display", "0", "--center", "true",
    "--title", "WIDGET-STDIN",
  ]);
  try {
    await widget.wait((event) => event.t === "ready", "ready");
    await widget.wait((event) => event.t === "moved" && event.x === 510, "initial center");
    widget.child.stdin.write(JSON.stringify({ cmd: "move", display: 0, x: 100, y: 50 }) + "\n");
    const moved = await widget.wait((event) => event.t === "moved" && event.x === 100 && event.y === 50, "move");
    assert.deepEqual({ x: moved.x, y: moved.y }, { x: 100, y: 50 });
    widget.child.stdin.write(JSON.stringify({ cmd: "center" }) + "\n");
    await widget.wait((event) => event.t === "moved" && event.x === 510 && event.y === 470, "recenter");
    widget.child.stdin.write(JSON.stringify({ cmd: "displays" }) + "\n");
    const displays = await widget.wait((event) => event.t === "displays", "displays");
    assert.equal(displays.display, 0);
    assert.ok(displays.monitors.length >= 1);
  } finally {
    await widget.close();
  }
});

test("--config carries html/display/center", { skip: guiSkip }, async () => {
  const config = join(fixture, "widget.json");
  writeFileSync(
    config,
    JSON.stringify({
      schema: 1,
      html: join(fixture, "index.html"),
      window: { width: 800, height: 100, title: "WIDGET-CFG", display: "0", center: true, clickThrough: true },
    }),
  );
  const widget = startWidget(["--config", config]);
  try {
    const ready = await widget.wait((event) => event.t === "ready", "ready");
    assert.equal(ready.display, 0);
    const moved = await widget.wait((event) => event.t === "moved" && event.x === 560 && event.y === 490, "config center");
    assert.deepEqual({ x: moved.x, y: moved.y }, { x: 560, y: 490 });
  } finally {
    await widget.close();
  }
});

test("drag region moves the window", { skip: guiSkip || !wm ? "needs a window manager (openbox) for _NET_WM_MOVERESIZE" : false }, async () => {
  const widget = startWidget([
    "--html", join(fixture, "index.html"),
    "--width", "400", "--height", "160",
    "--x", "300", "--y", "300", "--display", "0",
    "--title", "WIDGET-DRAG",
    "--draggable", "true", "--drag-region", "#grip",
  ]);
  try {
    await widget.wait((event) => event.t === "ready", "ready");
    await sleep(700);
    const before = geometry("WIDGET-DRAG");
    execFileSync("xdotool", ["mousemove", String(before.x + 150), String(before.y + 15)], { env: { ...process.env, DISPLAY } });
    execFileSync("xdotool", ["mousedown", "1"], { env: { ...process.env, DISPLAY } });
    await sleep(200);
    execFileSync("xdotool", ["mousemove", String(before.x + 250), String(before.y + 95)], { env: { ...process.env, DISPLAY } });
    await sleep(200);
    execFileSync("xdotool", ["mouseup", "1"], { env: { ...process.env, DISPLAY } });
    await widget.wait((event) => event.t === "moved" && event.x !== before.x, "dragged");
    await sleep(250);
    const after = geometry("WIDGET-DRAG");
    assert.notEqual(after.x, before.x);
  } finally {
    await widget.close();
  }
});

test("unknown display and url/html conflicts exit with code 2", { skip: !BIN ? "no aiti-desktop-widget binary" : false }, () => {
  const unknown = spawn(BIN, ["--url", "http://127.0.0.1:1/x", "--display", "99"], {
    env: { ...process.env, DISPLAY },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  unknown.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  const conflict = spawn(BIN, ["--url", "http://127.0.0.1:1/x", "--html", join(fixture, "index.html")], {
    env: { ...process.env, DISPLAY },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let conflictErr = "";
  conflict.stderr.on("data", (data) => {
    conflictErr += data.toString();
  });
  return Promise.all([
    new Promise((resolveClose) => unknown.once("close", resolveClose)).then((code) => {
      assert.equal(code, 2, stderr);
      assert.match(stderr, /out of range/);
    }),
    new Promise((resolveClose) => conflict.once("close", resolveClose)).then((code) => {
      assert.equal(code, 2, conflictErr);
      assert.match(conflictErr, /mutually exclusive/);
    }),
  ]);
});
