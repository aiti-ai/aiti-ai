/**
 * aiti-zcode-agent tests — wire contract (fake runtime stubs + pure functions), zero network, zero real credentials.
 *
 * Run: node --test pi-web-ext/aiti-zcode-agent/zcode-core.test.mjs
 * (node 24 native TS strip-types; imports .ts, same as ext-model-state.test.mjs)
 *
 * Stub mechanism:
 *   - runtime stub = node script that prints --json-shaped JSON or exits non-zero as the test requires;
 *   - fake AppImage = shell script that fakes squashfs-root/resources/glm/zcode.cjs on --appimage-extract;
 *   - credential chain = AITI_ZCODE_HOME pointed at a temp dir + injected fetchImpl;
 *   - feature = globalThis.__piWebExt.featureValue stub.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

// ---- environment isolation (set before importing the module under test) ----
const ROOT = mkdtempSync(join(tmpdir(), "zcode-agent-test-"));
process.env.EXT_MODEL_STATE_DIR = join(ROOT, "ext-model-state");
process.env.AITI_ZCODE_HOME = join(ROOT, "zcode-home");
mkdirSync(process.env.AITI_ZCODE_HOME, { recursive: true });

const core = await import("./zcode-core.ts");

/** Three-dir symmetry (2026-09-13): host-injected configDir = <extRoot>/config; tests give each case its own extRoot to isolate cache/state. */
function cfgOf(root) {
  const c = join(root, "config");
  mkdirSync(c, { recursive: true });
  return c;
}

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// ============================================================================
// Pure functions: --json parsing
// ============================================================================

test("parseTurnOutput: 2026-09-06 实测形态（单 pretty JSON）", () => {
  const raw = JSON.stringify({
    sessionId: "sess_55e2cd6c-5ecc-41eb-8660-0eb81cc7c122",
    traceId: "fe2a3e86",
    turnId: "turn_6ec8cb93",
    response: "当前目录是 `/home/pi`。",
    usage: { source: "provider", modelRequestCount: 2, inputTokens: 46634, outputTokens: 63, totalTokens: 46697, cacheReadTokens: 32768, cacheWriteTokens: 0, reasoningTokens: 0 },
    eventCount: 67,
    projection: { contextWindow: 1000000 },
  }, null, 2);
  const p = core.parseTurnOutput(raw);
  assert.ok(p);
  assert.equal(p.sessionId, "sess_55e2cd6c-5ecc-41eb-8660-0eb81cc7c122");
  assert.equal(p.response, "当前目录是 `/home/pi`。");
  assert.equal(p.usage.totalTokens, 46697);
  assert.equal(p.projection.contextWindow, 1000000);
});

test("parseTurnOutput: 前后噪声行容忍 / 块数组 response / 垃圾输出", () => {
  const noisy = '[warn] something\n{"sessionId":"sess_x","response":[{"type":"text","text":"ab"},{"type":"text","text":"cd"}]}\ntrailing';
  const p = core.parseTurnOutput(noisy);
  assert.equal(p?.sessionId, "sess_x");
  assert.equal(p?.response, "abcd");
  assert.equal(core.parseTurnOutput("not json at all"), null);
  assert.equal(core.parseTurnOutput(""), null);
});

test("usageToReport: camelCase 归一 + input 缺失时 total-output 兜底", () => {
  const r = core.usageToReport({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, totalTokens: 15 }, "bigmodel/GLM-5.3");
  assert.deepEqual(r, { provider: "zcode", model: "bigmodel/GLM-5.3", inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, totalTokens: 15 });
  const r2 = core.usageToReport({ outputTokens: 5, totalTokens: 15 });
  assert.equal(r2.inputTokens, 10);
  assert.equal(core.usageToReport(undefined), undefined);
});

test("extractCliError: responseBody JSON 优先 → Error: 行 → 尾行", () => {
  const stderr = [
    "AI_APICallError: 402",
    "  responseBody: '{\"error\":{\"message\":\"身份验证失败。\",\"type\":\"1000\"}}',",
    "  isRetryable: false,",
    "Error: Turn execution failed (traceId: abc)",
  ].join("\n");
  assert.match(core.extractCliError(stderr, "fb"), /身份验证失败/);
  assert.match(core.extractCliError("Error: boom\nError: last", "fb"), /last/);
  assert.match(core.extractCliError("plain line", "fb"), /plain line/);
  assert.equal(core.extractCliError("", "fallback-msg"), "fallback-msg");
});

// ============================================================================
// Pure functions: model ref / argv / env
// ============================================================================

test("parseModelRef + baseUrlFor: provider 表", () => {
  assert.deepEqual(core.parseModelRef("bigmodel/GLM-5.3"), { providerId: "bigmodel", modelId: "GLM-5.3" });
  assert.deepEqual(core.parseModelRef("zai/GLM-5.3-Flash"), { providerId: "zai", modelId: "GLM-5.3-Flash" });
  assert.equal(core.parseModelRef("GLM-5.3"), null);
  assert.equal(core.parseModelRef("unknown/m"), null);
  assert.equal(core.baseUrlFor("bigmodel"), "https://open.bigmodel.cn/api/anthropic");
  assert.equal(core.baseUrlFor("zai"), "https://api.z.ai/api/anthropic");
});

test("buildCliArgs: mode 白名单校验 + resume + attach", () => {
  const a = core.buildCliArgs({ mode: "build", prompt: "hi" });
  assert.deepEqual(a, ["--json", "--mode", "build", "--prompt", "hi"]);
  const b = core.buildCliArgs({ mode: "yolo-ish", sessId: "sess_x", prompt: "go", attachPaths: ["/tmp/a.png"] });
  // invalid mode falls back to build
  assert.deepEqual(b, ["--json", "--mode", "build", "--resume", "sess_x", "--attach", "/tmp/a.png", "--prompt", "go"]);
});

test("buildTurnEnv: env 注入通道（ZCODE_MODEL/BASE_URL/API_KEY/ENV/APP_VERSION）", () => {
  const env = core.buildTurnEnv({
    modelRef: "zai/GLM-5.3", providerId: "zai", apiKey: "k.s", appVersion: "3.11.2",
    passthroughEnv: { PATH: "/usr/bin", HOME: "/home/x" },
  });
  assert.equal(env.ZCODE_MODEL, "zai/GLM-5.3");
  assert.equal(env.ZCODE_BASE_URL, "https://api.z.ai/api/anthropic");
  assert.equal(env.ZCODE_API_KEY, "k.s");
  assert.equal(env.ZCODE_ENV, "production");
  assert.equal(env.ZCODE_APP_VERSION, "3.11.2");
  assert.equal(env.PATH, "/usr/bin");
});

test("buildTurnEnv: baseURL 参数覆盖 ZCODE_BASE_URL（app-server 平台根）", () => {
  const env = core.buildTurnEnv({
    modelRef: "bigmodel-coding-plan/GLM-5.3-Flash", providerId: "bigmodel", apiKey: "k.s",
    passthroughEnv: {},
    baseURL: core.ZCODE_PLATFORM_BASE_URL,
  });
  assert.equal(env.ZCODE_BASE_URL, "https://zcode.z.ai");
});

test("ZCODE_PLATFORM_BASE_URL: 平台根与 desktop 同款（引擎拉 configs/mapping 的根）", () => {
  assert.equal(core.ZCODE_PLATFORM_BASE_URL, "https://zcode.z.ai");
});

// ============================================================================
// provider runtime gate env (required for 3.17+ CLI startup; desktop injects the same, 2026-11-07)
// Reproduced on a real machine: without injection -> "cannot locate CLI ZCode Built-in Provider Config: .../glm/provider/..., /config/provider/..."
// ============================================================================

test("providerRuntimeEnv: 无 runtime / 文件皆缺 → 空注入（旧 CLI 行为不变）", () => {
  assert.deepEqual(core.providerRuntimeEnv(undefined), {});
  const env = core.providerRuntimeEnv(join(ROOT, "nope", "resources", "glm", "zcode.cjs"));
  assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, undefined);
  assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, undefined);
});

test("providerRuntimeEnv: runtime 同包 config 优先 + personal 落 zcodeHome/v2", () => {
  const rt = join(ROOT, "appimg", "resources", "glm", "zcode.cjs");
  const bundled = join(ROOT, "appimg", "resources", "config", "provider", "zcode-builtin.json");
  mkdirSync(dirname(bundled), { recursive: true });
  writeFileSync(bundled, "{}");
  const personal = join(process.env.AITI_ZCODE_HOME, "v2", "provider_config.json");
  mkdirSync(dirname(personal), { recursive: true });
  writeFileSync(personal, "{}");
  const env = core.providerRuntimeEnv(rt);
  assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, bundled);
  assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, personal);
  rmSync(join(ROOT, "appimg"), { recursive: true, force: true });
  rmSync(dirname(personal), { recursive: true, force: true });
});

test("providerRuntimeEnv: 无同包 → v2 runtime 刷新副本回退（精确版本 > 最高版本；<plat>-<arch> 目录式）", () => {
  const platDir = join(process.env.AITI_ZCODE_HOME, "v2", "runtime", "provider",
    `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}`);
  const mk = (ver) => {
    const f = join(platDir, ver, "endpoint-abc", "zcode-builtin.json");
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, "{}");
    return f;
  };
  mk("3.16.3");
  const v317 = mk("3.17.2");
  const rt = join(ROOT, "appimg2", "resources", "glm", "zcode.cjs"); // no bundled config present
  assert.equal(core.providerRuntimeEnv(rt, {}, "3.17.2").ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, v317);
  assert.equal(core.providerRuntimeEnv(rt).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, v317);
  rmSync(join(process.env.AITI_ZCODE_HOME, "v2", "runtime"), { recursive: true, force: true });
});

test("providerRuntimeEnv: passthrough 显式键不覆盖（spawn.env / memberEnv 可改）", () => {
  const env = core.providerRuntimeEnv(undefined, {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/x/builtin.json",
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/x/personal.json",
  });
  assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, undefined);
  assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, undefined);
});

test("buildTurnEnv: runtimeCjsPath 透传注入 provider 闸 env", () => {
  const rt = join(ROOT, "appimg3", "resources", "glm", "zcode.cjs");
  const bundled = join(ROOT, "appimg3", "resources", "config", "provider", "zcode-builtin.json");
  mkdirSync(dirname(bundled), { recursive: true });
  writeFileSync(bundled, "{}");
  const env = core.buildTurnEnv({
    modelRef: "zai/GLM-5.3", providerId: "zai", apiKey: "k.s",
    passthroughEnv: {}, runtimeCjsPath: rt,
  });
  assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, bundled);
  rmSync(join(ROOT, "appimg3"), { recursive: true, force: true });
});

// ============================================================================
// 3.17+ personal provider config (registry model registration; 2026-11-07 field-tested recipe)
// Missing any single required field -> the CLI silently recovers to an empty registry -> setModel reports "Model not found"
// ============================================================================

test("providerConfigDocument: 3.17+ 全必填形状（group/personalModelIds/enabled/properties/optionSpecs/providerModelRules）", () => {
  const doc = core.providerConfigDocument({
    providerId: "bigmodel", providerName: "BigModel",
    baseURL: "https://open.bigmodel.cn/api/anthropic", apiKey: "k.s",
    models: [{ modelId: "GLM-5.3-Flash", contextWindow: 1000000 }, { modelId: "GLM-5.3" }],
    defaultModelRef: "bigmodel/GLM-5.3-Flash",
  });
  const rule = doc.config.providerConfigRules.providerRules[0];
  assert.equal(rule.providerId, "bigmodel");
  assert.equal(rule.config.group, "standard-personal");                          // required at the registry layer (stricter than zod)
  assert.deepEqual(rule.config.personalModelIds, ["GLM-5.3-Flash", "GLM-5.3"]);  // model list source (builtinModelIds gets omitted)
  assert.equal(rule.config.access.type, "zhipu-coding-plan-api-key");
  assert.equal(rule.config.api.baseUrl, "https://open.bigmodel.cn/api/anthropic");
  const m0 = doc.config.modelConfigRules.manualProviderModelRules[0];
  assert.equal(m0.modelId, "GLM-5.3-Flash");
  assert.equal(m0.config.enabled, true);                                         // model executability gate (strict === true)
  assert.equal(m0.config.properties.contextWindow, 1000000);
  assert.ok(m0.config.properties.inputFormat.supportsImage);
  assert.deepEqual(doc.config.modelConfigRules.providerModelRules, []);          // key must be present (even as an empty array)
  assert.deepEqual(m0.config.optionSpecs.reasoningLevel.values, ["disabled", "enabled"]);
  assert.equal(m0.config.optionSpecs.reasoningLevel.map, "{}");
  assert.equal(m0.config.optionSpecs.maxOutputTokens.max, 128000);
  assert.deepEqual(doc.config.defaultModelSelection, { providerId: "bigmodel", modelId: "GLM-5.3-Flash" });
});

test("writeProviderConfigFile: 合并桌面 personal config（保留其它 provider）+ 0600 + 同 providerId 覆盖不重复", () => {
  const dir = join(ROOT, "cache-pc");
  const desktop = join(ROOT, "desktop-provider_config.json");
  writeFileSync(desktop, JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [{ providerId: "other", config: { group: "standard-personal" } }] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [{ providerId: "other", modelId: "m1", config: { enabled: true, properties: {}, optionSpecs: {} } }] },
    },
  }));
  const file = core.writeProviderConfigFile({
    cacheDir: dir, providerId: "bigmodel", baseURL: "https://x", apiKey: "sec",
    models: [{ modelId: "GLM-5.3-Flash", contextWindow: 1000000 }], defaultModelRef: "bigmodel/GLM-5.3-Flash",
    desktopPersonalPath: desktop,
  });
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600, "contains an apiKey, must be 0600 (POSIX mode-bit semantics; Windows has no 0600)");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const rules = doc.config.providerConfigRules.providerRules;
  assert.deepEqual(rules.map((r) => r.providerId).sort(), ["bigmodel", "other"]);
  const manual = doc.config.modelConfigRules.manualProviderModelRules;
  assert.deepEqual(manual.map((r) => `${r.providerId}/${r.modelId}`).sort(), ["bigmodel/GLM-5.3-Flash", "other/m1"]);
  assert.equal(doc.config.defaultModelSelection.modelId, "GLM-5.3-Flash");
  // rewrite with the same providerId: overwrite, no duplicate
  const file2 = core.writeProviderConfigFile({
    cacheDir: dir, providerId: "bigmodel", baseURL: "https://x2", apiKey: "sec2",
    models: [{ modelId: "GLM-5.3-Flash" }], desktopPersonalPath: desktop,
  });
  assert.equal(file2, file);
  const rules2 = JSON.parse(readFileSync(file, "utf8")).config.providerConfigRules.providerRules;
  assert.equal(rules2.filter((r) => r.providerId === "bigmodel").length, 1);
  assert.equal(rules2.find((r) => r.providerId === "bigmodel").config.api.baseUrl, "https://x2");
});

test("buildTurnEnv: personalProviderConfigFile 覆盖 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE（自建合并文件优先）", () => {
  const env = core.buildTurnEnv({
    modelRef: "zai/GLM-5.3", providerId: "zai", apiKey: "k.s",
    passthroughEnv: {}, personalProviderConfigFile: "/tmp/mine/provider_config.json",
  });
  assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "/tmp/mine/provider_config.json");
});

// ============================================================================
// Credential chain: decrypt -> key exchange -> cache (injected fetch, zero network)
// ============================================================================

function encryptForTest(plain, secret) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `enc:v1:${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}

test("decryptCredentials: fallback secret 公式 + enc:v1 往返", () => {
  const secret = core.deriveCredentialSecret({ platform: "linux", homedir: "/home/t", username: "t" });
  assert.equal(secret, "zcode-credential-fallback:linux:/home/t:t");
  const enc = encryptForTest("jwt-token-abc", secret);
  const plain = core.decryptCredentials({ "oauth:bigmodel:access_token": enc, "oauth:active_provider": "bigmodel" }, secret);
  assert.equal(plain["oauth:bigmodel:access_token"], "jwt-token-abc");
  assert.equal(plain["oauth:active_provider"], "bigmodel");
});

test("humanizeZcodeError: 1113 无权益 → 人话指引（保留原始）；其它原样透传", () => {
  const raw = "[1113][Insufficient balance or no resource package. Please recharge.][20260914074316cb99d1065b7f4176]";
  const out = core.humanizeZcodeError(raw);
  assert.match(out, /GLM Coding Plan/);
  assert.match(out, /zcode\.apiKeyOverride/);
  assert.ok(out.includes(raw), "keep the original error for troubleshooting");
  assert.equal(core.humanizeZcodeError("some other failure"), "some other failure");
});

test("pickDefault: isDefault → 名称含默认 → 第一个", () => {
  const orgs = [
    { organizationName: "B机构", organizationId: "org-b" },
    { organizationName: "默认机构(x)", organizationId: "org-x", projects: [] },
    { organizationName: "C机构", organizationId: "org-c" },
  ];
  assert.equal(core.pickDefault(orgs, "organizationName").organizationId, "org-x");
  orgs[1].isDefault = true;
  assert.equal(core.pickDefault(orgs, "organizationName").organizationId, "org-x");
  assert.equal(core.pickDefault([], "n"), undefined);
});

function bigmodelFetchStub(expectedToken) {
  const calls = [];
  return {
    calls,
    impl: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? "GET", auth: init.headers?.Authorization });
      const json = (obj) => new Response(JSON.stringify(obj), { status: 200 });
      if (url.includes("getCustomerInfo")) {
        assert.equal(init.headers.Authorization, expectedToken, "bigmodel getCustomerInfo uses the bare token without Bearer");
        return json({ code: 200, success: true, msg: "ok", data: { organizations: [{ organizationName: "默认机构(x)", organizationId: "org-1", isDefault: true, projects: [{ projectName: "默认项目", projectId: "proj-1", isDefault: true }] }] } });
      }
      if (url.endsWith("/api_keys") && (!init.method || init.method === "GET")) {
        return json({ code: 200, msg: "ok", data: [{ name: "cc", apiKey: "other-key" }] });
      }
      if (url.endsWith("/api_keys") && init.method === "POST") {
        return json({ code: 200, msg: "ok", data: { name: "zcode-api-key", apiKey: "0ab2a777" } });
      }
      if (url.includes("/api_keys/copy/")) {
        return json({ code: 200, msg: "ok", data: { secretKey: "ox00kdXX" } });
      }
      throw new Error("unexpected url " + url);
    },
  };
}

test("ensureCredential: bigmodel 全链路（解密→换key→缓存命中不再打API）", async () => {
  const home = join(ROOT, "cred-full");
  process.env.AITI_ZCODE_HOME = home;
  mkdirSync(join(home, "v2"), { recursive: true });
  const secret = core.deriveCredentialSecret();
  const credFile = join(home, "v2", "credentials.json");
  writeFileSync(credFile, JSON.stringify({ "oauth:bigmodel:access_token": encryptForTest("tok-1", secret), "oauth:active_provider": "bigmodel" }));
  const configDir = cfgOf(join(ROOT, "cred-data"));
  const stub = bigmodelFetchStub("tok-1");

  const r1 = await core.ensureCredential({ providerId: "bigmodel", configDir, fetchImpl: stub.impl });
  assert.equal(r1.apiKey, "0ab2a777.ox00kdXX");
  assert.equal(r1.source, "fresh");
  assert.equal(stub.calls.length, 4); // info + list + create + copy
  // idempotent cache: second call hits no API
  const r2 = await core.ensureCredential({ providerId: "bigmodel", configDir, fetchImpl: stub.impl });
  assert.equal(r2.source, "cache");
  assert.equal(stub.calls.length, 4);
  // disk cache file is 0600 and contains the key (POSIX permission semantics; NTFS has no POSIX bits, Windows skips this assert)
  const cacheFile = join(configDir, "zcode-api-key.json");
  assert.ok(existsSync(cacheFile));
  const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
  assert.equal(cache.apiKey, "0ab2a777.ox00kdXX");
  if (process.platform !== "win32") {
    const mode = (await import("node:fs")).statSync(cacheFile).mode & 0o777;
    assert.equal(mode, 0o600, "key cache must be 0600");
  }
  // fingerprint change (simulating desktop re-auth) -> exchange the key again
  core.resetCredentialCacheForTests();
  const stub2 = bigmodelFetchStub("tok-2");
  writeFileSync(credFile, JSON.stringify({ "oauth:bigmodel:access_token": encryptForTest("tok-2", secret) }));
  const r3 = await core.ensureCredential({ providerId: "bigmodel", configDir, fetchImpl: stub2.impl });
  assert.equal(r3.source, "fresh");
  assert.equal(stub2.calls[0].auth, "tok-2");
});

test("ensureCredential: 未登录 → 人话指引；override 直通", async () => {
  const home = join(ROOT, "cred-none");
  process.env.AITI_ZCODE_HOME = home;
  mkdirSync(join(home, "v2"), { recursive: true });
  writeFileSync(join(home, "v2", "credentials.json"), JSON.stringify({}));
  const configDir = cfgOf(join(ROOT, "cred-none-data"));
  await assert.rejects(
    () => core.ensureCredential({ providerId: "bigmodel", configDir, fetchImpl: async () => { throw new Error("should not fetch"); } }),
    (e) => /未登录|凭据/.test(e.message) && /apiKeyOverride/.test(e.message),
  );
  // channel mismatch (only a zai token present, bigmodel requested)
  const secret = core.deriveCredentialSecret();
  writeFileSync(join(home, "v2", "credentials.json"), JSON.stringify({ "oauth:zai:access_token": encryptForTest("ztok", secret) }));
  await assert.rejects(
    () => core.ensureCredential({ providerId: "bigmodel", configDir }),
    (e) => /不匹配/.test(e.message),
  );
  // override takes precedence and hits no API
  const r = await core.ensureCredential({ providerId: "bigmodel", configDir, override: "manual.key" });
  assert.deepEqual(r, { apiKey: "manual.key", providerId: "bigmodel", source: "override" });
});

test("ensureCredential: 桌面 config.json 现成通道 key 优先（不换 key、不打 API、不读凭据）", async () => {
  const home = join(ROOT, "cred-desktop");
  process.env.AITI_ZCODE_HOME = home;
  mkdirSync(join(home, "v2"), { recursive: true });
  // credentials file is empty (undecryptable too - irrelevant: the desktop key hits before decryption)
  writeFileSync(join(home, "v2", "credentials.json"), JSON.stringify({}));
  writeFileSync(join(home, "v2", "config.json"), JSON.stringify({
    provider: {
      "builtin:zai-coding-plan": { options: { apiKey: "0ab2a777.ox00kdXX" } },
      "builtin:zai": { options: { apiKey: "" } },
    },
  }));
  const configDir = cfgOf(join(ROOT, "cred-desktop-data"));
  core.resetCredentialCacheForTests();
  const r = await core.ensureCredential({
    providerId: "zai-coding-plan",
    configDir,
    fetchImpl: async () => { throw new Error("should not fetch"); },
  });
  assert.deepEqual(r, { apiKey: "0ab2a777.ox00kdXX", providerId: "zai-coding-plan", source: "desktop" });
  // same channel again = still the desktop key (reads config.json live, no disk cache)
  const r2 = await core.ensureCredential({ providerId: "zai-coding-plan", configDir });
  assert.equal(r2.source, "desktop");
  // other channel (no key in config.json) -> falls back to the original chain: empty credentials -> human-readable error
  await assert.rejects(
    () => core.ensureCredential({ providerId: "bigmodel", configDir, fetchImpl: async () => { throw new Error("should not fetch"); } }),
    (e) => /未登录|凭据/.test(e.message),
  );
});

// ============================================================================
// runtime: version parsing / download page parsing / extraction cache
// ============================================================================

test("parseAppImageVersion + compareVersions + pickLatestVersion", () => {
  assert.equal(core.parseAppImageVersion("/x/ZCode-3.11.2-linux-x64.AppImage"), "3.11.2");
  assert.equal(core.parseAppImageVersion("/x/no-version.AppImage"), null);
  assert.equal(core.compareVersions("3.10.1", "3.11.2"), -1);
  assert.equal(core.compareVersions("3.11.2", "3.11.2"), 0);
  assert.equal(core.pickLatestVersion(["3.10.1", "3.11.2", "3.9.9"]), "3.11.2");
});

test("extractReleaseUrls: 官网直链提取（真实连字符形态 + \\/ 转义 + 旧斜杠兼容 + 历史版本集合）", () => {
  const html = [
    '"https:\\/\\/cdn-zcode.z.ai\\/zcode\\/electron\\/releases\\/3.11.2\\/linux-x64\\/ZCode-3.11.2-linux-x64.AppImage"',
    '"https:\\/\\/cdn-zcode.z.ai\\/zcode\\/electron\\/releases\\/3.10.1\\/linux-x64\\/ZCode-3.10.1-linux-x64.AppImage"',
    '"https:\\/\\/cdn-zcode.z.ai\\/zcode\\/electron\\/releases\\/3.9.0\\/linux\\/x64\\/ZCode-3.9.0-linux-x64.AppImage"',
    '"https:\\/\\/cdn-zcode.z.ai\\/zcode\\/electron\\/releases\\/3.11.2\\/win\\/x64\\/ZCode-3.11.2-win-x64.exe"',
  ].join("\n");
  const urls = core.extractReleaseUrls(html);
  assert.equal(urls.length, 3, "only linux-x64 AppImage entries (incl. the legacy slash form)");
  assert.ok(urls.every((u) => u.url.startsWith("https://cdn-zcode.z.ai/")));
  assert.ok(urls.some((u) => u.ver === "3.11.2"));
});

test("resolveRuntime: feature 指定 zcode.cjs 直用；目录探测 resources/glm", async () => {
  const stub = join(ROOT, "stub.cjs");
  writeFileSync(stub, "console.log('{}')");
  const r1 = await core.resolveRuntime({ featurePath: stub, configDir: cfgOf(join(ROOT, "rt1")) });
  assert.equal(r1.cjsPath, stub);
  assert.equal(r1.origin, "feature");

  const dir = join(ROOT, "extracted");
  mkdirSync(join(dir, "resources", "glm"), { recursive: true });
  writeFileSync(join(dir, "resources", "glm", "zcode.cjs"), "// cli");
  const r2 = await core.resolveRuntime({ featurePath: dir, configDir: cfgOf(join(ROOT, "rt2")) });
  assert.equal(r2.cjsPath, join(dir, "resources", "glm", "zcode.cjs"));

  await assert.rejects(
    () => core.resolveRuntime({ featurePath: "/nonexistent/path", configDir: cfgOf(join(ROOT, "rt3")) }),
    /zcode\.runtimePath/,
  );
});

test("resolveRuntime: 假 AppImage → --appimage-extract → 缓存（pattern 提取 + 二次命中缓存）", { skip: process.platform === "win32" ? "AppImage 为 Linux 专属格式（Windows 走安装目录探测，无解压场景）" : false }, async () => {
  const home = join(ROOT, "rt-home");
  process.env.AITI_ZCODE_HOME = home;
  mkdirSync(home, { recursive: true });
  const configDir = cfgOf(join(ROOT, "rt-data"));
  const emptyMount = join(ROOT, "empty-mount");
  mkdirSync(emptyMount, { recursive: true });
  const fakeApp = join(home, "ZCode-4.0.0-linux-x64.AppImage");
  // fake AppImage: shell script mimicking the runtime's --appimage-extract behavior
  writeFileSync(fakeApp, `#!/bin/sh
mkdir -p "$PWD/squashfs-root/resources/glm"
printf '#!/usr/bin/env node\\nconsole.log("{}")\\n' > "$PWD/squashfs-root/resources/glm/zcode.cjs"
`);
  chmodSync(fakeApp, 0o755);

  const logs = [];
  const r1 = await core.resolveRuntime({ configDir, autoDownload: false, mountScanDir: emptyMount, winInstallDirs: [], log: (m) => logs.push(m) });
  assert.equal(r1.appVersion, "4.0.0");
  assert.equal(r1.origin, "appimage");
  assert.ok(existsSync(r1.cjsPath), "extracted zcode.cjs exists");
  // cache hit: still resolvable after deleting the fake AppImage (served from the cache dir)
  rmSync(fakeApp);
  const r2 = await core.resolveRuntime({ configDir, autoDownload: false, mountScanDir: emptyMount, winInstallDirs: [] });
  assert.equal(r2.cjsPath, r1.cjsPath);
  assert.ok(r2.cjsPath.includes(join(dirname(configDir), "cache", "runtime", "ZCode-4.0.0")), "cache lives under extRoot/cache (three-dir symmetry)");
});

test("resolveRuntime: 全部落空 + autoDownload 关 → 人话报错", async () => {
  const home = join(ROOT, "rt-empty");
  process.env.AITI_ZCODE_HOME = home;
  mkdirSync(home, { recursive: true });
  const emptyMount = join(ROOT, "empty-mount-2");
  mkdirSync(emptyMount, { recursive: true });
  await assert.rejects(
    () => core.resolveRuntime({ configDir: cfgOf(join(ROOT, "rt-empty-data")), autoDownload: false, mountScanDir: emptyMount, winInstallDirs: [] }),
    (e) => /runtime/.test(e.message) && /autoDownload/.test(e.message),
  );
});

test("isReadableFile：存在文件 true / 不存在 false / 不可读(000) false", { skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0) ? "chmod 000 在 root/win 不可靠" : false }, async () => {
  const dir = join(ROOT, "rf");
  mkdirSync(dir, { recursive: true });
  const good = join(dir, "good.cjs");
  writeFileSync(good, "ok");
  assert.equal(core.isReadableFile(good), true);
  assert.equal(core.isReadableFile(join(dir, "nope.cjs")), false);
  const locked = join(dir, "locked.cjs");
  writeFileSync(locked, "x");
  chmodSync(locked, 0o000);
  assert.equal(core.isReadableFile(locked), false, "stat passes but open fails (same shape as a disconnected FUSE mount) must count as unreadable");
  chmodSync(locked, 0o644);
});

const CAN_LOCK = process.platform !== "win32" && (typeof process.getuid !== "function" || process.getuid() !== 0);

test("resolveRuntime：挂载残留（stat 通过/不可读）不劫持，可读挂载优先", { skip: CAN_LOCK ? false : "chmod 000 不可靠（root/win），跳过残留模拟" }, async () => {
  const mount = join(ROOT, "rt-mount-scan");
  const broken = join(mount, ".mount_ZCode-BROKEN", "resources", "glm");
  const good = join(mount, ".mount_ZCode-GOOD", "resources", "glm");
  mkdirSync(broken, { recursive: true });
  mkdirSync(good, { recursive: true });
  writeFileSync(join(good, "zcode.cjs"), "console.log('good')");
  const locked = join(broken, "zcode.cjs");
  writeFileSync(locked, "x");
  chmodSync(locked, 0o000); // simulates a disconnected mount: stat passes, open fails (ENOTCONN/EACCES)
  const configDir = cfgOf(join(ROOT, "rt-mount-data"));
  const r = await core.resolveRuntime({ configDir, autoDownload: false, mountScanDir: mount, winInstallDirs: [] });
  assert.equal(r.origin, "mount");
  assert.ok(r.cjsPath.includes(".mount_ZCode-GOOD"), `should skip unreadable leftovers and pick the readable mount, got ${r.cjsPath}`);
});

test("resolveRuntime：全部挂载残留（不可读）→ 跳过挂载层落到后续来源（无缓存/AppImage → 报错）", { skip: CAN_LOCK ? false : "chmod 000 不可靠（root/win），跳过残留模拟" }, async () => {
  const mount2 = join(ROOT, "rt-mount-scan2");
  mkdirSync(join(mount2, ".mount_ZCode-BROKEN", "resources", "glm"), { recursive: true });
  const l2 = join(mount2, ".mount_ZCode-BROKEN", "resources", "glm", "zcode.cjs");
  writeFileSync(l2, "x");
  chmodSync(l2, 0o000);
  await assert.rejects(
    () => core.resolveRuntime({ configDir: cfgOf(join(ROOT, "rt-mount-data2")), autoDownload: false, mountScanDir: mount2, winInstallDirs: [] }),
    /runtime/,
  );
});

test("windowsInstallDirs: env 注入生成 Program Files / LOCALAPPDATA 路径集", () => {
  const dirs = core.windowsInstallDirs({
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local",
  });
  assert.deepEqual(dirs, [
    "C:\\Program Files\\ZCode",
    "C:\\Program Files (x86)\\ZCode",
    "C:\\Users\\t\\AppData\\Local\\ZCode",
    "C:\\Users\\t\\AppData\\Local\\Programs\\ZCode",
  ]);
  // missing env vars skip their corresponding entries
  assert.ok(!core.windowsInstallDirs({}).length);
});

test("resolveRuntime: Windows 安装探测（resources/glm/zcode.cjs，多目录取最高版本）", async () => {
  const winOld = join(ROOT, "win-old");
  const winNew = join(ROOT, "win-new");
  for (const [dir, ver] of [[winOld, "3.10.1"], [winNew, "3.11.2"]]) {
    mkdirSync(join(dir, "resources", "glm"), { recursive: true });
    writeFileSync(join(dir, "resources", "glm", "zcode.cjs"), "// cli");
    makeFakeAsar(dir, ver);
  }
  const r = await core.resolveRuntime({ configDir: cfgOf(join(ROOT, "rt-win")), autoDownload: false, winInstallDirs: [winOld, winNew] });
  assert.equal(r.origin, "install");
  assert.equal(r.cjsPath, join(winNew, "resources", "glm", "zcode.cjs"));
  assert.equal(r.appVersion, "3.11.2", "multi-dir hit picks the highest asar version");

  // no asar (or corrupted asar) -> cjs still usable, version undefined
  const winPlain = join(ROOT, "win-plain");
  mkdirSync(join(winPlain, "resources", "glm"), { recursive: true });
  writeFileSync(join(winPlain, "resources", "glm", "zcode.cjs"), "// cli");
  const rp = await core.resolveRuntime({ configDir: cfgOf(join(ROOT, "rt-win-plain")), autoDownload: false, winInstallDirs: [winPlain] });
  assert.equal(rp.origin, "install");
  assert.equal(rp.appVersion, undefined);
});

/** Build a new-format fake asar: 16B header + header JSON (offset as string, relative to the data region) + data region package.json. */
function makeFakeAsar(installDir, version) {
  const pkg = JSON.stringify({ name: "zcode", version });
  const header = JSON.stringify({ files: { "package.json": { size: pkg.length, offset: "0" } } });
  const headerSize = header.length;
  const size = headerSize + 8; // [u32 size][u32 size-4][u32 headerSize]
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(size, 4);
  head.writeUInt32LE(size - 4, 8);
  head.writeUInt32LE(headerSize, 12);
  writeFileSync(join(installDir, "resources", "app.asar"), Buffer.concat([head, Buffer.from(header), Buffer.from(pkg)]));
}

test("detectWindowsInstallVersion: 新/旧两种 asar 格式均能解析", () => {
  const dir = join(ROOT, "detect-ver");
  mkdirSync(join(dir, "resources"), { recursive: true });
  // new format (header at the front, offset as string)
  makeFakeAsar(dir, "5.2.1");
  assert.equal(core.detectWindowsInstallVersion(dir), "5.2.1");
  // old format (header at the tail: [data][u32 size][u32 headerSize][header JSON], offset as number)
  const pkg = JSON.stringify({ name: "zcode", version: "4.0.0" });
  const header = JSON.stringify({ files: { "package.json": { size: pkg.length, offset: 0 } } });
  const headerSize = header.length;
  const size = headerSize + 8;
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(size, 0);
  tail.writeUInt32LE(headerSize, 4);
  writeFileSync(join(dir, "resources", "app.asar"), Buffer.concat([Buffer.from(pkg), Buffer.from(header), tail]));
  assert.equal(core.detectWindowsInstallVersion(dir), "4.0.0");
  // dir without asar -> null
  const empty = join(ROOT, "detect-empty");
  mkdirSync(join(empty, "resources"), { recursive: true });
  assert.equal(core.detectWindowsInstallVersion(empty), null);
});

test("downloadAppimage: .part 原子落盘 + 小内容拒收（防半文件当缓存）", async () => {
  const { downloadAppimage } = core;
  const dest = join(ROOT, "dl", "ZCode-9.9.9-linux-x64.AppImage");
  // small content (<1MB) rejected with no .part left behind
  await assert.rejects(
    () => downloadAppimage("https://cdn.test/x", dest, async () => new Response("error page", { status: 200 })),
    /下载内容异常/,
  );
  assert.ok(!existsSync(dest), "final file must not be written");
  assert.ok(!existsSync(`${dest}.part`), "no .part leftover");
  // HTTP errors rejected
  await assert.rejects(
    () => downloadAppimage("https://cdn.test/x", dest, async () => new Response("no", { status: 404 })),
    /HTTP 404/,
  );
  // abort signal: external abort while fetch hangs -> rejects with no .part leftover
  const ac = new AbortController();
  const hung = new Promise((resolve) => { ac.signal.addEventListener("abort", () => resolve(new Response("late", { status: 200 }))); });
  const p = downloadAppimage("https://cdn.test/x", dest, async () => hung, () => {}, ac.signal);
  ac.abort();
  await assert.rejects(p);
  assert.ok(!existsSync(`${dest}.part`), "no .part leftover after abort");
});

test("detectPlanProvider: coding-plan-cache available 状态选通道 + 缺文件回落 null", () => {
  const home = join(ROOT, "plan-home");
  process.env.AITI_ZCODE_HOME = home;
  rmSync(join(home, "v2"), { recursive: true, force: true });
  assert.equal(core.detectPlanProvider(), null, "missing file -> null");
  mkdirSync(join(home, "v2"), { recursive: true });
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: {
      "builtin:zai-coding-plan": { status: "unavailable" },
      "builtin:bigmodel-coding-plan": { status: "available" },
    } },
  }));
  assert.equal(core.detectPlanProvider(), "bigmodel");
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: {
      "builtin:zai-coding-plan": { status: "available" },
    } },
  }));
  assert.equal(core.detectPlanProvider(), "zai");
  // only start-plan available (desktop trial plan): the family is still resolvable (falls back to same-family base/coding-plan, never start-plan itself)
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: {
      "builtin:zai-start-plan": { status: "available" },
      "builtin:bigmodel-coding-plan": { status: "unavailable" },
    } },
  }));
  assert.equal(core.detectPlanProvider(), "zai", "only zai-start-plan available -> family zai (a null return, as before, would fall back to bigmodel and seed out-of-catalog models)");
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: {
      "builtin:bigmodel-start-plan": { status: "available" },
      "builtin:zai-start-plan": { status: "unavailable" },
    } },
  }));
  assert.equal(core.detectPlanProvider(), "bigmodel", "only bigmodel-start-plan available -> family bigmodel");
});

test("动态目录: 注册表+套餐缓存（桌面端同款数据源）→ buildZcodeCatalogRefs/parseModelRef/baseUrlFor", () => {
  const home = join(ROOT, "dyn-home");
  const prevHome = process.env.AITI_ZCODE_HOME;
  process.env.AITI_ZCODE_HOME = home;
  rmSync(join(home, "v2"), { recursive: true, force: true });
  mkdirSync(join(home, "v2"), { recursive: true });
  writeFileSync(join(home, "v2", "config.json"), JSON.stringify({
    provider: {
      // real desktop structure: the endpoint lives in options.baseURL (field-tested on 48/155 machines, 2026-09-12);
      // the first entry keeps a top-level baseURL to cover the compat fallback branch.
      "builtin:bigmodel": { name: "Bigmodel - API Key", baseURL: "https://open.bigmodel.cn/api/anthropic", models: { "GLM-5.3": {}, "GLM-5.3-Flash": {} } },
      "builtin:bigmodel-coding-plan": { name: "BigModel - Coding Plan", options: { baseURL: "https://open.bigmodel.cn/api/anthropic" }, models: { "GLM-5.3": {}, "GLM-5.3-Flash": {} } },
      "builtin:bigmodel-start-plan": { name: "BigModel - Coding Plan", options: { baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" }, models: { "GLM-5.3-Flash": {} } },
      "builtin:zai-start-plan": { name: "Z.ai - Coding Plan", options: { baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" }, models: {} },
    },
  }));
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: {
      "builtin:bigmodel-start-plan": { status: "available" },
      "builtin:zai-start-plan": { status: "unavailable", reason: "coding_plan_not_entitled" },
      "builtin:bigmodel-coding-plan": { status: "available" },
    } },
  }));

  // registry parsing: builtin: prefix stripped + models key set exposed
  const reg = core.readProviderRegistry();
  const startEntry = reg.find((p) => p.channel === "bigmodel-start-plan");
  assert.equal(startEntry?.baseURL, "https://zcode.z.ai/api/v1/zcode-plan/anthropic");
  assert.deepEqual(reg.find((p) => p.channel === "zai-start-plan")?.models, []);
  assert.deepEqual(
    core.readPlanStatus().filter((x) => x.status === "available").map((x) => x.channel).sort(),
    ["bigmodel-coding-plan", "bigmodel-start-plan"],
  );

  // catalog (no longer excluded as of 2026-09-15): start-plan with desktop-verified available -> listed as usual, label carries a "not yet supported" hint;
  // not entitled (unavailable) or no registry models -> not listed (zai-start-plan's model table is empty -> no entry).
  const refs = core.buildZcodeCatalogRefs();
  assert.ok(refs.some((m) => m.id === "bigmodel-start-plan/GLM-5.3-Flash" && m.label.includes("desktop only")), "start-plan available -> listed as usual with the 'not yet supported' hint");
  assert.ok(!refs.some((m) => m.id.startsWith("zai-start-plan/")), "zai-start-plan not entitled / no models -> not listed");

  // no registry (headless legacy machines) -> fall back to the fixed wording
  core.resetZcodeCatalogCacheForTests();
  writeFileSync(join(home, "v2", "config.json"), JSON.stringify({ provider: {} }));
  core.resetZcodeCatalogCacheForTests();
  const fallbackRefs = core.buildZcodeCatalogRefs();
  assert.ok(fallbackRefs.some((m) => m.label.endsWith("(bigmodel)")), "registry missing -> seed channels, label still the raw channel id");
  core.resetZcodeCatalogCacheForTests();
  assert.ok(!refs.some((m) => m.id.startsWith("zai")), "family without entitlement (zai has no available plan) -> not shown");
  assert.ok(!refs.some((m) => m.id === "bigmodel/GLM-5-Turbo"), "registry is authoritative: channels present in the registry no longer merge retired seed tiers");
  // channels displayed independently (zero normalization): base / coding-plan each get entries, label = raw channel id (start-plan with the hint)
  assert.ok(refs.some((m) => m.id === "bigmodel/GLM-5.3" && m.label === "GLM-5.3 (bigmodel)"), "base channel: label = raw channel id");
  assert.ok(refs.some((m) => m.id === "bigmodel-coding-plan/GLM-5.3" && m.label === "GLM-5.3 (bigmodel-coding-plan)"), "coding-plan channel listed independently");
  const codingRef = refs.find((m) => m.id === "bigmodel/GLM-5.3");
  assert.ok(codingRef, "base channel includes registry models");
  assert.ok(new Set(refs.map((m) => m.id)).size === refs.length, "catalog has no duplicate refs");

  // seed fallback: when the registry lacks a channel's models, merge in the static seed (headless legacy machines)
  core.resetZcodeCatalogCacheForTests();
  writeFileSync(join(home, "v2", "config.json"), JSON.stringify({
    provider: { "builtin:bigmodel": { name: "Bigmodel - API Key", models: {} } },
  }));
  const refsSeed = core.buildZcodeCatalogRefs();
  assert.ok(refsSeed.some((m) => m.id === "bigmodel/GLM-5-Turbo"), "registry has no models -> static seed merged as fallback");

  // restore the full registry (for the ref-parsing/baseUrlFor asserts below)
  core.resetZcodeCatalogCacheForTests();
  writeFileSync(join(home, "v2", "config.json"), JSON.stringify({
    provider: {
      "builtin:bigmodel": { name: "Bigmodel - API Key", baseURL: "https://open.bigmodel.cn/api/anthropic", models: { "GLM-5.3": {}, "GLM-5.3-Flash": {} } },
      "builtin:bigmodel-coding-plan": { name: "BigModel - Coding Plan", options: { baseURL: "https://open.bigmodel.cn/api/anthropic" }, models: { "GLM-5.3": {}, "GLM-5.3-Flash": {} } },
      "builtin:bigmodel-start-plan": { name: "BigModel - Coding Plan", options: { baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" }, models: { "GLM-5.3-Flash": {} } },
      "builtin:zai-start-plan": { name: "Z.ai - Coding Plan", options: { baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" }, models: {} },
    },
  }));
  core.resetZcodeCatalogCacheForTests();

  // ref parsing: dynamic channels valid + unknown rejected; baseUrlFor prefers the registry
  assert.deepEqual(core.parseModelRef("bigmodel-start-plan/GLM-5.3-Flash"), { providerId: "bigmodel-start-plan", modelId: "GLM-5.3-Flash" });
  assert.equal(core.parseModelRef("unknown-ch/m"), null);
  assert.equal(core.baseUrlFor("bigmodel-start-plan"), "https://zcode.z.ai/api/v1/zcode-plan/anthropic");

  // default-channel family resolution: only start-plan available (no driveable channel) -> fall back to the family
  // (start-plan itself is never the default, but same-family base/coding-plan is driveable — fixed 2026-09-14; a null return used to fall back to bigmodel on zai-plan-only machines)
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: { "builtin:bigmodel-start-plan": { status: "available" } } },
  }));
  assert.equal(core.detectPlanProvider(), "bigmodel");
  rmSync(join(home, "v2"), { recursive: true, force: true });
  process.env.AITI_ZCODE_HOME = prevHome;
});

test("通道级可用收紧（2026-09-15）：套餐通道自身 unavailable → 不列目录/判不可驱动，家族连带不再放行", () => {
  const home = join(ROOT, "chlvl-home");
  const prevHome = process.env.AITI_ZCODE_HOME;
  process.env.AITI_ZCODE_HOME = home;
  rmSync(join(home, "v2"), { recursive: true, force: true });
  mkdirSync(join(home, "v2"), { recursive: true });
  writeFileSync(join(home, "v2", "config.json"), JSON.stringify({
    provider: {
      "builtin:zai": { name: "Z.ai", options: { baseURL: "https://api.z.ai/api/anthropic" }, models: { "GLM-5.3": {} } },
      "builtin:zai-coding-plan": { name: "Z.ai - Coding Plan", options: { baseURL: "https://api.z.ai/api/anthropic" }, models: { "GLM-5.3": {}, "GLM-5.3-Flash": {} } },
      "builtin:zai-start-plan": { name: "Z.ai - Start Plan", options: { baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" }, models: {} },
    },
  }));
  // real-machine 2026-09-15 shape: only start-plan available, coding-plan not_entitled (dead channel, 429/1113)
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: {
      "builtin:zai-start-plan": { status: "available" },
      "builtin:zai-coding-plan": { status: "unavailable", reason: "coding_plan_not_entitled" },
    } },
  }));
  core.resetZcodeCatalogCacheForTests();
  const refs = core.buildZcodeCatalogRefs();
  assert.ok(!refs.some((m) => m.id.startsWith("zai-coding-plan/")), "coding-plan channel itself unavailable -> not listed (family-level pass-through would seed a dead channel that 1113s the moment it is selected)");
  assert.ok(!refs.some((m) => m.id.startsWith("zai-start-plan/")), "start-plan registry has no models (empty models) -> no entry");
  assert.ok(refs.some((m) => m.id === "zai/GLM-5.3"), "base channel (absent from the plan cache) keeps the family gate: family has an available plan -> still listed");
  assert.equal(core.isChannelDriveable("zai-coding-plan"), false);
  assert.equal(core.isChannelDriveable("zai-start-plan"), false);
  assert.equal(core.isChannelDriveable("zai"), true);

  // control group: channel itself available -> listed as usual (the channel-level gate does not hit healthy channels)
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: {
      "builtin:zai-start-plan": { status: "available" },
      "builtin:zai-coding-plan": { status: "available" },
    } },
  }));
  core.resetZcodeCatalogCacheForTests();
  assert.ok(core.buildZcodeCatalogRefs().some((m) => m.id === "zai-coding-plan/GLM-5.3-Flash"), "channel itself available -> listed as usual");

  // plan cache missing (headless legacy machines) -> null, callers decide with the legacy family logic
  rmSync(join(home, "v2", "coding-plan-cache.json"));
  core.resetZcodeCatalogCacheForTests();
  assert.equal(core.isChannelDriveable("zai-coding-plan"), null);
  assert.equal(core.isChannelDriveable("zai"), null);

  // cache present but zero available in the family -> all undriveable (consistent with an empty catalog)
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: { "builtin:zai-coding-plan": { status: "unavailable", reason: "x" } } },
  }));
  core.resetZcodeCatalogCacheForTests();
  assert.equal(core.isChannelDriveable("zai-coding-plan"), false);
  assert.equal(core.isChannelDriveable("zai"), false, "base channel family gate: no available plan in the family -> false");

  rmSync(join(home, "v2"), { recursive: true, force: true });
  process.env.AITI_ZCODE_HOME = prevHome;
});

test("fetchCaptchaConfig：client/configs 三元组提取 + disabled/缺字段 → null", async () => {
  const okRes = { ok: true, json: async () => ({ data: { configs: { captcha: { enabled: true, prefix: "no8xfe", region: "cn", sceneId: "11xygtvd" } } } }) };
  assert.deepEqual(await core.fetchCaptchaConfig("jwt", async () => okRes), { sceneId: "11xygtvd", prefix: "no8xfe", region: "cn" });
  const disabled = { ok: true, json: async () => ({ data: { configs: { captcha: { enabled: false, prefix: "p", region: "cn", sceneId: "s" } } } }) };
  assert.equal(await core.fetchCaptchaConfig("jwt", async () => disabled), null, "enabled:false → null");
  const noScene = { ok: true, json: async () => ({ data: { configs: { captcha: { enabled: true, prefix: "p" } } } }) };
  assert.equal(await core.fetchCaptchaConfig("jwt", async () => noScene), null, "missing sceneId -> null");
  await assert.rejects(() => core.fetchCaptchaConfig("jwt", async () => ({ ok: false, status: 500, json: async () => ({}) })), /HTTP 500/);
});

test("ensureCredential: start-plan 通道 fail-loud（override 仍直通）", async () => {
  await assert.rejects(
    core.ensureCredential({ providerId: "bigmodel-start-plan", configDir: cfgOf(join(ROOT, "cred-start-plan")) }),
    /无头模式驱动/,
  );
  const overridden = await core.ensureCredential({ providerId: "bigmodel-start-plan", configDir: cfgOf(join(ROOT, "cred-start-plan")), override: "k" });
  assert.equal(overridden.source, "override");
});

test("ensureCredential: coding-plan 通道按 family 取 token（bigmodel-coding-plan → oauth:bigmodel:access_token）", async () => {
  // regression vs the 2026-09-12 fix: the old logic looked up oauth:${providerId}:access_token, so coding-plan channels found no token;
  // after the fix channelFamily collapses to bigmodel, reusing the family's OAuth token for the key exchange.
  core.resetZcodeCatalogCacheForTests();
  core.resetCredentialCacheForTests();
  const home = join(ROOT, "cred-plan");
  process.env.AITI_ZCODE_HOME = home;
  mkdirSync(join(home, "v2"), { recursive: true });
  const secret = core.deriveCredentialSecret();
  const credFile = join(home, "v2", "credentials.json");
  // desktop credentials are stored per family (no bigmodel-coding-plan-specific token)
  writeFileSync(credFile, JSON.stringify({ "oauth:bigmodel:access_token": encryptForTest("tok-plan", secret), "oauth:active_provider": "bigmodel" }));
  const configDir = cfgOf(join(ROOT, "cred-plan-data"));
  const stub = bigmodelFetchStub("tok-plan");
  const r = await core.ensureCredential({ providerId: "bigmodel-coding-plan", configDir, fetchImpl: stub.impl });
  assert.equal(r.apiKey, "0ab2a777.ox00kdXX");
  assert.equal(r.source, "fresh");
  assert.equal(stub.calls[0].auth, "tok-plan", "coding-plan channel exchanges the key with the family (bigmodel) OAuth token");
});

test("ensureCredential: coding-plan 跨家族无 token → 人话报错（不误取别家族）", async () => {
  core.resetZcodeCatalogCacheForTests();
  core.resetCredentialCacheForTests();
  const home = join(ROOT, "cred-plan-cross");
  process.env.AITI_ZCODE_HOME = home;
  mkdirSync(join(home, "v2"), { recursive: true });
  const secret = core.deriveCredentialSecret();
  const credFile = join(home, "v2", "credentials.json");
  // logged in as bigmodel but requesting zai-coding-plan (family=zai) -> must not grab bigmodel's token
  writeFileSync(credFile, JSON.stringify({ "oauth:bigmodel:access_token": encryptForTest("tok-x", secret), "oauth:active_provider": "bigmodel" }));
  const configDir = cfgOf(join(ROOT, "cred-plan-cross-data"));
  await assert.rejects(
    core.ensureCredential({ providerId: "zai-coding-plan", configDir, fetchImpl: async () => { throw new Error("should not fetch"); } }),
    /已登录通道为 \[bigmodel\].*zai-coding-plan 不匹配/,
  );
});

// ============================================================================
// wire contract: handle per-turn driving (fake runtime stub + feature stub + override key)
// ============================================================================

const OK_SESSION = "sess_11111111-2222-3333-4444-555555555555";

/** Generate a runtime stub: dump argv/key env vars to the DUMP file, then print --json-shaped output. */
function makeStub(dir, name, { session = OK_SESSION, response = "桩回答", exitCode = 0, stderr = "", dump = null, json = true } = {}) {
  const p = join(dir, name);
  const parts = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    ...(dump ? [`fs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ argv: process.argv.slice(2), env: { M: process.env.ZCODE_MODEL, B: process.env.ZCODE_BASE_URL, K: process.env.ZCODE_API_KEY, V: process.env.ZCODE_APP_VERSION, E: process.env.ZCODE_ENV } }, null, 2));`] : []),
    ...(json ? [
      `const out = ${JSON.stringify({ sessionId: session, traceId: "t", turnId: "tn", response, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 64 }, projection: { contextWindow: 1000000 } })};`,
      "console.log(JSON.stringify(out, null, 2));",
    ] : []),
    // pipe writes are async: must wait for the flush before exiting, or stderr/stdout gets truncated
    ...(stderr
      ? [`process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(${exitCode}));`]
      : [`process.exit(${exitCode});`]),
  ];
  writeFileSync(p, parts.join("\n"));
  return p;
}

async function setupExtension({ runtimeStub, features = {} } = {}) {
  const mod = await import("./index.ts");
  const featureMap = {
    "zcode.runtimePath": runtimeStub,
    "zcode.autoDownload": false,
    "zcode.mode": "build",
    "zcode.model": "bigmodel/GLM-5.3",
    "zcode.apiKeyOverride": "override.key",
    "zcode.transport": "oneshot", // all handle wire tests target the oneshot path (app-server channel covered in zcode-appserver.test.mjs)
    ...features,
  };
  // overwrite featureValue wholesale (do not spread the old object - its closure would point runtimePath at the previous test's stub);
  // keep only byId (used by the replay tests)
  const prevById = globalThis.__piWebExt?.byId;
  globalThis.__piWebExt = {
    featureValue: (extId, fid) => featureMap[fid],
    ...(prevById ? { byId: prevById } : {}),
  };
  let registered = null;
  const configDir = cfgOf(join(ROOT, "ext-data"));
  await mod.default.server.startup({
    configDir,
    sessionProviders: { register: (p) => { registered = p; return "aiti-zcode-agent/zcode"; } },
  });
  assert.ok(registered, "provider registered");
  assert.equal(registered.agentKey, "zcode");
  assert.equal(registered.type, "zcode");
  const staticModels = await registered.listModels();
  assert.ok(staticModels.length > 0, "static catalog non-empty (catalog filters by plan availability, no pinned tiers — see the dynamic catalog tests)");
  return { registered, configDir };
}

test("handle wire: 首轮捕获 sessionId 换绑 + usage + 事件流 + resume 第二轮", async () => {
  const dump = join(ROOT, "turn-dump.json");
  try { rmSync(dump); } catch { /* not exist */ }
  const stubDir = join(ROOT, "handle-stubs");
  mkdirSync(stubDir, { recursive: true });
  const stub = makeStub(stubDir, "ok.cjs", { dump });
  const { registered } = await setupExtension({ runtimeStub: stub });

  const handle = await registered.createSession({ cwd: ROOT });
  assert.ok(handle.id.startsWith("zcode:new-"), `temporary id: ${handle.id}`);
  assert.equal(handle.capabilities.steer, true); // native steer on the v4 gateway (same sendText guide as desktop, verified on a real machine)
  assert.equal(handle.capabilities.setModel, true);
  assert.equal(handle.model?.id, "bigmodel/GLM-5.3", "feature default model seed");

  const events = [];
  handle.subscribe((e) => events.push(e));
  await handle.prompt("第一轮");

  // rebind: session_backend_ready + id = zcode:sess_xxx
  const rebind = events.find((e) => e.type === "session_backend_ready");
  assert.ok(rebind, "session_backend_ready event");
  assert.equal(handle.id, `zcode:${OK_SESSION}`);
  assert.equal(rebind.oldId.startsWith("zcode:new-"), true);
  // reply events
  const upd = events.find((e) => e.type === "message_update");
  assert.equal(upd?.delta, "桩回答");
  // agent_start/agent_end pair (front-end spinner/finalization vocabulary; the wire layer drops turn_start/turn_end)
  const startIdx = events.findIndex((e) => e.type === "agent_start");
  const endIdx = events.findIndex((e) => e.type === "agent_end");
  const settleIdx = events.findIndex((e) => e.type === "agent_settled");
  assert.ok(startIdx >= 0, "agent_start emitted immediately on acceptance");
  assert.ok(endIdx > startIdx && settleIdx > endIdx, "agent_end -> agent_settled ordering");
  assert.ok(events.some((e) => e.type === "agent_settled" && e.stopReason === "end_turn"));
  // usage / context (getUsage is now async: tokens merged with account quota; no plan cache in this test env -> tokens-only)
  const usage = await handle.getUsage();
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.provider, "zcode");
  const cu = handle.getContextUsage();
  assert.equal(cu.tokens, 120);
  assert.equal(cu.contextWindow, 1000000);
  assert.ok(cu.percent > 0 && cu.percent < 1);
  // liveHistory
  const msgs = await handle.getMessages();
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[1].content[0].text, "桩回答");
  // spawn env/argv governance surface (stub dump): model ref + official endpoint + override key + build mode
  const dumped = JSON.parse(readFileSync(dump, "utf8"));
  assert.equal(dumped.env.M, "bigmodel/GLM-5.3");
  assert.equal(dumped.env.B, "https://open.bigmodel.cn/api/anthropic");
  assert.equal(dumped.env.K, "override.key");
  assert.equal(dumped.env.E, "production");
  assert.equal(dumped.argv[0], "--json");
  assert.equal(dumped.argv[1], "--mode");
  assert.equal(dumped.argv[2], "build");
  assert.equal(dumped.argv.at(-2), "--prompt");
  assert.equal(dumped.argv.at(-1), "第一轮");
  assert.ok(!dumped.argv.includes("--resume"), "first turn has no --resume");

  // second turn: --resume with the real sess id (clean featureValue replacement, keeping only byId)
  const dump2 = join(ROOT, "turn-dump-2.json");
  makeStub(stubDir, "ok2.cjs", { dump: dump2, response: "第二轮回答" });
  const prevById2 = globalThis.__piWebExt?.byId;
  globalThis.__piWebExt = {
    featureValue: (e, f) => (f === "zcode.runtimePath" ? join(stubDir, "ok2.cjs") : f === "zcode.apiKeyOverride" ? "override.key" : f === "zcode.mode" ? "build" : f === "zcode.autoDownload" ? false : f === "zcode.transport" ? "oneshot" : ""),
    ...(prevById2 ? { byId: prevById2 } : {}),
  };
  const events2 = [];
  handle.subscribe((e) => events2.push(e));
  await handle.prompt("第二轮");
  const dumped2 = JSON.parse(readFileSync(dump2, "utf8"));
  const ri = dumped2.argv.indexOf("--resume");
  assert.ok(ri > 0, "second turn carries --resume");
  assert.equal(dumped2.argv[ri + 1], OK_SESSION);
  assert.ok(!events2.some((e) => e.type === "session_backend_ready"), "already rebound, no re-emit");
  await handle.dispose();
});

test("handle wire: CLI 失败 → error 帧进 liveHistory + agent_settled_error", async () => {
  const stubDir = join(ROOT, "fail-stubs");
  mkdirSync(stubDir, { recursive: true });
  const stderr = [
    "AI_APICallError: 402",
    "  responseBody: '{\"error\":{\"message\":\"身份验证失败。\",\"type\":\"1000\"}}',",
    "  isRetryable: false,",
    "Error: Turn execution failed (traceId: x)",
  ].join("\n");
  const stub = makeStub(stubDir, "fail.cjs", { exitCode: 1, stderr, json: false });
  const { registered } = await setupExtension({ runtimeStub: stub });
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));
  await handle.prompt("会失败");
  // the runTurn entry first emits the user bubble's message_end (bubble settled) — error frames are matched precisely by stopReason
  const errEnd = events.find((e) => e.type === "message_end" && e.message?.stopReason === "error");
  assert.ok(errEnd, "message_end error frame");
  assert.match(errEnd.message.errorMessage, /身份验证失败/);
  assert.equal(errEnd.message.provider, "zcode");
  assert.ok(events.some((e) => e.type === "agent_settled_error"));
  const msgs = await handle.getMessages();
  assert.equal(msgs.at(-1).stopReason, "error", "error frame lands in liveHistory (visible on reopen)");
  assert.equal(handle.getContextUsage(), undefined, "failed turn has no usage");
  await handle.dispose();
});

test("handle wire: runtime 不可用 → fail-loud error 帧带指引", async () => {
  const { registered } = await setupExtension({ runtimeStub: "/nonexistent/runtime.cjs" });
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));
  await handle.prompt("hi");
  const errEnd = events.find((e) => e.type === "message_end" && e.message?.stopReason === "error");
  assert.ok(errEnd?.message.errorMessage.includes("zcode.runtimePath") || /runtime/.test(errEnd.message.errorMessage), "human-readable error");
  await handle.dispose();
});

test("handle wire: setModel 校验 ref + 切换事件 + 下轮生效（zai 通道端点切换）", async () => {
  const dump = join(ROOT, "turn-dump-model.json");
  const stubDir = join(ROOT, "model-stubs");
  mkdirSync(stubDir, { recursive: true });
  const stub = makeStub(stubDir, "ok.cjs", { dump, session: "sess_model-1" });
  const { registered } = await setupExtension({ runtimeStub: stub });
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));
  await assert.rejects(() => handle.setModel({ id: "not-a-ref", provider: "zcode" }), /非法模型 ref/);
  assert.ok(await handle.setModel({ id: "zai/GLM-5.3-Flash", provider: "zcode" }));
  assert.equal(handle.getModel().id, "zai/GLM-5.3-Flash");
  await handle.prompt("用新模型");
  assert.ok(events.some((e) => e.type === "model_select" && e.model.id === "zai/GLM-5.3-Flash"));
  const dumped = JSON.parse(readFileSync(dump, "utf8"));
  assert.equal(dumped.env.M, "zai/GLM-5.3-Flash");
  assert.equal(dumped.env.B, "https://api.z.ai/api/anthropic");
  await handle.dispose();
});

test("handle wire: start-plan 通道拦截 —— 目录照常列出+提示 / 新建与切换人话拒绝 / 发消息人话失败（已知会话文案）", async () => {
  const home = join(ROOT, "startplan-home");
  const prevHome = process.env.AITI_ZCODE_HOME;
  process.env.AITI_ZCODE_HOME = home;
  rmSync(join(home, "v2"), { recursive: true, force: true });
  mkdirSync(join(home, "v2"), { recursive: true });
  writeFileSync(join(home, "v2", "config.json"), JSON.stringify({
    provider: {
      "builtin:bigmodel-start-plan": { name: "BigModel - Start Plan", options: { baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" }, models: { "GLM-5.3-Flash": {} } },
      "builtin:zai-start-plan": { name: "Z.ai - Start Plan", options: { baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" }, models: { "GLM-5.3-Flash": {} } },
    },
  }));
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: { "builtin:bigmodel-start-plan": { status: "available" } } },
  }));
  core.resetZcodeCatalogCacheForTests();
  const stubDir = join(ROOT, "startplan-stubs");
  mkdirSync(stubDir, { recursive: true });
  const stub = makeStub(stubDir, "ok.cjs", { session: "sess_startplan-1" });
  const { registered } = await setupExtension({ runtimeStub: stub });
  // 1) catalog: no longer hidden, listed as usual with a "not yet supported" hint
  const models = await registered.listModels();
  const sp = models.find((m) => m.id === "bigmodel-start-plan/GLM-5.3-Flash");
  assert.ok(sp, "start-plan model listed as usual (no longer excluded)");
  assert.match(sp.label, /desktop only/, "label carries the 'not yet supported' hint");
  assert.ok(!models.some((m) => m.id.startsWith("zai-start-plan/")), "zai-start-plan without evidence (no available in the plan cache) -> not listed");
  // 2) creating a session with an explicit start-plan pick -> human-readable rejection (the user learns immediately on click)
  await assert.rejects(
    () => registered.createSession({ cwd: ROOT, model: { provider: "zcode", id: "bigmodel-start-plan/GLM-5.3-Flash" } }),
    /start-plan.*暂不支持/,
  );
  // 3) switching to start-plan mid-run -> human-readable rejection; switching away from start-plan is not blocked
  const handle = await registered.createSession({ cwd: ROOT });
  await assert.rejects(
    () => handle.setModel({ id: "bigmodel-start-plan/GLM-5.3-Flash", provider: "zcode" }),
    /start-plan.*暂不支持/,
  );
  assert.ok(await handle.setModel({ id: "bigmodel/GLM-5.3", provider: "zcode" }), "switching to a driveable channel is not blocked");
  // 4) known start-plan session (resume-path semantics: model is start-plan + bound sess id) -> prompting fails directly with a human-readable error
  // 4a) a restored start-plan session whose channel is not in the plan cache's available set (e.g. after a plan change) -> the picker's current model still carries the hint (synthetic label backfill)
  handle.model = { id: "zai-start-plan/GLM-5.3-Flash", provider: "zcode" };
  const restoredList = await handle.getAvailableModels();
  const restoredCur = restoredList.find((m) => m.id === "zai-start-plan/GLM-5.3-Flash");
  assert.ok(restoredCur && /desktop only/.test(restoredCur.label ?? ""), "restored session's synthetic entry label gains the 'desktop only' hint (zai-start-plan not in available)");
  // 4b) prompt interception (known bigmodel-start-plan session -> dedicated wording)
  handle.model = { id: "bigmodel-start-plan/GLM-5.3-Flash", provider: "zcode" };
  handle.setKnownSessionId("sess_startplan-1");
  const events = [];
  handle.subscribe((e) => events.push(e));
  await handle.prompt("开始");
  const errEnd = events.find((e) => e.type === "message_end" && e.message?.stopReason === "error");
  assert.ok(errEnd, "prompt fails with a human-readable error (no runtime spawn)");
  assert.match(errEnd.message.errorMessage, /start-plan/, "message mentions start-plan");
  assert.match(errEnd.message.errorMessage, /已知会话/, "known-session-specific wording (known session loaded via start)");
  assert.ok(events.some((e) => e.type === "agent_settled_error"));
  await handle.dispose();
  rmSync(join(home, "v2"), { recursive: true, force: true });
  process.env.AITI_ZCODE_HOME = prevHome;
  core.resetZcodeCatalogCacheForTests();
});

test("handle wire: All Sessions 历史行复活（sess_ 前缀 → createSession 即可续聊）", async () => {
  const dump = join(ROOT, "turn-dump-history.json");
  const stubDir = join(ROOT, "history-stubs");
  mkdirSync(stubDir, { recursive: true });
  const stub = makeStub(stubDir, "ok.cjs", { dump, session: "sess_11111111-2222-3333-4444-555555555555" });
  const { registered } = await setupExtension({ runtimeStub: stub });
  const handle = await registered.createSession({ cwd: ROOT, sessionId: "sess_11111111-2222-3333-4444-555555555555" });
  assert.equal(handle.id, "zcode:sess_11111111-2222-3333-4444-555555555555");
  const events = [];
  handle.subscribe((e) => events.push(e));
  await handle.prompt("续聊");
  const dumped = JSON.parse(readFileSync(dump, "utf8"));
  const ri = dumped.argv.indexOf("--resume");
  assert.ok(ri > 0, "first turn already carries --resume (history row)");
  assert.ok(!events.some((e) => e.type === "session_backend_ready"), "id unchanged, no rebind");
  await handle.dispose();
});

test("handle wire: 默认模型通道跟随套餐探测（feature 留空 + coding-plan-cache）", async () => {
  const home = join(ROOT, "seed-home");
  const prevHome = process.env.AITI_ZCODE_HOME;
  process.env.AITI_ZCODE_HOME = home;
  rmSync(join(home, "v2"), { recursive: true, force: true });
  mkdirSync(join(home, "v2"), { recursive: true });
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: { "builtin:zai-coding-plan": { status: "available" } } },
  }));
  // per-agent last-used state written by earlier cases in this file overrides the empty-feature seed — clear it so this case
  // only verifies "plan probe -> default ref"; last-used inheritance has its own dedicated test.
  rmSync(join(process.env.EXT_MODEL_STATE_DIR, "zcode"), { recursive: true, force: true });
  const stubDir = join(ROOT, "seed-stubs");
  mkdirSync(stubDir, { recursive: true });
  const stub = makeStub(stubDir, "ok.cjs", { session: "sess_seed-1" });
  const { registered } = await setupExtension({ runtimeStub: stub, features: { "zcode.model": "" } });
  const handle = await registered.createSession({ cwd: ROOT });
  assert.equal(handle.model?.id, "zai/GLM-5.3-Flash", "zai plan -> default ref follows the zai channel (model = DEFAULT_MODEL_REF's Flash)");
  await handle.dispose();
  rmSync(join(home, "v2"), { recursive: true, force: true });
  process.env.AITI_ZCODE_HOME = prevHome;
  core.resetZcodeCatalogCacheForTests();
});

test("handle wire: 新建会话未指定模型 → 继承该 agent 上次使用的模型（per-agent last used）", async () => {
  const home = join(ROOT, "lastused-home");
  const prevHome = process.env.AITI_ZCODE_HOME;
  process.env.AITI_ZCODE_HOME = home;
  rmSync(join(home, "v2"), { recursive: true, force: true });
  mkdirSync(join(home, "v2"), { recursive: true });
  rmSync(join(process.env.EXT_MODEL_STATE_DIR, "zcode"), { recursive: true, force: true });
  const stubDir = join(ROOT, "lastused-stubs");
  mkdirSync(stubDir, { recursive: true });
  const stub = makeStub(stubDir, "ok.cjs", { session: "sess_lastused-1" });
  // write a "last used" state file directly (avoids the persistModelState fire-and-forget race)
  const { writeExtModelState } = await import("@aiti-ai/ext-shared/ext-model-state");
  await writeExtModelState({
    agentKey: "zcode", sessionId: "zcode:prev-session",
    selected: { provider: "zcode", id: "zai/GLM-5.3-Flash" }, models: [], updatedAt: "",
  });
  const { registered } = await setupExtension({ runtimeStub: stub, features: { "zcode.model": "", "zcode.apiKeyOverride": "override.key" } });
  const handle = await registered.createSession({ cwd: ROOT });
  assert.equal(handle.model?.id, "zai/GLM-5.3-Flash", "new session default model = this agent's last used model");
  await handle.dispose();
  rmSync(join(home, "v2"), { recursive: true, force: true });
  process.env.AITI_ZCODE_HOME = prevHome;
  core.resetZcodeCatalogCacheForTests();
});

test("handle wire: resume 时经 All Sessions 服务出口回放历史（缺席 fail-silent）", async () => {
  const stubDir = join(ROOT, "replay-stubs");
  mkdirSync(stubDir, { recursive: true });
  const stub = makeStub(stubDir, "ok.cjs", { session: "sess_replay-1", response: "新轮回答" });
  const { registered } = await setupExtension({ runtimeStub: stub });
  // mock the services.sessions outlet (session-manager's read surface)
  globalThis.__piWebExt.byId = () => ({
    ext: { services: { sessions: { async parseSession(id) {
      assert.equal(id, "zcode:sess_replay-1");
      return { meta: { model: "zai/GLM-5.3-Flash" }, messages: [
        { role: "user", text: "历史问题" },
        { role: "assistant", text: "历史回答", model: "GLM-5.3", provider: "bigmodel" },
      ] };
    } } } },
  });
  const handle = await registered.createSession({ cwd: ROOT, sessionId: "sess_replay-1" });
  const msgs = await handle.getMessages();
  assert.equal(msgs.length, 2, "history backfilled into liveHistory");
  assert.equal(msgs[0].content[0].text, "历史问题");
  assert.equal(msgs[1].content[0].text, "历史回答");
  // per-message model tags (front-end MessageView rendering depends on message.model + message.provider);
  // both fields pass through the source store's providerID/modelID verbatim, no normalization or rewrite
  assert.equal(msgs[1].model, "GLM-5.3");
  assert.equal(msgs[1].provider, "bigmodel");
  assert.equal(msgs[0].model, undefined, "user message carries no model tag");
  // keep chatting: new-turn messages append after the history
  await handle.prompt("新问题");
  const msgs2 = await handle.getMessages();
  assert.equal(msgs2.length, 4);
  assert.equal(msgs2[3].content[0].text, "新轮回答");
  await handle.dispose();
  // image replay: images -> content image block (the shape the front-end MessageView renders natively)
  globalThis.__piWebExt.byId = () => ({
    ext: { services: { sessions: { async parseSession() {
      return { meta: {}, messages: [
        { role: "user", text: "看这张图", images: [
          { mime: "image/png", filename: "截图.png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
        ] },
      ] };
    } } } },
  });
  // restore the session's real model: meta.model (applies when the state file has no record for the session)
  assert.equal(handle.getModel()?.id, "zai/GLM-5.3-Flash", "replay restores the session model");
  const h3 = await registered.createSession({ cwd: ROOT, sessionId: "sess_replay-3" });
  const msgs3 = await h3.getMessages();
  assert.equal(msgs3.length, 1);
  assert.equal(msgs3[0].content.length, 2, "text + image blocks");
  assert.deepEqual(msgs3[0].content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });
  await h3.dispose();
  // absent fail-silent: byId has no session-manager -> no replay but no error
  globalThis.__piWebExt.byId = () => undefined;
  const h2 = await registered.createSession({ cwd: ROOT, sessionId: "sess_replay-2" });
  assert.deepEqual(await h2.getMessages(), []);
  await h2.dispose();
  delete globalThis.__piWebExt.byId;
});

test("handle wire: 运行中排队（queue_update + settle 后自动续轮）+ setPermissionMode 下轮生效", async () => {
  const stubDir = join(ROOT, "queue-stubs");
  mkdirSync(stubDir, { recursive: true });
  const dump = join(ROOT, "queue-dump.json");
  // slow stub: 800ms for the first turn (window for queuing); reply text embeds the mode to tell turns apart
  const slow = join(stubDir, "slow.cjs");
  writeFileSync(slow, `#!/usr/bin/env node
process.on("uncaughtException", (e) => require("node:fs").writeFileSync("/tmp/q-crash.log", String(e.stack ?? e)));
process.on("unhandledRejection", (e) => require("node:fs").writeFileSync("/tmp/q-crash.log", "rejection: " + String(e)));
const args = process.argv.slice(2);
const mode = args[args.indexOf("--mode") + 1];
setTimeout(() => {
  // no trailing newline — cross-layer escaping is fragile; parseTurnOutput parses the whole blob directly
  process.stdout.write(JSON.stringify({ sessionId: "${OK_SESSION}", response: "mode=" + mode }), () => process.exit(0));
}, 800);
`);
  writeFileSync(join(stubDir, "SLOW_SRC.txt"), readFileSync(slow, "utf8"));
  const { registered } = await setupExtension({ runtimeStub: slow });
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));
  const p1 = handle.prompt("第一轮");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(handle.isRunning(), true);
  // two more prompts while running -> queued without errors
  await handle.prompt("第二轮(排队)");
  await handle.prompt("第三轮(排队)");
  assert.equal((await handle.getMessages()).filter((m) => m.role === "user").length, 1, "queued messages not yet in liveHistory");
  await p1;
  // auto-continue after settle: wait for the queued turns to finish
  for (let i = 0; i < 40 && handle.isRunning(); i++) await new Promise((r) => setTimeout(r, 100));
  for (let i = 0; i < 40 && (await handle.getMessages()).filter((m) => m.role === "user").length < 3; i++) await new Promise((r) => setTimeout(r, 100));
  const msgs = await handle.getMessages();
  assert.equal(msgs.filter((m) => m.role === "user").length, 3, "all queued messages land in liveHistory");
  assert.ok(events.some((e) => e.type === "queue_update" && e.followUp?.length === 2), "queue_update mirrors the queue");
  // setPermissionMode: desiredMode takes effect on the next turn
  assert.ok(await handle.setPermissionMode("plan"));
  await assert.rejects(() => handle.setPermissionMode("bogus"), /非法权限模式/);
  await handle.dispose();
});

test("handle wire: abort 杀当前轮子进程（settled 带非 end_turn）", async () => {
  const stubDir = join(ROOT, "abort-stubs");
  mkdirSync(stubDir, { recursive: true });
  // slow stub: prints only after 2s (window for abort)
  const slow = join(stubDir, "slow.cjs");
  writeFileSync(slow, `#!/usr/bin/env node
setTimeout(() => { console.log(JSON.stringify({ sessionId: "${OK_SESSION}", response: "不该出现" })); process.exit(0); }, 2000);
`);
  const { registered } = await setupExtension({ runtimeStub: slow });
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));
  const p = handle.prompt("慢慢跑");
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  await handle.abort();
  await p;
  assert.ok(Date.now() - t0 < 1500, "turn settles quickly after abort");
  const settled = events.find((e) => e.type === "agent_settled");
  assert.ok(settled, "settled frame present");
  assert.equal(settled.stopReason, "aborted", "SIGTERM -> aborted (user-initiated abort, not an error)");
  assert.ok(!events.some((e) => e.type === "message_update"), "aborted turn has no reply");
  await handle.dispose();
});

test("planQuotaView：套餐通道状态 → 额度视图（available 列表 / 无可用 / 缺缓存）", () => {
  const v = core.planQuotaView([
    { channel: "zai-start-plan", status: "unavailable" },
    { channel: "bigmodel-coding-plan", status: "available" },
    { channel: "bigmodel-start-plan", status: "available" },
  ], 1700000000000);
  assert.equal(v.available, true);
  assert.equal(v.display, "套餐：bigmodel-coding-plan, bigmodel-start-plan 可用");
  assert.equal(v.unit, "plan");
  assert.equal(v.packages.length, 3);
  assert.deepEqual(v.packages[0], { name: "zai-start-plan", note: "unavailable" });
  assert.equal(v.fetchedAt, 1700000000000);

  const none = core.planQuotaView([{ channel: "zai-coding-plan", status: "unavailable" }], 1);
  assert.equal(none.display, "套餐：无可用通道");

  const empty = core.planQuotaView([], 2);
  assert.equal(empty.available, false);
  assert.equal(empty.reason, "no-plan-cache");
  assert.equal(empty.fetchedAt, 2);
});

test("handle wire: 外部写入推进（桌面端另写同一会话）→ getMessages 从源重建最新历史", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const prevHome = process.env.AITI_ZCODE_HOME;
  const home = join(ROOT, "ext-sync-home");
  process.env.AITI_ZCODE_HOME = home;
  // build a minimal db: readZcodeSessionUpdatedMs only queries session.time_updated (parsing is covered by the mock service below)
  const dbPath = join(home, "cli", "db", "db.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const writeTs = (sid, ts) => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, time_updated INTEGER)");
      db.prepare("INSERT OR REPLACE INTO session (id, time_updated) VALUES (?, ?)").run(sid, ts);
    } finally { db.close(); }
  };
  const T1 = 1_000_000, T2 = 2_000_000;
  writeTs("sess_ext-1", T1);

  const stubDir = join(ROOT, "ext-sync-stubs");
  mkdirSync(stubDir, { recursive: true });
  const stub = makeStub(stubDir, "ok.cjs", { session: "sess_ext-1" });
  // parse output advances with the "external write": 1 message in phase one (seed), 2 after T2 (rebuild)
  let parseCalls = 0;
  let extMessages = [{ role: "user", text: "历史问题" }];
  globalThis.__piWebExt.byId = () => ({
    ext: { services: { sessions: { async parseSession(id) {
      assert.equal(id, "zcode:sess_ext-1");
      parseCalls += 1;
      return { meta: {}, messages: extMessages };
    } } } },
  });

  const { registered } = await setupExtension({ runtimeStub: stub });
  const handle = await registered.createSession({ cwd: ROOT, sessionId: "sess_ext-1" });
  assert.equal((await handle.getMessages()).length, 1, "seed history is 1 message");
  assert.equal(parseCalls, 1, "parsed once at seed time");

  // watermark unchanged -> no repeated parse (zero overhead)
  assert.equal((await handle.getMessages()).length, 1);
  assert.equal(parseCalls, 1, "unchanged rev does not re-read the source");

  // external desktop write: db watermark advances + one assistant message added at the source
  writeTs("sess_ext-1", T2);
  extMessages = [
    { role: "user", text: "历史问题" },
    { role: "assistant", text: "历史回答", model: "GLM-5.3", provider: "bigmodel" },
  ];
  const msgs = await handle.getMessages();
  assert.equal(msgs.length, 2, "external advance -> rebuilt to the latest history");
  assert.equal(msgs[1].content[0].text, "历史回答");
  assert.equal(parseCalls, 2, "advance triggers exactly one source re-read");

  // watermark synced after rebuild -> subsequent reads do not re-parse
  assert.equal((await handle.getMessages()).length, 2);
  assert.equal(parseCalls, 2);

  await handle.dispose();
  delete globalThis.__piWebExt.byId;
  process.env.AITI_ZCODE_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});
