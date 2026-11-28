/**
 * controlled-login — 外部 Agent 受控登录标准 · 服务端共享层（权威源，Node 零依赖）。
 *
 * ⚠ 副本同步（字节级拷贝，改动须同步到全部副本；测试 `_shared/controlled-login.test.mjs` 钉住一致性）：
 *   pi-web-ext/aiti-zcode-agent/controlled-login.mjs
 *   pi-web-ext/aiti-cursor-agent/controlled-login.mjs
 *   pi-web-ext/aiti-qoder-agent/controlled-login.mjs
 *   pi-web-ext/aiti-claude-code-agent/controlled-login.mjs
 *   pi-web-ext/aiti-codex-agent/controlled-login.mjs
 *
 * 目标形态（docs/ext-controlled-login-standard.md）：后端 spawn 官方 login 进程 → 抓出
 * login URL 交给用户前端 → 用户在任意设备的浏览器完成授权 → CLI 自己轮询感知并落盘凭据
 * → 后端全流程可查可取消。**不实现任何 OAuth 协议、不碰凭据内容**。
 *
 * 模式分类：
 *   - A url-only（"url"）：URL 交出去即完事，login 进程自己轮询并退出。zcode/cursor/qoder/codex。
 *   - B paste-relay（"paste"）：授权完成后服务端页面显示一次性 code，用户粘回前端，
 *     后端写进 login 进程 stdin 才能完成。claude。
 *
 * 状态机（单槽，每扩展同时至多一个 login 进程）：
 *   start → spawn（干净 env）→ 积累 stdout/stderr → extractUrl 命中置 waiting+url
 *   → [paste] submit(text) 写 stdin+"\r\n" → 进程退出走 interpret → 终态
 *   loginTimeoutMs 兜底 kill → timeout；cancel = kill → cancelled。
 *
 * 状态落 `<configDir>/controlled-login.json`（**不含 code/token**）：
 *   { state: "waiting"|"success"|"failed"|"timeout"|"cancelled", url?, mode?,
 *     startedAt, pid?, user?, error?, outputTail?, finishedAt? }
 *   pid 仅供存活检查（服务重启后 waiting 态死 pid 在 status() 里 reconcile 成 failed）；
 *   failed/timeout 态附 outputTail（≤1500 字符 stdout+stderr 尾巴）供弹窗透出原文——
 *   CLI 升级改输出格式导致 URL 抓取失败时人工可读可复制（方案 §7 风险对策）。
 *
 * ============================================================================
 * Driver 契约（每家 ~20 行，由各扩展提供；成功后凭据链路全走各扩展现成逻辑）
 * ============================================================================
 * @typedef {Object} ControlledLoginDriver
 * @property {string} agentId                       "zcode" | "cursor" | ...
 * @property {"url"|"paste"} mode                   A url-only / B paste-relay
 * @property {number} [loginTimeoutMs]              兜底 kill（默认 330_000；CLI 内部多为 300s）
 * @property {(argv: { runtime: string; consoleMode?: boolean }) => {
 *   cmd: string; args: string[]; env: Record<string, string>;
 * }} buildLogin                                   组装 spawn 三元组；env 用 cleanEnv() 起底（不注入模型 key）
 * @property {(text: string) => string|null} extractUrl
 *                                                  从累计 stdout+stderr 抓 loginUrl（各家正则，命中即停）
 * @property {(code: number|null, stdout: string, stderr: string) => {
 *   state: "success"|"failed"|"timeout"; user?: string; error?: string;
 * }} interpret                                    进程退出判结果（zcode「timed out」→ timeout）
 *
 * 接入（扩展 index.ts，startup 里建一次、server.api 一行挂载）：
 *   const login = createControlledLogin({ driver, configDir, resolveRuntime, onSuccess });
 *   loginApi = mountControlledLoginApi(login);
 *   … server: { startup(ctx) { … }, api(req, ctx) { return loginApi(req, ctx); } }
 * 端点（POST body 均 JSON；错误 → {error} 400）：
 *   POST /api/extensions/<ext>/login/start   {consoleMode?, variant?…} → {state,url?,mode?}（幂等）
 *   GET  /api/extensions/<ext>/login/status   → {state,url?,mode?,user?,error?,startedAt,outputTail?}
 *   POST /api/extensions/<ext>/login/cancel   → {state:"cancelled"}
 *   POST /api/extensions/<ext>/login/submit   {code} → {state}（仅 paste 模式）
 */

import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 兜底 kill 时长（默认 330s：CLI 内部多为 300s 硬超时，外层放宽一档再杀）。 */
export const DEFAULT_LOGIN_TIMEOUT_MS = 330_000;

/** 干净 env 起底：只透传系统定位/代理/TLS/Windows 系统键——**不透传任何模型 key/token**。 */
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

/** pid 存活检查（0 信号探测；EPERM = 存活但无权限，按活算）。 */
export function isPidAlive(pid) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/** 最后一条非空行（driver interpret 组人话 error 用）。 */
export function tailLine(text, max = 300) {
  const lines = String(text ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? "").slice(0, max);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 受控登录控制器（每扩展一个实例 = 单槽）。
 *
 * @param {object} opts
 * @param {ControlledLoginDriver} opts.driver          家驱动
 * @param {string} opts.configDir                        扩展数据目录（状态文件落这里）
 * @param {(argv: object) => Promise<string>} [opts.resolveRuntime]
 *                                                     spawn 前解析 CLI/runtime（复用各扩展现有解析；
 *                                                     未装 throw 人话错误 → start 返回 failed 态）
 * @param {(info: { user?: string; stdout: string; stderr: string }) => void} [opts.onSuccess]
 *                                                     成功钩子（如 zcode 预热 ensureCredential）
 * @param {(cmd: string, args: string[], o: object) => ChildProcess} [opts.spawnImpl] 测试注入
 * @param {number} [opts.urlWaitMs]                    start 返回前等 URL 的上限（默认 15s；超了也照常
 *                                                     waiting，URL 由 status 轮询补见）
 * @param {string} [opts.cwd]                          login 进程工作目录（默认 process.cwd()）
 * @param {(msg: string) => void} [opts.log]
 */
export function createControlledLogin(opts) {
  const driver = opts.driver;
  if (!driver || typeof driver.buildLogin !== "function" || typeof driver.extractUrl !== "function" || typeof driver.interpret !== "function") {
    throw new Error("createControlledLogin: driver 契约不完整（需 agentId/mode/buildLogin/extractUrl/interpret）");
  }
  const configDir = opts.configDir;
  if (!configDir) throw new Error("createControlledLogin: configDir 必填");
  const spawnImpl = opts.spawnImpl ?? ((cmd, args, o) => nodeSpawn(cmd, args, o));
  const resolveRuntime = opts.resolveRuntime ?? (async () => "");
  const onSuccess = typeof opts.onSuccess === "function" ? opts.onSuccess : null;
  const log = opts.log ?? (() => {});
  const timeoutMs = Number(driver.loginTimeoutMs) > 0 ? Number(driver.loginTimeoutMs) : DEFAULT_LOGIN_TIMEOUT_MS;
  const urlWaitMs = Number(opts.urlWaitMs) > 0 ? Number(opts.urlWaitMs) : 15_000;
  const cwd = opts.cwd || process.cwd();

  /** 活动流程（单槽）：{ proc, cancelled, timedOut, timer, resolveUrl, resolveExit } */
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
      log(`[controlled-login] 状态文件写失败: ${e?.message || e}`);
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

  /** 状态查询；waiting 态且无活动进程时按 pid 做存活 reconcile（服务重启 → failed）。 */
  function status() {
    let s = readState();
    if (!s) return { state: "idle", mode: driver.mode };
    if (s.state === "waiting" && !run && !isPidAlive(s.pid)) {
      s = {
        ...s,
        state: "failed",
        error: s.error ?? "登录进程已退出（服务重启或进程被终止），请重新发起",
        finishedAt: Date.now(),
        pid: null,
      };
      writeState(s);
    }
    return publicView(s);
  }

  /**
   * 发起登录（幂等：waiting 且进程存活时原样返回既有状态，不重复 spawn）。
   * argv 透传 resolveRuntime（variant 等家参数）+ buildLogin（consoleMode）。
   */
  async function start(argv = {}) {
    const existing = readState();
    if (existing && existing.state === "waiting" && (run || isPidAlive(existing.pid))) {
      return publicView(existing); // 幂等
    }
    if (run) { killProc(run.proc); clearTimeout(run.timer); run = null; } // 兜底清残活
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
      return failStart(`无法启动登录进程 ${built.cmd}：${e?.message || e}`);
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
    tryCapture(); // 竞态兜底（数据先于本行到达的极端情况）

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
      writeTerminal({ state: "failed", error: `无法启动登录进程 ${built.cmd}：${err?.message || err}（请确认 CLI 已安装并在 PATH）` });
      resolveExit();
    });

    proc.on?.("exit", (code) => {
      if (run !== ctx) return; // 被 cancel/timeout/新一轮接管：终态已有人写
      run = null;
      clearTimeout(ctx.timer);
      resolveExit();
      if (ctx.cancelled || ctx.timedOut) return;
      let r;
      try {
        r = driver.interpret(code, stdoutBuf, stderrBuf);
      } catch (e) {
        r = { state: "failed", error: `interpret 异常：${e?.message || e}` };
      }
      writeTerminal(r, stdoutBuf + "\n" + stderrBuf);
      if (r.state === "success" && onSuccess) {
        try { onSuccess({ user: r.user, stdout: stdoutBuf, stderr: stderrBuf }); } catch (e) {
          log(`[controlled-login] onSuccess 失败（不影响登录结果）: ${e?.message || e}`);
        }
      }
    });

    ctx.timer = setTimeout(() => {
      if (run !== ctx) return;
      ctx.timedOut = true;
      run = null;
      killProc(proc);
      writeTerminal({ state: "timeout", error: `登录超时（${Math.round(timeoutMs / 1000)}s 未完成授权，进程已终止）` }, stdoutBuf + "\n" + stderrBuf);
      resolveExit();
    }, timeoutMs);
    if (typeof ctx.timer.unref === "function") ctx.timer.unref();

    // start 调用方：URL 命中 / 快速退出 / urlWaitMs，三者先到先回（未等到也照常 waiting，
    // URL 由前端 status 轮询补见）
    await Promise.race([urlSeen, exitSeen, sleep(urlWaitMs)]);
    return status();
  }

  /** B 模式专属：把用户粘来的 code（或完整回调 URL）原样喂 login 进程 stdin。 */
  async function submit(text) {
    const s = readState();
    if (!s || s.state !== "waiting") throw new Error("当前没有进行中的登录");
    if (driver.mode !== "paste") throw new Error(`${driver.agentId} 登录为 url 模式（无需提交 code）`);
    if (!run || !run.proc?.stdin?.writable) throw new Error("登录进程未在运行（可能已退出），请重新发起登录");
    const line = String(text ?? "").trim().replace(/[\r\n]+$/, "");
    if (!line) throw new Error("提交内容为空");
    // 背压修正（同 A4）：write() 返回 false 仅表示帧入缓冲，不是失败——真失败才 throw
    try {
      run.proc.stdin.write(line + "\r\n");
    } catch (e) {
      throw new Error(`登录进程 stdin 写失败: ${e?.message || e}`);
    }
    return status();
  }

  /** 取消：kill → cancelled（幂等：无进行中流程时原样返回当前状态）。 */
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

  /** 扩展停卸时清残留进程/定时器。 */
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
 * API 挂载 helper：返回可直接用作扩展 `server.api` 的处理器（不匹配 /login/* 时返回 null 放行）。
 * 用法：`api(req, ctx) { return loginApi(req, ctx); }`
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
      return Response.json({ error: `未知登录端点 /login/${sub}（${method}）` }, { status: 404 });
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
      if (!code.trim()) throw new Error("缺少 code（粘贴授权完成后页面显示的 code，或完整回调链接）");
      return Response.json(await controller.submit(code));
    } catch (e) {
      return Response.json({ error: e?.message || String(e) }, { status: 400 });
    }
  };
}
