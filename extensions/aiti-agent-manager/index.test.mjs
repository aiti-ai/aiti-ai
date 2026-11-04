/**
 * aiti-agent-manager — index.ts 动态发现/聚合/ctl 代理/账号档端点测试（fake 宿主 registry + fake services）。
 *
 * 架构二版（2026-09-13）：manager 不写死各家——本测试以 fake `ctx.services` 模拟各家扩展
 * provide 的 `<extId>.agent` 描述符，验证收集/聚合/代理/账号档全链路。
 *
 * Run: node --test pi-web-ext/aiti-agent-manager/index.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { after } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── fake 宿主 registry（必须先于 import index.ts 注入）──
const calls = []; // { extId, segs, method, body }
const handlers = {
  // 受控登录标准扩展：/login/start|cancel|submit|status
  "aiti-zcode-agent": (segs, method, body) => {
    if (segs[0] === "status") return { state: "idle", mode: "url" };
    if (segs[0] === "start") return { state: "waiting", mode: "url" };
    return { state: "idle" };
  },
  // codebuddy：status（ready/missing 语义 + account 身份）+ tui/status + key/clear
  "aiti-codebuddy-agent": (segs, method, body) => {
    if (segs[0] === "status") return { state: "ready", mode: "apikey", account: { user: "李永", uin: "123", expiresAt: 1797048848890 } };
    if (segs[0] === "tui" && segs[1] === "status") return { state: "waiting", sid: "s_x", url: "https://sso/x" };
    if (segs[0] === "key") return { state: "ready" };
    if (segs[0] === "clear") return { state: "missing" };
    return {};
  },
};
// 并行测试卫生：备份并替换全局（文件结束时还原，防干扰同池其他测试文件）
const __savedPiWebExt = globalThis.__piWebExt;
globalThis.__piWebExt = {
  status: () => ({
    "aiti-zcode-agent": {},
    "aiti-codebuddy-agent": {},
    "aiti-claude-code-agent": {},
    "aiti-codex-agent": {},
    "aiti-cursor-agent": {},
    "aiti-qoder-agent": {},
    "aiti-not-an-agent": {},          // 未 provide 描述符 → 不出现
    "aiti-disabled-agent": { enabled: false }, // 禁用 → 不出现
  }),
  api: async (req, segs) => {
    // segs 形态 = [extId, "login", ...sub]；handler 只看 sub
    const extId = segs[0];
    const sub = segs.slice(2);
    calls.push({ extId, segs: sub, method: req.method });
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : undefined;
    const h = handlers[extId];
    if (!h) return null;
    return Response.json(h(sub, req.method, body));
  },
};

// ── fake services：各家 provide 的 `<extId>.agent` 描述符（manager 动态发现数据源）──
const tmpHome = mkdtempSync(join(tmpdir(), "agent-mgr-home-"));
const tmpCodebuddyAuth = join(tmpHome, ".local", "share", "CodeBuddyExtension", "Data", "Public", "auth");
mkdirSync(tmpCodebuddyAuth, { recursive: true });
writeFileSync(join(tmpCodebuddyAuth, "Tencent-Cloud.coding-copilot.info"), JSON.stringify({ account: { nickname: "李永", uin: "123" }, auth: { accessToken: "t", refreshToken: "r" } }));

const DESCRIPTORS = {
  "aiti-zcode-agent": {
    agent: "zcode", label: "ZCode CLI (智谱)", modes: ["url"],
    auth: [{ kind: "file", path: [".zcode", "v2", "credentials.json"], label: "~/.zcode/v2/credentials.json" }],
    accountSlots: (c) => [{ key: "zcode-credentials", label: "桌面端凭据（加密）", path: join(c.home, ".zcode", "v2", "credentials.json") }],
  },
  "aiti-codebuddy-agent": {
    agent: "codebuddy", label: "CodeBuddy Code (腾讯)", modes: ["apikey", "tui"], extReportsAuthState: true,
    dependencyHint: "npx -y @tencent-ai/codebuddy-code（或 npm i -g）",
    auth: [{ kind: "file", path: [".codebuddy", "settings.json"], label: "~/.codebuddy/settings.json" }],
    accountSlots: (c) => [
      { key: "cli-auth/Tencent-Cloud.coding-copilot.info", label: "CLI OAuth · Tencent-Cloud.coding-copilot.info", path: join(tmpCodebuddyAuth, "Tencent-Cloud.coding-copilot.info") },
      { key: "managed-credentials", label: "托管凭据（API Key）", path: join(c.webDataRoot, "aiti-codebuddy-agent", "config", "codebuddy-credentials.json") },
    ],
    actions: {
      "tui-start": { m: "POST", sub: ["tui", "start"], body: true },
      "tui-status": { m: "GET", sub: ["tui", "status"] },
      "tui-input": { m: "POST", sub: ["tui", "input"], body: true },
      "tui-cancel": { m: "POST", sub: ["tui", "cancel"] },
      "set-key": { m: "POST", sub: ["key"], body: true },
      "clear": { m: "POST", sub: ["clear"] },
    },
  },
  "aiti-claude-code-agent": { agent: "claude", label: "Claude Code", modes: ["paste"], auth: [{ kind: "file", path: [".claude", ".credentials.json"], label: "~/.claude/.credentials.json" }], accountSlots: (c) => [{ key: "claude-oauth", label: "OAuth 凭据", path: join(c.home, ".claude", ".credentials.json") }] },
  "aiti-codex-agent": { agent: "codex", label: "Codex CLI", modes: ["url"], auth: [{ kind: "file", path: [".codex", "auth.json"], label: "~/.codex/auth.json" }], accountSlots: (c) => [{ key: "codex-auth", label: "OAuth 凭据", path: join(c.home, ".codex", "auth.json") }] },
  "aiti-cursor-agent": { agent: "cursor", label: "Cursor Agent CLI", modes: ["url"], auth: [{ kind: "file", path: [".config", "cursor", "auth.json"], label: "~/.config/cursor/auth.json" }], accountSlots: (c) => [{ key: "cursor-auth", label: "OAuth 凭据", path: join(c.home, ".config", "cursor", "auth.json") }] },
  "aiti-qoder-agent": { agent: "qoder", label: "Qoder CLI", modes: ["url"], auth: [], accountSlots: (c) => [{ key: "qoder-user", label: "凭据（国际版）", path: join(c.home, ".qoder", ".auth", "user") }, { key: "qoder-cn-user", label: "凭据（中国版）", path: join(c.home, ".qoder-cn", ".auth", "user") }] },
};
const fakeServices = {
  get: (key) => {
    const m = /^(.*)\.agent$/.exec(String(key));
    return m ? DESCRIPTORS[m[1]] : undefined;
  },
  provide: () => () => {},
};

const { default: ext } = await import("./index.ts");
// 账号档写临时 configDir——防测试的自动保险（/ctl/*/start）把真实凭据写进真实 configDir
const testConfigDir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
ext.server.startup({ configDir: testConfigDir, services: fakeServices });

function api(method, segs, body) {
  return ext.server.api(new Request("http://local/" + segs.join("/"), {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  }), { path: segs, method, searchParams: new URLSearchParams() });
}

test("声明：ui 插入点与 client 注册 id 对齐（toolbar + dialogs）", () => {
  assert.equal(ext.ui.toolbar[0].id, "aiti-agent-manager-panel");
  assert.equal(ext.ui.dialogs[0].id, "aiti-agent-manager-panel-dialog");
  assert.equal(ext.client, "dist/agent-manager-client.mjs");
});

test("GET /agents：动态发现 6 家（跳过未 provide/禁用扩展）+ 聚合字段", async () => {
  const res = await api("GET", ["agents"]);
  const d = await res.json();
  const ids = d.agents.map((a) => a.agent).sort();
  assert.deepEqual(ids, ["claude", "codebuddy", "codex", "cursor", "qoder", "zcode"]);
  assert.equal(d.agents.some((a) => a.extId === "aiti-not-an-agent"), false, "未 provide 描述符 → 不出现");
  assert.equal(d.agents.some((a) => a.extId === "aiti-disabled-agent"), false, "禁用扩展 → 不出现");
  const cb = d.agents.find((a) => a.agent === "codebuddy");
  assert.equal(cb.authState, "ready", "扩展智能端点归一");
  assert.equal(cb.tui.tuiSid, "s_x", "tui-status 聚合透传");
  assert.equal(cb.tui.tuiUrl, "https://sso/x");
  assert.equal(cb.dependencyHint.includes("codebuddy"), true, "descriptor 字段透传");
  assert.ok(Array.isArray(cb.accounts), "账号档列表透传");
  assert.equal(typeof cb.hasContent, "boolean");
  assert.ok(Array.isArray(d.piHost), "piHost 数组");
});

test("POST /ctl/{agent}/start：转发到扩展 /login/start（先拉 status 取身份）", async () => {
  calls.length = 0;
  const res = await api("POST", ["ctl", "zcode", "start"], {});
  const d = await res.json();
  assert.equal(d.state, "waiting");
  assert.deepEqual(calls.find((c) => c.segs[0] === "start"), { extId: "aiti-zcode-agent", segs: ["start"], method: "POST" });
});

test("POST /ctl/codebuddy/*：descriptor.actions 转发（tui-start/set-key/clear）", async () => {
  calls.length = 0;
  await api("POST", ["ctl", "codebuddy", "set-key"], { apiKey: "sk-1" });
  assert.deepEqual(calls.find((c) => c.segs[0] === "key"), { extId: "aiti-codebuddy-agent", segs: ["key"], method: "POST" });
  calls.length = 0;
  await api("POST", ["ctl", "codebuddy", "tui-start"], { site: "1" });
  assert.deepEqual(calls.find((c) => c.segs[0] === "tui"), { extId: "aiti-codebuddy-agent", segs: ["tui", "start"], method: "POST" });
  calls.length = 0;
  await api("POST", ["ctl", "codebuddy", "clear"], {});
  assert.deepEqual(calls.find((c) => c.segs[0] === "clear"), { extId: "aiti-codebuddy-agent", segs: ["clear"], method: "POST" });
});

test("未知 agent / 不支持动作 / 扩展不可达 → 404/404/502", async () => {
  const e1 = await api("POST", ["ctl", "nonexistent", "start"], {});
  assert.equal(e1.status, 404);
  const e2 = await api("POST", ["ctl", "zcode", "frobnicate"], {});
  assert.equal(e2.status, 404);
  const e3 = await api("POST", ["ctl", "qoder", "start"], {}); // handlers 无 qoder → api 返回 null
  assert.equal(e3.status, 502);
});

test("GET /login-status：/agents 别名", async () => {
  const res = await api("GET", ["login-status"]);
  const d = await res.json();
  assert.equal(d.agents.length, 6);
});

// ── 账号档端点（单文件存储；槽位来自 fake descriptor）──
test("GET /accounts：6 家总览 + 槽位现状（descriptor.accountSlots 驱动）", async () => {
  const res = await api("GET", ["accounts"]);
  const d = await res.json();
  assert.ok(String(d.file).startsWith(tmpdir()), "store 文件在临时目录");
  assert.deepEqual(Object.keys(d.agents).sort(), ["claude", "codebuddy", "codex", "cursor", "qoder", "zcode"]);
  assert.equal(d.agents.qoder.slots.length, 2, "qoder 双变体槽位");
  const cbAuth = d.agents.codebuddy.slots.find((s) => s.key.startsWith("cli-auth/"));
  assert.equal(cbAuth.exists, true, "codebuddy CLI auth 槽位存在（测试夹具）");
});

test("账号档 save/list/switch（codebuddy；身份+展示元数据来自 status.account）", async () => {
  const save = await (await api("POST", ["accounts", "codebuddy", "save"], { alias: "李永" })).json();
  assert.equal(save.ok, true);
  assert.equal(save.entry.current, true);
  assert.equal(save.entry.note, "李永");
  assert.equal(save.entry.user, "李永", "展示元数据：user");
  assert.equal(save.entry.uin, "123", "展示元数据：uin");
  assert.equal(save.entry.expiresAt, 1797048848890, "展示元数据：有效期");
  const list = await (await api("GET", ["accounts"])).json();
  assert.equal(list.agents.codebuddy.accounts[0].alias, "李永");
  assert.equal(list.agents.codebuddy.accounts[0].current, true);
  assert.equal(list.agents.codebuddy.accounts[0].uin, "123");
  const sw = await (await api("POST", ["accounts", "codebuddy", "switch"], { alias: "李永" })).json();
  assert.equal(sw.ok, true);
  assert.equal(sw.autoSaved, false, "同身份自身切换 → 不生成保险档");
});

test("旧档展示元数据回填：身份命中且缺 account → 聚合后持久补齐（uin/expiresAt）", async () => {
  const storeFile = join(testConfigDir, "agent-accounts.json");
  writeFileSync(storeFile, JSON.stringify({
    version: 1,
    accounts: { codebuddy: { "旧档": { savedAt: 1, identity: "李永|123", files: { "cli-auth/Tencent-Cloud.coding-copilot.info": { data: "{}" } } } } },
  }));
  const d = await (await api("GET", ["agents"])).json();
  const cb = d.agents.find((a) => a.agent === "codebuddy");
  const old = cb.accounts.find((a) => a.alias === "旧档");
  assert.equal(old.user, "李永");
  assert.equal(old.uin, "123");
  assert.equal(old.expiresAt, 1797048848890);
  const persisted = JSON.parse(readFileSync(storeFile, "utf8"));
  assert.equal(persisted.accounts.codebuddy["旧档"].account.uin, "123", "回填已持久化");
});

test("POST /accounts/{agent}/*：非法别名/不存在档/未知 agent → 400/400/404", async () => {
  const e1 = await api("POST", ["accounts", "zcode", "save"], { alias: "../evil" });
  assert.equal(e1.status, 400);
  const e2 = await api("POST", ["accounts", "zcode", "switch"], { alias: "不存在的档" });
  assert.equal(e2.status, 400);
  const e3 = await api("POST", ["accounts", "nope", "save"], { alias: "x" });
  assert.equal(e3.status, 404);
  const e4 = await api("POST", ["accounts", "zcode", "frobnicate"], {});
  assert.equal(e4.status, 404);
  const d = await (await api("POST", ["accounts", "zcode", "remove"], { alias: "不存在的档" })).json();
  assert.equal(d.ok, false, "删除不存在的档 → ok:false 不报错");
});

// 恢复全局（test() 注册后同步执行至此；用 process.onTestEnd 不可用时退化为立即还原前快照语义）
after(() => {
  if (__savedPiWebExt === undefined) delete globalThis.__piWebExt;
  else globalThis.__piWebExt = __savedPiWebExt;
  rmSync(testConfigDir, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});
