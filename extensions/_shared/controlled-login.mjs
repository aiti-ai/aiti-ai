/**
 * controlled-login — External agent controlled login standard · server-side shared layer (authoritative source, zero Node deps).
 *
 * ⚠ Copy sync (byte-level copies; changes must be synced to all copies; test `_shared/controlled-login.test.mjs` pins consistency):
 *   pi-web-ext/aiti-zcode-agent/controlled-login.mjs
 *   pi-web-ext/aiti-cursor-agent/controlled-login.mjs
 *   pi-web-ext/aiti-qoder-agent/controlled-login.mjs
 *   pi-web-ext/aiti-claude-code-agent/controlled-login.mjs
 *   pi-web-ext/aiti-codex-agent/controlled-login.mjs
 *
 * Target shape (docs/ext-controlled-login-standard.md): the backend spawns the official login process → captures
 * the login URL and hands it to the user's frontend → the user completes authorization in a browser on any device → the CLI
 * notices it on its own polling and persists credentials → the backend can inspect and cancel the whole flow. **Implements no
 * OAuth protocol and never touches credential contents**.
 *
 * Mode classification:
 *   - A url-only ("url"): handing out the URL is all there is; the login process polls and exits on its own. zcode/cursor/qoder/codex.
 *   - B paste-relay ("paste"): after authorization the server page shows a one-time code; the user pastes it back to the
 *     frontend, and the backend must write it into the login process's stdin to finish. claude.
 *
 * State machine (single slot, at most one login process per extension at a time):
 *   start → spawn (clean env) → accumulate stdout/stderr → extractUrl hit sets waiting+url
 *   → [paste] submit(text) writes stdin+"\r\n" → process exit goes through interpret → terminal state
 *   loginTimeoutMs backstop kill → timeout; cancel = kill → cancelled.
 *
 * State lands in `<configDir>/controlled-login.json` (**no code/token inside**):
 *   { state: "waiting"|"success"|"failed"|"timeout"|"cancelled", url?, mode?,
 *     startedAt, pid?, user?, error?, outputTail?, finishedAt? }
 *   pid is only for liveness checks (after a server restart a waiting state with a dead pid is reconciled to failed in status());
 *   failed/timeout states carry outputTail (≤1500-char stdout+stderr tail) so the dialog can surface the raw text —
 *   if a CLI upgrade changes the output format and URL capture fails, a human can still read and copy it (plan §7 risk mitigation).
 *
 * ============================================================================
 * Driver contract (~20 lines each, provided per extension; after success the credential chain
 * entirely reuses each extension's existing logic)
 * ============================================================================
 * @typedef {Object} ControlledLoginDriver
 * @property {string} agentId                       "zcode" | "cursor" | ...
 * @property {"url"|"paste"} mode                   A url-only / B paste-relay
 * @property {number} [loginTimeoutMs]              backstop kill (default 330_000; CLI internals mostly 300s)
 * @property {(argv: { runtime: string; consoleMode?: boolean }) => {
 *   cmd: string; args: string[]; env: Record<string, string>;
 * }} buildLogin                                   assembles the spawn triple; env starts from cleanEnv() (no model keys injected)
 * @property {(text: string) => string|null} extractUrl
 *                                                  grabs the loginUrl from accumulated stdout+stderr (per-vendor regex; stops at first hit)
 * @property {(code: number|null, stdout: string, stderr: string) => {
 *   state: "success"|"failed"|"timeout"; user?: string; error?: string;
 * }} interpret                                    judges the outcome from process exit (zcode "timed out" → timeout)
 *
 * Wiring (extension index.ts; create once in startup, mount with one line on server.api):
 *   const login = createControlledLogin({ driver, configDir, resolveRuntime, onSuccess });
 *   loginApi = mountControlledLoginApi(login);
 *   … server: { startup(ctx) { … }, api(req, ctx) { return loginApi(req, ctx); } }
 * Endpoints (POST bodies are all JSON; error → {error} 400):
 *   POST /api/extensions/<ext>/login/start   {consoleMode?, variant?…} → {state,url?,mode?} (idempotent)
 *   GET  /api/extensions/<ext>/login/status   → {state,url?,mode?,user?,error?,startedAt,outputTail?}
 *   POST /api/extensions/<ext>/login/cancel   → {state:"cancelled"}
 *   POST /api/extensions/<ext>/login/submit   {code} → {state} (paste mode only)
 */

import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Backstop kill duration (default 330s: CLI internals mostly hard-timeout at 300s, so the outer layer allows one notch more before killing). */
export const DEFAULT_LOGIN_TIMEOUT_MS = 330_000;

/** Clean env baseline: only passes through system locale/proxy/TLS/Windows system keys — **passes through no model key/token whatsoever**. */
const ENV_ALLOW = [
  "PATH", "HOME", "USERPROFILE", "USER", "LOGNAME", "SHELL",
  "LANG", "LC_ALL", "TERM", "TZ", "TMPDIR", "TEMP", "TMP",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  // Windows
  "SYSTEMROOT", "COMSPEC", "WINDIR", "PROGRAMFILES", "APPDATA", "LOCALAPPDATA",
];

export function cleanEnv(extra = {}) {
  const env = {};
  for (const k of ENV_ALLOW) {
    const v = process.env[k];
    if (typeof v === "string" && v) env[k] = v;
  }
  return { ...env, ...extra };
}

/** pid liveness check (signal-0 probe; EPERM = alive but no permission, counted as alive). */
export function isPidAlive(pid) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/** Last non-empty line (drivers use interpret to compose a human-readable error from it). */
export function tailLine(text, max = 300) {
  const lines = String(text ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? "").slice(0, max);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Controlled login controller (one instance per extension = single slot).
 *
 * @param {object} opts
 * @param {ControlledLoginDriver} opts.driver          vendor driver
 * @param {string} opts.configDir                        extension data directory (state file lands here)
 * @param {(argv: object) => Promise<string>} [opts.resolveRuntime]
 *                                                     resolves the CLI/runtime before spawn (reuses each extension's existing resolution;
 *                                                     throws a human-readable error when not installed → start returns a failed state)
 * @param {(info: { user?: string; stdout: string; stderr: string }) => void} [opts.onSuccess]
 *                                                     success hook (e.g. zcode warming up ensureCredential)
 * @param {(cmd: string, args: string[], o: object) => ChildProcess} [opts.spawnImpl] test injection
 * @param {number} [opts.urlWaitMs]                    upper bound for waiting on the URL before start returns (default 15s; on expiry still
 *                                                     returns waiting normally, the URL is picked up later by status polling)
 * @param {string} [opts.cwd]                          login process working directory (default process.cwd())
 * @param {(msg: string) => void} [opts.log]
 */
export function createControlledLogin(opts) {
  const driver = opts.driver;
  if (!driver || typeof driver.buildLogin !== "function" || typeof driver.extractUrl !== "function" || typeof driver.interpret !== "function") {
    throw new Error("createControlledLogin: incomplete driver contract (needs agentId/mode/buildLogin/extractUrl/interpret)");
  }
  const configDir = opts.configDir;
  if (!configDir) throw new Error("createControlledLogin: configDir is required");
  const spawnImpl = opts.spawnImpl ?? ((cmd, args, o) => nodeSpawn(cmd, args, o));
  const resolveRuntime = opts.resolveRuntime ?? (async () => "");
  const onSuccess = typeof opts.onSuccess === "function" ? opts.onSuccess : null;
  const log = opts.log ?? (() => {});
  const timeoutMs = Number(driver.loginTimeoutMs) > 0 ? Number(driver.loginTimeoutMs) : DEFAULT_LOGIN_TIMEOUT_MS;
  const urlWaitMs = Number(opts.urlWaitMs) > 0 ? Number(opts.urlWaitMs) : 15_000;
  const cwd = opts.cwd || process.cwd();

  /** Active flow (single slot): { proc, cancelled, timedOut, timer, resolveUrl, resolveExit } */
  let run = null;

  const stateFile = () => join(configDir, "controlled-login.json");
  const readState = () => {
    try { return JSON.parse(readFileSync(stateFile(), "utf8")); } catch { return null; }
  };
  const writeState = (s) => {
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(stateFile(), JSON.stringify(s, null, 2));
    } catch (e) {
      log(`[controlled-login] failed to write state file: ${e?.message || e}`);
    }
  };
  const clearState = () => { try { rmSync(stateFile(), { force: true }); } catch { /* ignore */ } };
  const mkState = (over) => ({ state: "waiting", url: null, mode: driver.mode, startedAt: Date.now(), pid: null, ...over });

  function publicView(s) {
    if (!s) return { state: "idle", mode: driver.mode };
    const out = { state: s.state, mode: s.mode ?? driver.mode, startedAt: s.startedAt };
    if (s.url) out.url = s.url;
    if (s.user) out.user = s.user;
    if (s.error) out.error = s.error;
    if (s.outputTail) out.outputTail = s.outputTail;
    return out;
  }

  function killProc(proc) {
    try { proc.kill("SIGTERM"); } catch { /* already gone */ }
    const t = setTimeout(() => {
      try {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      } catch { /* already gone */ }
    }, 3_000);
    if (typeof t.unref === "function") t.unref();
  }

  /** Status query; when state is waiting and there is no active process, reconcile liveness by pid (server restart → failed). */
  function status() {
    let s = readState();
    if (!s) return { state: "idle", mode: driver.mode };
    if (s.state === "waiting" && !run && !isPidAlive(s.pid)) {
      s = {
        ...s,
        state: "failed",
        error: s.error ?? "Login process has exited (server restarted or process was killed); please start again",
        finishedAt: Date.now(),
        pid: null,
      };
      writeState(s);
    }
    return publicView(s);
  }

  /**
   * Start a login (idempotent: while waiting and the process is alive, returns the existing state as-is, no re-spawn).
   * argv passes through to resolveRuntime (variant and other vendor params) + buildLogin (consoleMode).
   */
  async function start(argv = {}) {
    const existing = readState();
    if (existing && existing.state === "waiting" && (run || isPidAlive(existing.pid))) {
      return publicView(existing); // idempotent
    }
    if (run) { killProc(run.proc); clearTimeout(run.timer); run = null; } // backstop-clear leftovers
    clearState();

    const failStart = (error) => {
      const s = mkState({ state: "failed", error, finishedAt: Date.now() });
      writeState(s);
      return publicView(s);
    };

    let runtime = "";
    try {
      runtime = await resolveRuntime(argv ?? {});
    } catch (e) {
      return failStart(e?.message || String(e));
    }
    let built;
    try {
      built = driver.buildLogin({ runtime, ...(argv?.consoleMode ? { consoleMode: true } : {}) });
    } catch (e) {
      return failStart(e?.message || String(e));
    }

    let proc;
    try {
      proc = spawnImpl(built.cmd, built.args, { cwd, env: built.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return failStart(`Failed to start login process ${built.cmd}: ${e?.message || e}`);
    }

    const ctx = { proc, cancelled: false, timedOut: false, timer: null };
    run = ctx;
    let resolveUrl = () => {};
    let resolveExit = () => {};
    const urlSeen = new Promise((r) => { resolveUrl = r; });
    const exitSeen = new Promise((r) => { resolveExit = r; });

    let stdoutBuf = "";
    let stderrBuf = "";
    let captured = false;
    const tryCapture = () => {
      if (captured) return;
      const url = driver.extractUrl(stdoutBuf + "\n" + stderrBuf);
      if (!url) return;
      captured = true;
      const s = readState();
      if (s && s.state === "waiting" && !s.url) { s.url = url; writeState(s); }
      resolveUrl(url);
    };
    proc.stdout?.on?.("data", (c) => { stdoutBuf += typeof c === "string" ? c : c.toString("utf8"); tryCapture(); });
    proc.stderr?.on?.("data", (c) => { stderrBuf += typeof c === "string" ? c : c.toString("utf8"); tryCapture(); });

    writeState(mkState({ pid: typeof proc.pid === "number" ? proc.pid : null }));
    tryCapture(); // race backstop (extreme case where data arrives before this line)

    const writeTerminal = (update, tailText) => {
      const s = readState() ?? mkState({});
      const next = {
        ...s,
        state: update.state,
        finishedAt: Date.now(),
        ...(update.user ? { user: update.user } : {}),
        ...(update.error ? { error: update.error } : {}),
      };
      if ((update.state === "failed" || update.state === "timeout") && tailText) {
        next.outputTail = tailText.trim().slice(-1500);
      }
      writeState(next);
      return next;
    };

    proc.on?.("error", (err) => {
      if (run !== ctx || ctx.cancelled || ctx.timedOut) return;
      run = null;
      clearTimeout(ctx.timer);
      writeTerminal({ state: "failed", error: `Failed to start login process ${built.cmd}: ${err?.message || err} (verify the CLI is installed and on PATH)` });
      resolveExit();
    });

    proc.on?.("exit", (code) => {
      if (run !== ctx) return; // taken over by cancel/timeout/a new round: someone else already wrote the terminal state
      run = null;
      clearTimeout(ctx.timer);
      resolveExit();
      if (ctx.cancelled || ctx.timedOut) return;
      let r;
      try {
        r = driver.interpret(code, stdoutBuf, stderrBuf);
      } catch (e) {
        r = { state: "failed", error: `interpret threw: ${e?.message || e}` };
      }
      writeTerminal(r, stdoutBuf + "\n" + stderrBuf);
      if (r.state === "success" && onSuccess) {
        try { onSuccess({ user: r.user, stdout: stdoutBuf, stderr: stderrBuf }); } catch (e) {
          log(`[controlled-login] onSuccess failed (does not affect the login result): ${e?.message || e}`);
        }
      }
    });

    ctx.timer = setTimeout(() => {
      if (run !== ctx) return;
      ctx.timedOut = true;
      run = null;
      killProc(proc);
      writeTerminal({ state: "timeout", error: `Login timed out (${Math.round(timeoutMs / 1000)}s without completed authorization; process terminated)` }, stdoutBuf + "\n" + stderrBuf);
      resolveExit();
    }, timeoutMs);
    if (typeof ctx.timer.unref === "function") ctx.timer.unref();

    // start caller: URL hit / quick exit / urlWaitMs — first of the three wins (if none arrives,
    // still returns waiting normally; the frontend's status polling picks up the URL later)
    await Promise.race([urlSeen, exitSeen, sleep(urlWaitMs)]);
    return status();
  }

  /** B mode only: feeds the user-pasted code (or full callback URL) verbatim into the login process's stdin. */
  async function submit(text) {
    const s = readState();
    if (!s || s.state !== "waiting") throw new Error("No login currently in progress");
    if (driver.mode !== "paste") throw new Error(`${driver.agentId} login is in url mode (no code submission needed)`);
    if (!run || !run.proc?.stdin?.writable) throw new Error("Login process not running (may have exited); please start a new login");
    const line = String(text ?? "").trim().replace(/[\r\n]+$/, "");
    if (!line) throw new Error("Submitted content is empty");
    // Backpressure correction (same as A4): write() returning false only means the frame entered the buffer, not a failure — throw only on real failure
    try {
      run.proc.stdin.write(line + "\r\n");
    } catch (e) {
      throw new Error(`Failed to write login process stdin: ${e?.message || e}`);
    }
    return status();
  }

  /** Cancel: kill → cancelled (idempotent: with no flow in progress, returns the current state as-is). */
  async function cancel() {
    const s = readState();
    if (!s || s.state !== "waiting") return status();
    if (run) {
      run.cancelled = true;
      clearTimeout(run.timer);
      killProc(run.proc);
      run = null;
    }
    writeState({ ...s, state: "cancelled", finishedAt: Date.now() });
    return publicView(readState());
  }

  /** Cleans up leftover processes/timers when the extension stops or unloads. */
  function dispose() {
    if (run) {
      clearTimeout(run.timer);
      killProc(run.proc);
      run = null;
    }
  }

  return { start, status, cancel, submit, dispose };
}

/**
 * API mounting helper: returns a handler usable directly as the extension's `server.api` (returns null to pass through when not matching /login/*).
 * Usage: `api(req, ctx) { return loginApi(req, ctx); }`
 */
export function mountControlledLoginApi(controller) {
  async function readJsonBody(req) {
    try { return await req.json(); } catch { return {}; }
  }
  return async function controlledLoginApi(req, ctx) {
    const segs = Array.isArray(ctx?.path) ? ctx.path : [];
    if (segs[0] !== "login") return null;
    const sub = segs[1] ?? "";
    const method = String(ctx?.method ?? "GET").toUpperCase();
    const allowed =
      (sub === "start" && method === "POST") ||
      (sub === "status" && method === "GET") ||
      (sub === "cancel" && method === "POST") ||
      (sub === "submit" && method === "POST");
    if (!allowed) {
      return Response.json({ error: `Unknown login endpoint /login/${sub} (${method})` }, { status: 404 });
    }
    try {
      if (sub === "start") {
        return Response.json(await controller.start(await readJsonBody(req)));
      }
      if (sub === "status") {
        return Response.json(controller.status());
      }
      if (sub === "cancel") {
        return Response.json(await controller.cancel());
      }
      // sub === "submit"
      const body = await readJsonBody(req);
      const code = typeof body?.code === "string" ? body.code : "";
      if (!code.trim()) throw new Error("Missing code (paste the code shown on the page after completing authorization, or the full callback link)");
      return Response.json(await controller.submit(code));
    } catch (e) {
      return Response.json({ error: e?.message || String(e) }, { status: 400 });
    }
  };
}
