/**
 * aiti-models-import · 纯逻辑测试（标记/指纹/状态机/冲突 + 三来源适配器 fixture）
 *
 * Run: node --test pi-web-ext/aiti-models-import/core.test.mjs
 * 适配器 fixture 用临时目录模拟家目录（~/.codex、~/.zcode、~/.config/opencode…），io 全注入。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("./core.cjs");
const codex = require("./sources/codex.cjs");
const zcode = require("./sources/zcode.cjs");
const opencode = require("./sources/opencode.cjs");
const { listSources } = require("./sources/registry.cjs");

const tmpRoot = mkdtempSync(join(tmpdir(), "aiti-models-import-test-"));
test.after(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

// ---------------- 标记 ----------------

test("marker: 默认标记=首启,写读回环,dismiss/completed 消除首启", () => {
  const dir = join(tmpRoot, "m1");
  let m = core.readMarker(dir);
  assert.equal(core.isFirstRun(m), true);
  m.dismissedAt = 123;
  core.writeMarker(dir, m);
  m = core.readMarker(dir);
  assert.equal(core.isFirstRun(m), false);
  assert.equal(m.dismissedAt, 123);
  // 0600 权限（Linux）
  if (process.platform !== "win32") {
    const mode = statSync(core.markerPath(dir)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  // 损坏文件回退默认
  mkdirSync(dir, { recursive: true });
  writeFileSync(core.markerPath(dir), "{broken");
  assert.equal(core.isFirstRun(core.readMarker(dir)), true);
});

// ---------------- 指纹 ----------------

test("fingerprint: 同内容稳定;配置变化变;key 明文变化不变但 hasKey 变化变;快照剔除 apiKey", () => {
  const d1 = { key: "a", baseUrl: "https://x", api: "openai-completions", apiKey: "sk-secret-1", models: [{ id: "m1" }] };
  const d2 = { key: "a", baseUrl: "https://x", api: "openai-completions", apiKey: "sk-secret-2", models: [{ id: "m1" }] };
  assert.equal(core.sourceFingerprint([d1]), core.sourceFingerprint([d2]));
  assert.notEqual(core.sourceFingerprint([d1]), core.sourceFingerprint([{ ...d1, apiKey: null }]));
  assert.notEqual(core.sourceFingerprint([d1]), core.sourceFingerprint([{ ...d1, baseUrl: "https://y" }]));
  // 顺序无关
  const a = { key: "a", baseUrl: "https://x", api: "openai-completions", models: [] };
  const b = { key: "b", baseUrl: "https://x", api: "openai-completions", models: [] };
  assert.equal(core.sourceFingerprint([a, b]), core.sourceFingerprint([b, a]));
  const snap = core.snapshotDraft(d1);
  assert.equal(snap.apiKey, undefined);
  assert.equal(snap.baseUrl, "https://x");
});

// ---------------- 状态机 ----------------

test("state: available-new/changed/unchanged/source-gone 四态", () => {
  assert.equal(core.sourceState({ available: true, record: null, fingerprint: "f1" }), "available-new");
  assert.equal(core.sourceState({ available: true, record: { fingerprint: "f1" }, fingerprint: "f1" }), "unchanged");
  assert.equal(core.sourceState({ available: true, record: { fingerprint: "f1" }, fingerprint: "f2" }), "changed");
  assert.equal(core.sourceState({ available: false, record: { fingerprint: "f1" }, fingerprint: "f1" }), "source-gone");
  assert.equal(core.sourceState({ available: false, record: null, fingerprint: "f1" }), null);
});

// ---------------- 冲突检测 ----------------

test("conflicts: none/merge/override 判定", () => {
  const drafts = [
    { key: "p-new", baseUrl: "https://n", api: "openai-completions" },
    { key: "p-same", baseUrl: "https://s", api: "openai-completions" },
    { key: "p-move", baseUrl: "https://new", api: "openai-completions" },
  ];
  const providers = {
    "p-same": { baseUrl: "https://s/", api: "openai-completions" }, // 尾 / 归一后一致 → merge
    "p-move": { baseUrl: "https://old", api: "anthropic-messages" }, // baseUrl+api 都不同 → override
  };
  const m = core.detectConflicts(drafts, providers);
  assert.equal(m.get("p-new").conflict, "none");
  assert.equal(m.get("p-same").conflict, "merge");
  const mv = m.get("p-move");
  assert.equal(mv.conflict, "override");
  assert.deepEqual(mv.overrideFields, ["baseUrl", "api"]);
});

// ---------------- 模型预览元数据（只展示，不进导入） ----------------

test("modelMeta: 白名单清洗/不进指纹/不进快照/不改 models 载荷", () => {
  const d = core.normalizeDraft({
    key: "p", baseUrl: "https://x", api: "openai-completions",
    models: [{ id: "m1" }, { id: "m2" }],
    modelMeta: {
      m1: { name: "Em One", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"], headers: { evil: 1 }, compat: { sneaky: true } },
      m2: { contextWindow: "1M", maxTokens: -5 },
      m3: {},
    },
  });
  assert.deepEqual(d.modelMeta.m1, { name: "Em One", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"] });
  assert.equal(d.modelMeta.m2, undefined, "错类型/非正数的元数据整条剔除");
  assert.equal(d.modelMeta.m3, undefined, "空元数据不进表");
  // 导入载荷不变：models 只有 id（预览数据不得顺带写进 models.json）
  assert.deepEqual(d.models.map((m) => m.id), ["m1", "m2"]);
  assert.ok(d.models.every((m) => m.name === undefined && m.contextWindow === undefined && m.maxTokens === undefined));
  // 指纹无关：预览内容变了 ≠ 源配置变了（不该翻成「有更新」）
  const bare = core.normalizeDraft({ key: "p", baseUrl: "https://x", api: "openai-completions", models: [{ id: "m1" }, { id: "m2" }] });
  assert.equal(core.sourceFingerprint([d]), core.sourceFingerprint([bare]));
  assert.equal(core.snapshotDraft(d).modelMeta, undefined, "标记快照不落预览数据");
  // pickModelMeta：源条目形态（limit + reasoning 两种写法 + modalities）
  assert.deepEqual(core.pickModelMeta({ limit: { context: 200000, output: 32000 }, reasoning: { enabled: false }, modalities: { input: ["text"] } }),
    { contextWindow: 200000, maxTokens: 32000, reasoning: false, input: ["text"] });
  assert.deepEqual(core.pickModelMeta({ reasoning: true }), { reasoning: true });
  assert.equal(core.pickModelMeta(undefined), null);
});

test("knownModelIds: 字符串/对象条目混排 + 缺失 provider 返回空", () => {
  const providers = { a: { models: ["m1", { id: "m2" }, { model: "m3" }, null, {}] }, b: {} };
  assert.deepEqual(core.knownModelIds(providers, "a"), ["m1", "m2", "m3"]);
  assert.deepEqual(core.knownModelIds(providers, "b"), []);
  assert.deepEqual(core.knownModelIds(providers, "missing"), []);
  assert.deepEqual(core.knownModelIds(null, "a"), []);
});

// ---------------- 适配器公共 ----------------

function makeIo(home, files) {
  return {
    home,
    exists: (p) => !!files[p],
    readText: (p) => (files[p] ?? null),
  };
}

test("registry: 注册表包含 3 个可导入源 + cursor/qoder 灰显声明", () => {
  const all = listSources();
  const importable = all.filter((s) => s.kind === "importable").map((s) => s.id);
  assert.deepEqual(importable.sort(), ["codex", "opencode", "zcode"]);
  for (const id of ["cursor", "qoder"]) {
    const s = all.find((x) => x.id === id);
    assert.ok(s && s.kind === "not-importable" && s.reason, id + " 须带原因说明");
  }
});

// ---------------- codex ----------------

const CODEX_TOML = `# codex 配置 fixture
model = "gpt-5.1-codex"
model_provider = "openrouter"

[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1/"
wire_api = "chat"
`;

test("codex scan: model_providers → 草稿(active 默认模型/wire_api 映射/env_key);无 base_url 跳过", () => {
  const home = join(tmpRoot, "codex-home");
  const cfgPath = join(home, ".codex", "config.toml");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(cfgPath, CODEX_TOML);
  const io = makeIo(home, { [cfgPath]: CODEX_TOML });

  const r = codex.scan(io);
  assert.equal(r.available, true);
  const drafts = r.drafts;
  assert.equal(drafts.length, 2);

  const openai = drafts.find((d) => d.key === "codex-openai");
  assert.equal(openai.api, "openai-responses"); // wire_api=responses
  assert.equal(openai.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(openai.baseUrl, "https://api.openai.com/v1");
  assert.equal(openai.models.length, 0); // 非 active provider

  const or = drafts.find((d) => d.key === "codex-openrouter");
  assert.equal(or.api, "openai-completions"); // wire_api=chat
  assert.deepEqual(or.models.map((m) => m.id), ["gpt-5.1-codex"]); // active provider 挂默认模型
  assert.equal(or.baseUrl, "https://openrouter.ai/api/v1"); // 尾 / 剥除
  assert.ok(or.warnings.some((w) => w.includes("env_key") || w.includes("补 key")));
  assert.ok(r.notes.some((n) => n.includes("auth.json")));
});

test("codex scan: 未安装/坏 TOML/仅官方(无 model_providers) 三种降级", () => {
  const empty = codex.scan(makeIo(join(tmpRoot, "codex-none"), {}));
  assert.equal(empty.available, false);
  assert.match(empty.reason, /未安装/);

  const home2 = join(tmpRoot, "codex-bad");
  const bad = join(home2, ".codex", "config.toml");
  const io2 = makeIo(home2, { [bad]: "model = [broken" });
  const r2 = codex.scan(io2);
  assert.equal(r2.available, false);
  assert.match(r2.reason, /解析失败/);

  const home3 = join(tmpRoot, "codex-official");
  const ok3 = join(home3, ".codex", "config.toml");
  const toml3 = 'model = "gpt-5.1"\n';
  const r3 = codex.scan(makeIo(home3, { [ok3]: toml3 }));
  assert.equal(r3.available, true);
  assert.equal(r3.drafts.length, 0);
  assert.ok(r3.notes.some((n) => n.includes("无可导入")));
});

// ---------------- zcode ----------------

test("zcode scan: provider 通道 → 草稿(anthropic-messages/baseURL 双位置/models keys);key 不导入带警告", () => {
  const home = join(tmpRoot, "zcode-home");
  const p = join(home, ".zcode", "v2", "config.json");
  const json = JSON.stringify({
    provider: {
      bigmodel: {
        name: "智谱", baseURL: "https://open.bigmodel.cn/api/anthropic",
        models: {
          "GLM-5.3": { limit: { context: 1000000, output: 128000 }, reasoning: { enabled: true, variants: ["low", "max"] }, modalities: { input: ["text"], output: ["text"] } },
          "GLM-5.2": {},
        },
      },
      weird: { options: { baseURL: "https://x.example/api" } },
      nohost: { name: "缺地址" },
    },
  });
  const r = zcode.scan(makeIo(home, { [p]: json }));
  assert.equal(r.available, true);
  assert.equal(r.drafts.length, 2);
  const bm = r.drafts.find((d) => d.key === "zcode-bigmodel");
  assert.equal(bm.api, "anthropic-messages");
  assert.equal(bm.baseUrl, "https://open.bigmodel.cn/api/anthropic");
  assert.deepEqual(bm.models.map((m) => m.id), ["GLM-5.3", "GLM-5.2"]);
  // 预览元数据：源里的 limit/reasoning/modalities 读出来给弹窗看，models 导入载荷不变（仍只有 id）
  assert.deepEqual(bm.modelMeta["GLM-5.3"], { contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text"] });
  assert.equal(bm.modelMeta["GLM-5.2"], undefined);
  assert.ok(bm.models.every((m) => m.contextWindow === undefined && m.maxTokens === undefined), "预览元数据未混进导入载荷");
  assert.equal(bm.apiKey, null);
  assert.ok(bm.warnings.some((w) => w.includes("加密")));
  const weird = r.drafts.find((d) => d.key === "zcode-weird");
  assert.equal(weird.baseUrl, "https://x.example/api");
  assert.ok(r.notes.some((n) => n.includes("nohost")));

  const none = zcode.scan(makeIo(join(tmpRoot, "zcode-none"), {}));
  assert.equal(none.available, false);
});

test("zcode scan: start-plan 彻底排除 + 套餐缓存 family 授权过滤（镜像 zcode 扩展语义）", () => {
  const home = join(tmpRoot, "zcode-plan-home");
  const p = join(home, ".zcode", "v2", "config.json");
  const plan = join(home, ".zcode", "v2", "coding-plan-cache.json");
  const json = JSON.stringify({
    provider: {
      bigmodel: { baseURL: "https://open.bigmodel.cn/api/anthropic", models: { G: {} } },
      "builtin:bigmodel-coding-plan": { baseURL: "https://open.bigmodel.cn/api/anthropic", models: { GC: {} } },
      "builtin:zai-coding-plan": { baseURL: "https://api.z.ai/api/anthropic", models: { ZC: {} } },
      "builtin:zai-start-plan": { baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic", models: { ZS: {} } },
    },
  });
  const planJson = JSON.stringify({ entryStatus: { items: { "builtin:bigmodel-coding-plan": { status: "available" } } } });
  const r = zcode.scan(makeIo(home, { [p]: json, [plan]: planJson }));
  const keys = r.drafts.map((d) => d.key);
  // 通道键剥 builtin: 前缀（readProviderRegistry 同款）；bigmodel family 有授权 → 基础通道 + coding-plan 保留
  assert.ok(keys.includes("zcode-bigmodel") && keys.includes("zcode-bigmodel-coding-plan"));
  // zai family 无授权 → 跳过；start-plan 彻底排除（桌面验证码通道）
  assert.ok(!keys.includes("zcode-zai-coding-plan"));
  assert.ok(!keys.includes("zcode-zai-start-plan"));
  assert.ok(r.notes.some((n) => n.includes("start-plan")));
  assert.ok(r.notes.some((n) => n.includes("无有效套餐授权")));
  // 无套餐缓存 → 不过滤授权（回退全保留，仅排除 start-plan）
  const r2 = zcode.scan(makeIo(home, { [p]: json }));
  const keys2 = r2.drafts.map((d) => d.key);
  assert.ok(keys2.includes("zcode-zai-coding-plan"));
  assert.ok(!keys2.includes("zcode-zai-start-plan"));
});

// ---------------- opencode ----------------

test("opencode scan: npm 协议映射/options.apiKey 与 auth.json 兜底/空 models 警告", () => {
  const home = join(tmpRoot, "oc-home");
  const cfg = join(home, ".config", "opencode", "opencode.json");
  const auth = join(home, ".local", "share", "opencode", "auth.json");
  const cfgJson = JSON.stringify({
    provider: {
      anthropic: { npm: "@ai-sdk/anthropic", options: { baseURL: "https://api.anthropic.com", apiKey: "sk-ant-abcd1234" }, models: { "claude-sonnet-4": { name: "Claude Sonnet", limit: { context: 200000, output: 64000 }, modalities: { input: ["text", "image"] }, reasoning: true } } },
      relay: { npm: "@ai-sdk/some-unknown", options: { baseURL: "https://relay.example/v1" } },
    },
  });
  const authJson = JSON.stringify({ relay: { type: "api", key: "sk-relay-xyz9" } });
  const r = opencode.scan(makeIo(home, { [cfg]: cfgJson, [auth]: authJson }));
  assert.equal(r.available, true);
  assert.equal(r.drafts.length, 2);

  const ant = r.drafts.find((d) => d.key === "opencode-anthropic");
  assert.equal(ant.api, "anthropic-messages");
  assert.equal(ant.apiKey, "sk-ant-abcd1234");
  assert.deepEqual(ant.models.map((m) => m.id), ["claude-sonnet-4"]);
  assert.deepEqual(ant.modelMeta["claude-sonnet-4"], { name: "Claude Sonnet", contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text", "image"] });
  assert.deepEqual(ant.models.map((m) => [m.id, m.name]), [["claude-sonnet-4", "Claude Sonnet"]]); // 导入载荷仍是 {id,name}
  assert.equal(ant.models[0].contextWindow, undefined);

  const relay = r.drafts.find((d) => d.key === "opencode-relay");
  assert.equal(relay.api, "openai-completions"); // 未知 npm 兜底
  assert.equal(relay.apiKey, "sk-relay-xyz9"); // auth.json 兜底
  assert.ok(relay.warnings.some((w) => w.includes("未识别")));
  assert.ok(relay.warnings.some((w) => w.includes("模型清单")));

  const none = opencode.scan(makeIo(join(tmpRoot, "oc-none"), {}));
  assert.equal(none.available, false);
  assert.match(none.reason, /未安装/);
});

// ---------------- 源级指纹端到端（适配器 → 状态机） ----------------

test("端到端: codex 配置变更 → 指纹变化 → changed 状态", () => {
  const home = join(tmpRoot, "codex-e2e");
  const p = join(home, ".codex", "config.toml");
  const t1 = CODEX_TOML;
  const t2 = CODEX_TOML.replace("https://openrouter.ai/api/v1/", "https://openrouter.ai/api/v2/");
  mkdirSync(join(home, ".codex"), { recursive: true });
  const fp1 = core.sourceFingerprint(codex.scan(makeIo(home, { [p]: t1 })).drafts);
  const fp2 = core.sourceFingerprint(codex.scan(makeIo(home, { [p]: t2 })).drafts);
  assert.notEqual(fp1, fp2);
  assert.equal(core.sourceState({ available: true, record: { fingerprint: fp1 }, fingerprint: fp2 }), "changed");
  assert.ok(!existsSync(join(home, "import-state.json")));
});
