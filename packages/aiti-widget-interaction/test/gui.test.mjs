import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { InteractionBroker, InteractionWidgetWindow, DesktopCover, resolveWidgetBinary, startInteractionServer } from "../dist/index.js";

/**
 * GUI checks for the widget-backed pieces (cover, placement, daemon window lifecycle).
 *
 * They need a reachable DISPLAY plus xdotool; without one a private Xvfb + openbox is
 * started on :97. Tests skip themselves when no display, no Xvfb or no widget binary is
 * available, so the package suite still runs headless in CI.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const has = (bin) => {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const alive = (display) => {
  try {
    execFileSync("xdpyinfo", [], { env: { ...process.env, DISPLAY: display }, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const spawned = [];
let DISPLAY = String(process.env.DISPLAY || "").trim();
if (DISPLAY && !alive(DISPLAY)) DISPLAY = "";
if (!DISPLAY && has("Xvfb") && !existsSync("/tmp/.X97-lock")) {
  spawned.push(spawn("Xvfb", [":97", "-screen", "0", "1920x1080x24"], { stdio: "ignore" }));
  DISPLAY = ":97";
  await sleep(1200);
}
let wm = false;
if (DISPLAY && alive(DISPLAY) && has("openbox")) {
  spawned.push(spawn("openbox", [], { stdio: "ignore", env: { ...process.env, DISPLAY } }));
  wm = true;
  await sleep(600);
}
if (DISPLAY) process.env.DISPLAY = DISPLAY;

after(() => {
  for (const proc of spawned.reverse()) {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* gone */
    }
  }
});

const BIN = resolveWidgetBinary();
const skip = !BIN
  ? "no aiti-desktop-widget binary (cargo build --release / npm install -g @aiti-ai/aiti-desktop-widget)"
  : !DISPLAY || !alive(DISPLAY)
    ? "no reachable DISPLAY and Xvfb unavailable"
    : !has("xdotool")
      ? "xdotool missing"
      : !wm
        ? "no window manager (openbox) for placement/focus checks"
        : false;

function geometry(title) {
  const env = { ...process.env, DISPLAY };
  // Tauri keeps a hidden 10x10 helper window with the same name; pick a real one.
  const ids = execFileSync("xdotool", ["search", "--name", title], { env, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const id of ids) {
    const info = execFileSync("xdotool", ["getwindowgeometry", id], { env, encoding: "utf8" });
    const match = /Position: (-?\d+),(-?\d+)[\s\S]*Geometry: (\d+)x(\d+)/.exec(info);
    if (!match) continue;
    const rect = { id, x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
    if (rect.width > 50 && rect.height > 50) return rect;
  }
  throw new Error(`no visible window named ${title}`);
}

function startDaemon(args = []) {
  const child = spawn(process.execPath, [new URL("../bin/aiti-dialog.mjs", import.meta.url).pathname, "--daemon", "--port", "0", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon did not print its address")), 8000);
    let buffer = "";
    child.stdout.on("data", (data) => {
      buffer += data;
      const line = buffer.split("\n").find((entry) => entry.trim().startsWith("{"));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
  });
  return { child, ready, exited };
}

test("cover window sits at the requested rect and follows updates", { skip }, async () => {
  const cover = new DesktopCover({ rect: { x: 200, y: 120, width: 900, height: 600 }, color: "#101216", pattern: "grid", title: "cover probe" });
  try {
    assert.equal(await cover.open(), true);
    await sleep(2200);
    const first = geometry("cover probe");
    assert.deepEqual({ x: first.x, y: first.y, width: first.width, height: first.height }, { x: 200, y: 120, width: 900, height: 600 });
    const extents = execFileSync("xprop", ["-id", first.id, "_NET_FRAME_EXTENTS"], { env: { ...process.env, DISPLAY }, encoding: "utf8" });
    assert.match(extents, /0, 0, 0, 0/);

    assert.equal(await cover.update({ rect: { x: 320, y: 240, width: 500, height: 300 }, color: "#000000", opacity: 0.5, pattern: "solid" }), true);
    await sleep(900);
    const second = geometry("cover probe");
    assert.deepEqual({ x: second.x, y: second.y, width: second.width, height: second.height }, { x: 320, y: 240, width: 500, height: 300 });
  } finally {
    await cover.close();
  }
});

test("a card can be placed exactly when geometry is pinned", { skip }, async () => {
  const broker = new InteractionBroker();
  const server = await startInteractionServer({ broker, port: 0, autosize: false });
  const win = new InteractionWidgetWindow({ width: 460, height: 220, x: 140, y: 260, title: "placement probe" });
  try {
    assert.equal(await win.open(server.url), true);
    await sleep(2200);
    const placed = geometry("placement probe");
    assert.deepEqual({ x: placed.x, y: placed.y, width: placed.width, height: placed.height }, { x: 140, y: 260, width: 460, height: 220 });
    assert.equal(win.move(200, 300), true);
    await sleep(600);
    const moved = geometry("placement probe");
    assert.deepEqual({ x: moved.x, y: moved.y }, { x: 200, y: 300 });
  } finally {
    await win.close();
    await server.close();
    broker.close();
  }
});

test("daemon reopens the window after the user closes it", { skip }, async () => {
  const instance = startDaemon(["--ttl", "60"]);
  const info = await instance.ready;
  const auth = { "content-type": "application/json", authorization: `Bearer ${info.token}` };
  const pidOf = (id) => {
    try {
      return /_NET_WM_PID\(CARDINAL\) = (\d+)/.exec(execFileSync("xprop", ["-id", id, "_NET_WM_PID"], { env: { ...process.env, DISPLAY }, encoding: "utf8" }))[1];
    } catch {
      return "";
    }
  };
  try {
    await sleep(2200);
    const first = geometry("aiti-dialog");
    // X reuses window ids, so remember the pid now instead of re-reading it after the close.
    const firstPid = pidOf(first.id);
    execFileSync("xdotool", ["windowclose", first.id], { env: { ...process.env, DISPLAY } });
    await sleep(1500);

    const created = await fetch(`${info.baseUrl}interactions`, { method: "POST", headers: auth, body: JSON.stringify({ kind: "confirm", title: "Reopen" }) });
    assert.equal(created.status, 200);
    await sleep(2200);
    const reopened = geometry("aiti-dialog");
    assert.ok(firstPid, "the first window should expose _NET_WM_PID");
    assert.notEqual(pidOf(reopened.id), firstPid, "a new widget process should host the reopened window");

    const answered = await fetch(`${info.baseUrl}interactions/${(await created.json()).id}/answer`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ action: "approve", approved: true }),
    });
    assert.equal(answered.status, 200);
  } finally {
    instance.child.kill("SIGTERM");
    await Promise.race([instance.exited, sleep(3000)]);
  }
});
