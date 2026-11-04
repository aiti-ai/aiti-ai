// 端点协议探测矫正 + provider 请求头（2026-09-17 方案）
//   - endpointApiHint / normalizeBaseForApi 纯函数
//   - detectApi：贴 /v1/messages 时优先 anthropic 且 baseUrl 去 /v1（opencode 场景）；无尾巴保持 rank；extraHeaders 透传
//   - upsertProviderData.maskedHeaders 原值回填 / 已存缺失丢弃 / 整体替换 / 清空
//   - providersStatus 打码头回显（敏感名掩码 + maskedHeaders 名单）
import { createRequire } from "module";
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { Tester } from "../../../pi-models-combo/test/util.mjs";

const require = createRequire(import.meta.url);
const wz = require("../core.cjs");
const { ok, finish } = Tester();

// ── ① endpointApiHint 全映射 ─────────────────────────────────────────────────
{
  const cases = [
    ["https://opencode.ai/zen/go/v1/messages", "anthropic-messages"],
    ["https://api.anthropic.com/v1/messages?x=1", "anthropic-messages"],
    ["https://x.com/v1/chat/completions", "openai-completions"],
    ["https://x.com/chat/completions/", "openai-completions"],
    ["https://x.com/v1/responses", "openai-responses"],
    ["https://x.com/v1beta/models", "google-generative-ai"],
    ["https://generativelanguage.googleapis.com/v1/models", "google-generative-ai"],
    ["https://x.com/v1/models", null], // 裸 /v1/models 协议歧义 → 不提示
    ["https://x.com/models", null],
    ["api.deepseek.com", null],
    ["", null],
  ];
  let bad = 0;
  for (const [u, expect] of cases) {
    const got = wz.endpointApiHint(u);
    if (got !== expect) { bad++; console.log("    ✗", u, "→", got, "期望", expect); }
  }
  ok("① endpointApiHint 全映射（含歧义 /v1/models 不提示）", bad === 0);
}

// ── ② normalizeBaseForApi ───────────────────────────────────────────────────
{
  ok("② anthropic 去尾部 /v1", wz.normalizeBaseForApi("https://opencode.ai/zen/go/v1", "anthropic-messages") === "https://opencode.ai/zen/go");
  ok("② anthropic 无 /v1 原样（尾斜杠剥净）", wz.normalizeBaseForApi("https://api.minimaxi.com/anthropic/", "anthropic-messages") === "https://api.minimaxi.com/anthropic");
  ok("② 非 anthropic 原样保留 /v1", wz.normalizeBaseForApi("https://opencode.ai/zen/go/v1", "openai-completions") === "https://opencode.ai/zen/go/v1");
  ok("② 仅剥连续尾斜杠一次", wz.normalizeBaseForApi("https://x.com/v1///", "anthropic-messages") === "https://x.com");
}

// ── ③ detectApi：stub fetch（opencode 场景 + hint + extraHeaders） ───────────
const realFetch = globalThis.fetch;
/** 模拟「/v1 下双协议网关」：openai/anthropic 端点仅在 /v1 下（401=存在需认证，/v1/models 200）。
 *  opt.openai=false 用于「hint 探不到时回退」用例。 */
function stubGateway(opt = {}) {
  const calls = [];
  const openai = opt.openai !== false;
  const anthropic = opt.anthropic !== false;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const pathname = (() => { try { return new URL(u).pathname; } catch { return u; } })();
    calls.push({ url: u, headers: init.headers || {} });
    const mk = (status, body = {}) => ({
      status, ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(body), headers: undefined,
    });
    if (openai && (pathname === "/v1/chat/completions" || pathname === "/v1/models")) return mk(pathname.endsWith("models") ? 200 : 401, { error: "unauthorized" });
    if (anthropic && pathname === "/v1/messages") return mk(401, { error: "unauthorized" });
    // 「路径不存在」：空 body（core 把 404+非空 body 也视为端点存在信号）
    return { status: 404, ok: false, text: async () => "", headers: undefined };
  };
  return calls;
}
{
  const calls = stubGateway();
  try {
    const r = await wz.detectApi("https://stub.local/v1/messages", "", { timeoutMs: 2000, extraHeaders: { "X-Test-Header": "1" } });
    ok("③ 贴 /v1/messages → anthropic", r.ok && r.api === "anthropic-messages", JSON.stringify({ api: r.api, base: r.baseUrl }));
    ok("③ baseUrl 归一化去 /v1（pi 运行时语义）", r.baseUrl === "https://stub.local", r.baseUrl);
    ok("③ rawBaseUrl 保留探到的原始 base", r.rawBaseUrl === "https://stub.local/v1", r.rawBaseUrl);
    const probe = calls.find((c) => c.url.endsWith("/v1/messages"));
    ok("③ extraHeaders 透传到探测请求", !!probe && probe.headers["X-Test-Header"] === "1");

    const r2 = await wz.detectApi("https://stub.local", "", { timeoutMs: 2000 });
    ok("③ 无端点尾巴 → 保持既有 rank（openai 优先）", r2.ok && r2.api === "openai-completions", JSON.stringify({ api: r2.api, base: r2.baseUrl }));
    ok("③ 无 hint 时 openai base 保留 /v1", r2.baseUrl === "https://stub.local/v1", r2.baseUrl);

    const r3 = await wz.detectApi("https://stub.local/v1/messages", "", { timeoutMs: 2000, apiHint: null });
    ok("③ apiHint:null 可显式关闭尾巴优先", r3.ok && r3.api === "openai-completions", r3.api);

    // /reverse 链路：reverseDetect 必须把 extraHeaders 转交给 detectApi（审核修正）
    calls.length = 0;
    const rv = await wz.reverseDetect([], "https://stub.local/v1/messages", "", { timeoutMs: 2000, extraHeaders: { "X-Rev-Header": "1" } });
    const revProbe = calls.find((c) => c.url.endsWith("/v1/messages"));
    ok("③ reverseDetect 透传 extraHeaders", !!rv.detect && rv.detect.ok && !!revProbe && revProbe.headers["X-Rev-Header"] === "1", JSON.stringify({ api: rv.detect && rv.detect.api }));
  } finally {
    globalThis.fetch = realFetch;
  }
}
{
  // hint=openai 但网关只有 anthropic → 不得凭空指定，回退 rank 命中 anthropic
  const calls = stubGateway({ openai: false });
  try {
    const r4 = await wz.detectApi("https://stub.local/v1/chat/completions", "", { timeoutMs: 2000 });
    ok("③ hint 探不到时回退实际命中（openai 尾巴但只有 anthropic）", r4.ok && r4.api === "anthropic-messages", JSON.stringify({ api: r4.api, calls: calls.length }));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── ④ upsertProviderData.maskedHeaders 语义 ────────────────────────────────
{
  const d1 = { providers: { p: { baseUrl: "x", api: "openai-completions", headers: { Authorization: "Bearer REAL", "User-Agent": "ua" } } } };
  wz.upsertProviderData(d1, { provider: "p", baseUrl: "x", api: "openai-completions", headers: { Authorization: "sk-***7890", "User-Agent": "ua2" }, maskedHeaders: ["Authorization"] });
  ok("④ 未动打码行 → 已存原值回填", d1.providers.p.headers.Authorization === "Bearer REAL" && d1.providers.p.headers["User-Agent"] === "ua2", JSON.stringify(d1.providers.p.headers));

  const d2 = { providers: { p: { baseUrl: "x", api: "openai-completions" } } };
  wz.upsertProviderData(d2, { provider: "p", baseUrl: "x", api: "openai-completions", headers: { Authorization: "sk-***7890" }, maskedHeaders: ["Authorization"] });
  ok("④ 打码行但已存缺失 → 丢弃（不写掩码假值）", d2.providers.p.headers === undefined);

  const d3 = { providers: { p: { baseUrl: "x", api: "openai-completions", headers: { Authorization: "Bearer REAL" } } } };
  wz.upsertProviderData(d3, { provider: "p", baseUrl: "x", api: "openai-completions", headers: { Authorization: "sk-NEWREAL" }, maskedHeaders: [] });
  ok("④ 用户改了打码行 → 新值整体替换", d3.providers.p.headers.Authorization === "sk-NEWREAL");

  wz.upsertProviderData(d3, { provider: "p", baseUrl: "x", api: "openai-completions", headers: {} });
  ok("④ 空对象 → 删除全部头", d3.providers.p.headers === undefined);

  const d4 = { providers: { p: { baseUrl: "x", api: "openai-completions", headers: { "User-Agent": "ua" } } } };
  wz.upsertProviderData(d4, { provider: "p", baseUrl: "x", api: "openai-completions" });
  ok("④ headers undefined → 保留旧值", d4.providers.p.headers["User-Agent"] === "ua");
}

// ── ⑤ providersStatus 打码头回显 ───────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wizard-hdr-"));
  const modelsFile = path.join(dir, "models.json");
  fs.writeFileSync(modelsFile, JSON.stringify({
    providers: {
      gw: { baseUrl: "https://gw.example.com/v1", api: "openai-completions", apiKey: "sk-abcdefghij", headers: { Authorization: "Bearer SECRETVALUE", "User-Agent": "my-agent/1.0" } },
    },
  }));
  const st = wz.providersStatus(dir, { modelsPath: modelsFile, catalog: { autoRefresh: false } });
  const p = st.providers.find((x) => x.provider === "gw");
  ok("⑤ 敏感头值打码", p && p.headers && p.headers.Authorization === wz.maskHeaderValue("Bearer SECRETVALUE") && p.headers.Authorization !== "Bearer SECRETVALUE", JSON.stringify(p && p.headers));
  ok("⑤ 非敏感头明文回显", p && p.headers["User-Agent"] === "my-agent/1.0");
  ok("⑤ maskedHeaders 只列敏感名", Array.isArray(p && p.maskedHeaders) && p.maskedHeaders.length === 1 && p.maskedHeaders[0] === "Authorization", JSON.stringify(p && p.maskedHeaders));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑥ 审核补测：preferBase × apiHint 选择分支 ───────────────────────────────
{
  globalThis.fetch = async (url) => {
    const p = (() => { try { return new URL(String(url)).pathname; } catch { return String(url); } })();
    const mk = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body), headers: undefined });
    const nf = { status: 404, ok: false, text: async () => "", headers: undefined };
    if (p === "/api/coding/v1/messages") return mk(401, { error: "unauthorized" }); // bare 变体 anthropic 存活
    if (p === "/api/coding/v3/chat/completions") return mk(401, { error: "unauthorized" }); // v3 变体 openai 存活
    return nf;
  };
  try {
    const rb = await wz.detectApi("https://stub.local/api/coding", "", { timeoutMs: 2000, preferBase: "https://stub.local/api/coding", apiHint: "anthropic-messages" });
    ok("⑥ preferBase 命中的 base 内取 hint 协议", rb.ok && rb.api === "anthropic-messages" && rb.baseUrl === "https://stub.local/api/coding", JSON.stringify({ api: rb.api, base: rb.baseUrl }));
    const rv3 = await wz.detectApi("https://stub.local/api/coding", "", { timeoutMs: 2000, preferBase: "https://stub.local/api/coding/v3", apiHint: "anthropic-messages" });
    ok("⑥ preferBase 变体优先（hint 不跨 base 变体抢）", rv3.ok && rv3.api === "openai-completions" && rv3.baseUrl === "https://stub.local/api/coding/v3", JSON.stringify({ api: rv3.api, base: rv3.baseUrl }));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── ⑦ 审核修正：headersFrom（改名继承/掩码回填） ──────────────────────────
{
  const d1 = { providers: { oldname: { baseUrl: "x", api: "openai-completions", headers: { Authorization: "Bearer REAL" } } } };
  wz.upsertProviderData(d1, { provider: "newname", baseUrl: "x", api: "openai-completions", headers: { Authorization: "sk-***7890" }, maskedHeaders: ["Authorization"], headersFrom: d1.providers.oldname.headers });
  ok("⑦ 改名 + 打码头 → 从旧 provider 原值回填", d1.providers.newname.headers.Authorization === "Bearer REAL", JSON.stringify(d1.providers.newname.headers));

  const d2 = { providers: { oldname: { baseUrl: "x", api: "openai-completions", headers: { "User-Agent": "ua/1.0" } } } };
  wz.upsertProviderData(d2, { provider: "newname", baseUrl: "x", api: "openai-completions", headersFrom: d2.providers.oldname.headers });
  ok("⑦ 改名未动头 → 继承旧 provider 的 headers", d2.providers.newname.headers["User-Agent"] === "ua/1.0", JSON.stringify(d2.providers.newname.headers));

  const d3 = { providers: { oldname: { baseUrl: "x", api: "openai-completions", headers: { "User-Agent": "ua/1.0" } } } };
  wz.upsertProviderData(d3, { provider: "newname", baseUrl: "x", api: "openai-completions", headers: {}, headersFrom: d3.providers.oldname.headers });
  ok("⑦ 改名 + 显式清空 → 不继承", d3.providers.newname.headers === undefined);

  const d4 = { providers: { p: { baseUrl: "x", api: "openai-completions", headers: { Auth: "Bearer REAL" } } } };
  wz.upsertProviderData(d4, { provider: "p", baseUrl: "x", api: "openai-completions", headers: {}, maskedHeaders: ["Auth"], headersFrom: d4.providers.p.headers });
  ok("⑦ 掩码名未随草稿发送也回填（防客户端过滤）", d4.providers.p.headers.Auth === "Bearer REAL", JSON.stringify(d4.providers.p.headers));
}

// ── ⑧ 审核修正：内置头大小写不敏感 + 用户显式值优先 ────────────────────────
{
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    return { status: 200, ok: true, text: async () => "{}", headers: undefined };
  };
  try {
    await wz.httpGet("https://opencode.ai/zen/v1/models", { apiKey: "k", extraHeaders: { Authorization: "Custom A", "X-Opencode-Session": "mine" } });
    const h = calls[0].headers;
    const authKeys = Object.keys(h).filter((k) => k.toLowerCase() === "authorization");
    ok("⑧ 内置 authorization 不重复且用户值优先", authKeys.length === 1 && h.Authorization === "Custom A", JSON.stringify(h));
    ok("⑧ x-opencode-session 用户显式值不被学习器覆盖", h["X-Opencode-Session"] === "mine", JSON.stringify(h));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── ⑤ G3 保存闸门：upsertProviderData enabled:false 语义（docs/aiti-model-wizard-uiue-gap-plan.md P0-A） ──
// ── ⑤ G3 保存闸门：upsertProviderData enabled:false 语义（docs/aiti-model-wizard-uiue-gap-plan.md P0-A） ──
{
  const d1 = { providers: {} };
  // 首存（正常保存，无 enabled 字段）→ 无 enabled 键
  wz.upsertProviderData(d1, { provider: "p", baseUrl: "https://x", api: "openai-completions", models: [{ id: "m1" }] });
  ok("G3 普通保存不写 enabled", d1.providers.p.enabled === undefined);
  // 测试失败仍要保存 → enabled:false
  wz.upsertProviderData(d1, { provider: "p", baseUrl: "https://x", api: "openai-completions", models: [{ id: "m1" }], enabled: false });
  ok("G3 显式 enabled:false 落禁用态", d1.providers.p.enabled === false);
  // 后续普通保存（不带 enabled）→ 保持禁用（不隐式启用）
  wz.upsertProviderData(d1, { provider: "p", baseUrl: "https://x2", api: "openai-completions", models: [{ id: "m1" }] });
  ok("G3 后续保存保持禁用且其余字段正常更新", d1.providers.p.enabled === false && d1.providers.p.baseUrl === "https://x2");
  // 其它 provider 不受影响
  wz.upsertProviderData(d1, { provider: "q", baseUrl: "https://y", api: "openai-completions", models: [{ id: "m1" }] });
  ok("G3 其它 provider 不受影响", d1.providers.q.enabled === undefined);
}

finish("wizard detect-hint");
