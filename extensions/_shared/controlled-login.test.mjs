/**
 * controlled-login tests — 外部 Agent 受控登录标准（共享层状态机 + 副本同步 + 五家 driver fixture）。
 *
 * Run: node --test pi-web-ext/_shared/controlled-login.test.mjs
 *
 * 桩机制：spawnImpl 注入 EventEmitter 假子进程（stdout/stderr data + exit 事件、stdin writes、
 * kill 记录）——零真进程零网络。fixture 样本取自方案实测记录
 * （docs/ext-controlled-login-standard.md §1 + docs/zcode-controlled-login-analysis.md §2）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHARED = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SHARED, "..");

const cl = await import("./controlled-login.mjs");

// 五家 driver（zcode 在 zcode-core.ts；cursor/claude/codex 内联 index.ts；qoder 独立 login-driver.ts
// —— index.ts 顶部有 WASM 预热副作用，不进测试面）
const zcore = await import(pathToFileURL(join(ROOT, "aiti-zcode-agent/zcode-core.ts")).href);
const cursorMod = await import(pathToFileURL(join(ROOT, "aiti-cursor-agent/index.ts")).href);
const claudeMod = await import(pathToFileURL(join(ROOT, "aiti-claude-code-agent/index.ts")).href);
const codexMod = await import(pathToFileURL(join(ROOT, "aiti-codex-agent/index.ts")).href);
const qoderDrv = await import(pathToFileURL(join(ROOT, "aiti-qoder-agent/login-driver.ts")).href);

const flush = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// 假子进程工厂
// ============================================================================

let spawnCalls = [];

function makeFakeProc(pid = 42000 + spawnCalls.length) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = {
    writable: true,
    writes: [],
    write(s) { proc.stdin.writes.push(s); return true; },
  };
  proc.kills = [];
  proc.kill = (sig) => { proc.kills.push(sig); queueMicrotask(() => proc.emit("exit", null, sig)); return true; };
  return proc;
}

/** 建一个受控登录控制器：spawnImpl 出假进程并登记；driver 可覆盖。 */
const TMP_DIRS = [];
function makeController(over = {}) {
  const configDir = over.configDir ?? mkdtempSync(join(tmpdir(), "cl-test-"));
  if (!over.configDir) TMP_DIRS.push(configDir);
  const driver = {
    agentId: "stub",
    mode: "url",
    buildLogin: ({ runtime }) => ({ cmd: runtime || "stubcli", args: ["login"], env: { STUB: "1" } }),
    extractUrl: (t) => { const m = /https:\/\/stub\.example\/auth\?\S+/.exec(t); return m ? m[0] : null; },
    interpret: (code) => (code === 0 ? { state: "success", user: "tester" } : { state: "failed", error: `exit ${code}` }),
    ...over.driver,
  };
  let nextProc = null;
  const spawnCount = { n: 0 };
  const spawnImpl = () => {
    const p = over.makeProc ? over.makeProc() : makeFakeProc();
    nextProc = p;
    spawnCount.n += 1;
    spawnCalls.push({ cmd: "stub", args: ["login"], proc: p });
    return p;
  };
  const onSuccessCalls = [];
  const ctrl = cl.createControlledLogin({
    driver,
    configDir,
    resolveRuntime: over.resolveRuntime ?? (async () => "runtime-ok"),
    spawnImpl,
    onSuccess: (info) => onSuccessCalls.push(info),
    urlWaitMs: over.urlWaitMs ?? 40,
    log: over.log ?? (() => {}),
    ...over.opts,
  });
  return { ctrl, configDir, driver, onSuccessCalls, getProc: () => nextProc, spawnCount };
}

// ============================================================================
// 状态机：waiting / 幂等 / success / failed / timeout / cancel / submit / pid
// ============================================================================

test("start: spawn → URL 命中 → waiting + url；状态文件含 pid 不含 code", async () => {
  const { ctrl, configDir, getProc } = makeController();
  const started = ctrl.start({});
  await flush();
  getProc().stderr.emit("data", "Open this URL to sign in:\nhttps://stub.example/auth?x=1\n");
  const res = await started;
  assert.equal(res.state, "waiting");
  assert.equal(res.url, "https://stub.example/auth?x=1");
  assert.equal(res.mode, "url");
  assert.ok(!("pid" in res), "公开状态不透出 pid");
  const raw = JSON.parse(readFileSync(join(configDir, "controlled-login.json"), "utf8"));
  assert.equal(typeof raw.pid, "number");
  assert.ok(!JSON.stringify(raw).includes("code="), "状态文件不含 code/token");
});

test("start: 幂等——waiting 且进程存活时重复 start 不重复 spawn，原样返回既有 url", async () => {
  const { ctrl, getProc, spawnCount } = makeController();
  const started = ctrl.start({});
  await flush();
  getProc().stdout.emit("data", "go https://stub.example/auth?idempotent\n");
  const first = await started;
  const second = await ctrl.start({});
  assert.equal(spawnCount.n, 1);
  assert.equal(second.url, first.url);
  assert.equal(second.state, "waiting");
});

test("exit 0 → success + user + onSuccess 钩子；终态清 pid", async () => {
  const { ctrl, configDir, getProc, onSuccessCalls } = makeController();
  const started = ctrl.start({});
  await flush();
  getProc().stdout.emit("data", "https://stub.example/auth?done=1\n");
  await started;
  getProc().emit("exit", 0);
  await flush();
  const s = ctrl.status();
  assert.equal(s.state, "success");
  assert.equal(s.user, "tester");
  assert.equal(onSuccessCalls.length, 1);
  assert.equal(onSuccessCalls[0].user, "tester");
  const raw = JSON.parse(readFileSync(join(configDir, "controlled-login.json"), "utf8"));
  assert.equal(raw.state, "success");
  assert.ok(raw.finishedAt > 0);
});

test("exit 非 0 → failed，error 落状态；failed 附 outputTail 原文", async () => {
  const { ctrl, getProc } = makeController({
    driver: { interpret: () => ({ state: "failed", error: "boom" }) },
  });
  const started = ctrl.start({});
  await flush();
  getProc().stderr.emit("data", "some raw output for tail\n");
  await started;
  getProc().emit("exit", 1);
  await flush();
  const s = ctrl.status();
  assert.equal(s.state, "failed");
  assert.equal(s.error, "boom");
  assert.match(s.outputTail, /some raw output for tail/);
});

test("loginTimeoutMs 兜底：超时 kill → timeout 态", async () => {
  const { ctrl, getProc } = makeController({
    driver: { loginTimeoutMs: 120 },
    urlWaitMs: 30,
  });
  const started = ctrl.start({});
  await flush();
  await started; // urlWaitMs 30 到点，无 URL 也返回 waiting（timeout 120ms 未到）
  assert.equal(ctrl.status().state, "waiting");
  await sleep(160);
  const s = ctrl.status();
  assert.equal(s.state, "timeout");
  assert.match(s.error, /超时/);
  assert.ok(getProc().kills.includes("SIGTERM"));
});

test("cancel: kill → cancelled；之后再 submit 报错", async () => {
  const { ctrl, getProc } = makeController();
  const started = ctrl.start({});
  await flush();
  getProc().stdout.emit("data", "https://stub.example/auth?cancel=1\n");
  await started;
  const c = await ctrl.cancel();
  assert.equal(c.state, "cancelled");
  assert.ok(getProc().kills.includes("SIGTERM"));
  await assert.rejects(() => ctrl.submit("ABC"), /没有进行中的登录/);
  // 幂等：无进行中流程时 cancel 原样返回当前状态
  const again = await ctrl.cancel();
  assert.equal(again.state, "cancelled");
});

test("paste 模式 submit：原样写 stdin + \\r\\n（剥用户粘贴尾随换行）", async () => {
  const { ctrl, getProc } = makeController({ driver: { mode: "paste" } });
  const started = ctrl.start({});
  await flush();
  getProc().stdout.emit("data", "authorize: https://stub.example/auth?p=1\n");
  await started;
  await ctrl.submit("ABC-123\n");
  assert.deepEqual(getProc().stdin.writes, ["ABC-123\r\n"]);
});

test("url 模式 submit 拒绝；无进行中流程 submit 拒绝", async () => {
  const { ctrl, getProc } = makeController();
  await assert.rejects(() => ctrl.submit("X"), /没有进行中的登录/);
  const started = ctrl.start({});
  await flush();
  getProc().stdout.emit("data", "https://stub.example/auth?u=1\n");
  await started;
  await assert.rejects(() => ctrl.submit("X"), /url 模式/);
});

test("resolveRuntime 失败 → failed + 人话 error（fail-loud，不 spawn）", async () => {
  const { ctrl, spawnCount } = makeController({
    resolveRuntime: async () => { throw new Error("未找到 xxx CLI（PATH 上无 xxx）"); },
  });
  const res = await ctrl.start({});
  assert.equal(res.state, "failed");
  assert.match(res.error, /未找到 xxx CLI/);
  assert.equal(spawnCount.n, 0);
});

test("spawn error 事件（ENOENT 等）→ failed 人话", async () => {
  const { ctrl, getProc } = makeController();
  const started = ctrl.start({});
  await flush();
  getProc().emit("error", new Error("spawn stubcli ENOENT"));
  await flush();
  const s = ctrl.status();
  assert.equal(s.state, "failed");
  assert.match(s.error, /ENOENT/);
});

test("服务重启 reconcile：waiting + pid 死 → status 返回 failed", async () => {
  const { ctrl, configDir } = makeController();
  // 手工落一个 waiting 态（模拟重启前的残留），pid 指向不存在的进程
  writeFileSync(join(configDir, "controlled-login.json"), JSON.stringify({
    state: "waiting", url: null, mode: "url", startedAt: Date.now() - 1000, pid: 999999999,
  }));
  const s = ctrl.status();
  assert.equal(s.state, "failed");
  assert.match(s.error, /重新发起/);
});

test("终态后重新 start：全新 spawn（spawn 计数 +1，旧进程 kill 清理）", async () => {
  const { ctrl, getProc, spawnCount } = makeController();
  const first = ctrl.start({});
  await flush();
  getProc().stdout.emit("data", "https://stub.example/auth?r1=1\n");
  await first;
  getProc().emit("exit", 0);
  await flush();
  assert.equal(ctrl.status().state, "success");
  const second = await ctrl.start({});
  assert.equal(spawnCount.n, 2);
  assert.equal(second.state, "waiting");
});

test("dispose：清残活进程", async () => {
  const { ctrl, getProc } = makeController();
  const started = ctrl.start({});
  await flush();
  getProc().stdout.emit("data", "https://stub.example/auth?d=1\n");
  await started;
  ctrl.dispose();
  assert.ok(getProc().kills.includes("SIGTERM"));
  // dispose 后 waiting 态留文件；下次 status 因 pid 死（假进程非真 pid）→ failed（可接受语义）
});

// ============================================================================
// API 挂载 helper（mountControlledLoginApi）
// ============================================================================

function apiReq(path, method, body) {
  return new Request("http://x/api/extensions/t/" + path.join("/"), {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
}

test("mountControlledLoginApi：start/status/submit/cancel 全链 + 非 login 路径放行", async () => {
  const { ctrl, getProc } = makeController({ driver: { mode: "paste" } });
  const api = cl.mountControlledLoginApi(ctrl);

  // 非 login 路径 → null（放行给扩展其他端点）
  assert.equal(await api(apiReq(["usage"], "GET"), { path: ["usage"], method: "GET" }), null);
  // 未知端点 → 404
  const nf = await api(apiReq(["login", "nope"], "GET"), { path: ["login", "nope"], method: "GET" });
  assert.equal(nf.status, 404);

  // status：idle
  const s0 = await (await api(apiReq(["login", "status"], "GET"), { path: ["login", "status"], method: "GET" })).json();
  assert.equal(s0.state, "idle");

  // start
  const started = api(apiReq(["login", "start"], "POST", {}), { path: ["login", "start"], method: "POST" });
  await flush();
  getProc().stdout.emit("data", "https://stub.example/auth?api=1\n");
  const s1 = await (await started).json();
  assert.equal(s1.state, "waiting");
  assert.equal(s1.url, "https://stub.example/auth?api=1");

  // submit（paste）
  const s2 = await (await api(apiReq(["login", "submit"], "POST", { code: "CC-9" }), { path: ["login", "submit"], method: "POST" })).json();
  assert.equal(s2.state, "waiting");
  assert.deepEqual(getProc().stdin.writes, ["CC-9\r\n"]);
  // submit 缺 code → 400
  const bad = await api(apiReq(["login", "submit"], "POST", {}), { path: ["login", "submit"], method: "POST" });
  assert.equal(bad.status, 400);

  // cancel
  const s3 = await (await api(apiReq(["login", "cancel"], "POST", {}), { path: ["login", "cancel"], method: "POST" })).json();
  assert.equal(s3.state, "cancelled");
});

// ============================================================================
// 副本同步断言（前端弹窗，字节级一致）
// （服务端 controlled-login.mjs 五份副本已退役为 @aiti-ai/ext-shared 包导入——M2a，2026-09-16）
// ============================================================================

const EXT_IDS = ["aiti-zcode-agent", "aiti-cursor-agent", "aiti-qoder-agent", "aiti-claude-code-agent", "aiti-codex-agent"];


test("副本同步：controlled-login-dialog.mjs 五份 client 拷贝与权威源字节一致", () => {
  const auth = readFileSync(join(SHARED, "controlled-login-dialog.mjs"));
  for (const id of EXT_IDS) {
    const p = join(ROOT, id, "client", "src", "controlled-login-dialog.mjs"); // dist-migration 后副本统一在 client/src/
    assert.ok(existsSync(p), `缺副本: ${relative(ROOT, p)}`);
    assert.ok(auth.equals(readFileSync(p)), `副本与权威源不一致: ${relative(ROOT, p)}`);
  }
});

test("图标库：key-round.svg 存在且为 lucide 线图风格（currentColor / fill none）", () => {
  const svg = readFileSync(join(SHARED, "icons", "key-round.svg"), "utf8");
  assert.match(svg, /stroke="currentColor"/);
  assert.match(svg, /fill="none"/);
  assert.match(svg, /viewBox="0 0 24 24"/);
});

// ============================================================================
// 五家 driver fixture（方案 §1 实测 stdout/stderr 样本钉死）
// ============================================================================

const ZCODE_STDERR = "Open this URL to sign in:\n" +
  "https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg&redirect_uri=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback%2Fzai&state=e3b0c44298fc1c14&response_type=code\n";
const ZCODE_READY_STDOUT = JSON.stringify({
  status: "ready", provider: "zai",
  user: { user_id: "u_1", email: "me@example.com", name: "Wind", avatar: "" },
  model: "glm-5.3", credentialsPath: "~/.zcode/v2/credentials.json", configPath: "~/.zcode/cli/config.json", browserOpened: false,
}, null, 2);

test("zcode driver：stderr 抓 URL / ready JSON → success+user / timed out → timeout / clean env", async () => {
  const d = zcore.zcodeLoginDriver;
  assert.equal(d.mode, "url");
  // URL（stderr，--json 档）
  assert.equal(
    d.extractUrl(ZCODE_STDERR),
    "https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg&redirect_uri=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback%2Fzai&state=e3b0c44298fc1c14&response_type=code",
  );
  assert.equal(d.extractUrl("no url here"), null);
  // 成功：exit 0 + stdout JSON ready → user 取 name
  const ok = d.interpret(0, ZCODE_READY_STDOUT, "");
  assert.equal(ok.state, "success");
  assert.equal(ok.user, "Wind");
  // 超时：exit 1 + Error: Authorization timed out
  const to = d.interpret(1, "", "Error: Authorization timed out. Please retry login.\n");
  assert.equal(to.state, "timeout");
  // 失败：exit 1 + 其他 Error
  const fail = d.interpret(1, "", "Error: config_update_failed\n");
  assert.equal(fail.state, "failed");
  assert.match(fail.error, /config_update_failed/);
  // spawn 三元组：node + runtime + login --no-browser --json；env 干净（不含模型 key）
  const built = d.buildLogin({ runtime: "/data/runtime/zcode.cjs" });
  assert.equal(built.args[0], "/data/runtime/zcode.cjs");
  assert.deepEqual(built.args.slice(1), ["login", "--no-browser", "--json"]);
  assert.ok(!("ZCODE_API_KEY" in built.env) && !("ZCODE_MODEL" in built.env), "login env 不注入模型 key");
  assert.ok(built.env.PATH, "保留 PATH");
});

const CURSOR_STDOUT = "To authenticate, copy and paste this open URL:\n" +
  "navigate to this link: https://cursor.com/loginDeepControl?uuid=9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d&verifier=TAmv7f\n" +
  "Waiting for authorization...\n";

test("cursor driver：stdout 抓 loginDeepControl 链接 / NO_OPEN_BROWSER=1 / 退出码判结果", () => {
  const d = cursorMod.cursorLoginDriver;
  assert.equal(d.mode, "url");
  assert.equal(d.extractUrl(CURSOR_STDOUT), "https://cursor.com/loginDeepControl?uuid=9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d&verifier=TAmv7f");
  assert.equal(d.extractUrl("navigate to this link: not-a-url"), null);
  const built = d.buildLogin({ runtime: "/usr/bin/cursor" });
  assert.deepEqual([built.cmd, ...built.args], ["/usr/bin/cursor", "login"]);
  assert.equal(built.env.NO_OPEN_BROWSER, "1");
  assert.ok(!("CURSOR_API_KEY" in built.env));
  assert.deepEqual(cursorMod.interpretCursorLogin(0, "", ""), { state: "success" });
  const f = cursorMod.interpretCursorLogin(1, "", "auth failed: bad credentials\n");
  assert.equal(f.state, "failed");
  assert.match(f.error, /auth failed/);
});

const QODER_STDOUT_INTL = "Visit the following URL to sign in:\n" +
  "https://qoder.com/device/selectAccounts?challenge=czlCQ0haTnpO&nonce=a1b2c3d4&machine_id=MIIDdDCCAil&client_id=qoder_cli\n";
const QODER_STDOUT_CN = "请打开以下链接登录：\n" +
  "https://qoder.com.cn/device/selectAccounts?challenge=Y24xMjM0NTY&nonce=e5f6a7b8&machine_id=Q0404GTHT3&client_id=qoderclicn\n";

test("qoder driver：双区域 selectAccounts URL 都命中 / NO_BROWSER=true", () => {
  const d = qoderDrv.qoderLoginDriver;
  assert.equal(d.mode, "url");
  assert.equal(d.extractUrl(QODER_STDOUT_INTL), "https://qoder.com/device/selectAccounts?challenge=czlCQ0haTnpO&nonce=a1b2c3d4&machine_id=MIIDdDCCAil&client_id=qoder_cli");
  assert.equal(d.extractUrl(QODER_STDOUT_CN), "https://qoder.com.cn/device/selectAccounts?challenge=Y24xMjM0NTY&nonce=e5f6a7b8&machine_id=Q0404GTHT3&client_id=qoderclicn");
  assert.equal(d.extractUrl("see https://qoder.com/docs for help"), null);
  const built = d.buildLogin({ runtime: "/usr/local/bin/qoderclicn" });
  assert.deepEqual([built.cmd, ...built.args], ["/usr/local/bin/qoderclicn", "login"]);
  assert.equal(built.env.NO_BROWSER, "true");
  assert.deepEqual(qoderDrv.interpretQoderLogin(0, "", ""), { state: "success" });
  const f = qoderDrv.interpretQoderLogin(1, "", "Error: poll failed\n");
  assert.equal(f.state, "failed");
  assert.match(f.error, /poll failed/);
});

const CLAUDE_STDOUT = "OAuth authorization is required before proceeding.\n" +
  "Open this URL to authorize in your browser:\n" +
  "https://claude.com/cai/oauth/authorize?code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=hC9j&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&client_id=9d1c250a-3bf\n" +
  "\nPaste code here if prompted > ";

test("claude driver：paste 模式 / authorize URL 抓取 / --console 档 / 退出码判结果", () => {
  const d = claudeMod.claudeLoginDriver;
  assert.equal(d.mode, "paste", "claude 是唯一 paste-relay 家");
  assert.equal(
    d.extractUrl(CLAUDE_STDOUT),
    "https://claude.com/cai/oauth/authorize?code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=hC9j&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&client_id=9d1c250a-3bf",
  );
  // claude.ai 旧域同样命中
  assert.ok(d.extractUrl("see https://claude.ai/cai/oauth/authorize?code_challenge=x&state=y").startsWith("https://claude.ai/"));
  // 默认档与 --console 档
  assert.deepEqual(claudeMod.claudeLoginDriver.buildLogin({ runtime: "claude" }).args, ["auth", "login"]);
  assert.deepEqual(claudeMod.claudeLoginDriver.buildLogin({ runtime: "claude", consoleMode: true }).args, ["auth", "login", "--console"]);
  assert.deepEqual(claudeMod.interpretClaudeLogin(0, "Login successful.", ""), { state: "success" });
  const f = claudeMod.interpretClaudeLogin(1, "", "Error: invalid code\n");
  assert.equal(f.state, "failed");
  assert.match(f.error, /invalid code/);
});

const CODEX_STDOUT = "Signing in...\n" +
  "1. Open this URL in your browser: https://auth.openai.com/api/accounts/deviceauth/usercode?user_code=WTMH-JPQT\n" +
  "2. Enter the code shown below.\n";

test("codex driver：--device-auth / 通用 URL 抓取（⚠ 155 首跑校准 TODO）/ 退出码判结果", () => {
  const d = codexMod.codexLoginDriver;
  assert.equal(d.mode, "url");
  // ⚠ TODO(155 校准)：输出格式未实测，样本为合成；正则=通用 https 兜底
  assert.equal(d.extractUrl(CODEX_STDOUT), "https://auth.openai.com/api/accounts/deviceauth/usercode?user_code=WTMH-JPQT");
  // localhost 回调（非 device-auth 默认档）不命中——受控登录只走设备码
  assert.equal(d.extractUrl("callback server at http://localhost:1455/auth/callback"), null);
  // 错误行内括号包裹的 URL：尾标点（右括号）不能带进 URL（agent-manager 直显可点）
  assert.equal(
    d.extractUrl("Error logging in with device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode)"),
    "https://auth.openai.com/api/accounts/deviceauth/usercode",
  );
  const built = d.buildLogin({ runtime: "/usr/bin/codex" });
  assert.deepEqual([built.cmd, ...built.args], ["/usr/bin/codex", "login", "--device-auth"]);
  assert.deepEqual(codexMod.interpretCodexLogin(0, "Logged in.", ""), { state: "success" });
  const f = codexMod.interpretCodexLogin(1, "", "Error: stream error\n");
  assert.equal(f.state, "failed");
  assert.match(f.error, /stream error/);
});

// ============================================================================
// 清理
// ============================================================================

test.after(() => {
  for (const d of TMP_DIRS) rmSync(d, { recursive: true, force: true });
});
