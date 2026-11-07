/**
 * aiti-zcode-agent tests — wire 契约（假 runtime 桩 + 纯函数），零网络零真凭据。
 *
 * Run: node --test pi-web-ext/aiti-zcode-agent/zcode-core.test.mjs
 * （node 24 原生 TS strip-types，import .ts 与 ext-model-state.test.mjs 同款）
 *
 * 桩机制：
 *   - runtime 桩 = node 脚本，按测试需要打印 --json 形态的 JSON / 失败退出；
 *   - 假 AppImage = shell 脚本，收到 --appimage-extract 时伪造 squashfs-root/resources/glm/zcode.cjs；
 *   - 凭据链 = AITI_ZCODE_HOME 指向临时目录 + 注入 fetchImpl；
 *   - feature = globalThis.__piWebExt.featureValue 桩。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

// ---- 环境隔离（先于 import 被测模块设置）------------------------------------
const ROOT = mkdtempSync(join(tmpdir(), "zcode-agent-test-"));
process.env.EXT_MODEL_STATE_DIR = join(ROOT, "ext-model-state");
process.env.AITI_ZCODE_HOME = join(ROOT, "zcode-home");
mkdirSync(process.env.AITI_ZCODE_HOME, { recursive: true });

const core = await import("./zcode-core.ts");

/** 三目录对称（2026-09-13）：宿主注入 configDir = <extRoot>/config；测试给每个用例独立 extRoot 以隔离 cache/state。 */
function cfgOf(root) {
  const c = join(root, "config");
  mkdirSync(c, { recursive: true });
  return c;
}

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// ============================================================================
// 纯函数：--json 解析
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
// 纯函数：模型 ref / argv / env
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
  // 非法 mode 回落 build
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
// provider runtime 闸 env（3.17+ CLI 启动必需；桌面端同款注入，2026-11-07）
// 真机复现：无注入 → 「无法定位 CLI ZCode Built-in Provider Config：…/glm/provider/…, /config/provider/…」
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
  const rt = join(ROOT, "appimg2", "resources", "glm", "zcode.cjs"); // 同包 config 不存在
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
// 3.17+ personal provider config（registry 模型注册；2026-11-07 实测配方）
// 全部必填字段缺任一项 → CLI 整体静默 recovery 成空 registry → setModel「不存在 Model」
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
  assert.equal(rule.config.group, "standard-personal");                          // registry 层必填（比 zod 严）
  assert.deepEqual(rule.config.personalModelIds, ["GLM-5.3-Flash", "GLM-5.3"]);  // 模型清单来源（builtinModelIds 被 omit）
  assert.equal(rule.config.access.type, "zhipu-coding-plan-api-key");
  assert.equal(rule.config.api.baseUrl, "https://open.bigmodel.cn/api/anthropic");
  const m0 = doc.config.modelConfigRules.manualProviderModelRules[0];
  assert.equal(m0.modelId, "GLM-5.3-Flash");
  assert.equal(m0.config.enabled, true);                                         // 模型可执行闸（严格 === true）
  assert.equal(m0.config.properties.contextWindow, 1000000);
  assert.ok(m0.config.properties.inputFormat.supportsImage);
  assert.deepEqual(doc.config.modelConfigRules.providerModelRules, []);          // 键必带（空数组也要）
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
  assert.equal(statSync(file).mode & 0o777, 0o600, "含 apiKey 必须 0600");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const rules = doc.config.providerConfigRules.providerRules;
  assert.deepEqual(rules.map((r) => r.providerId).sort(), ["bigmodel", "other"]);
  const manual = doc.config.modelConfigRules.manualProviderModelRules;
  assert.deepEqual(manual.map((r) => `${r.providerId}/${r.modelId}`).sort(), ["bigmodel/GLM-5.3-Flash", "other/m1"]);
  assert.equal(doc.config.defaultModelSelection.modelId, "GLM-5.3-Flash");
  // 同 providerId 再写：覆盖不重复
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
// 凭据链路：解密 → 换 key → 缓存（注入 fetch，零网络）
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
  assert.ok(out.includes(raw), "保留原始错误便于排查");
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
        assert.equal(init.headers.Authorization, expectedToken, "bigmodel getCustomerInfo 用裸 token 无 Bearer");
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
  // 幂等缓存：第二次不打 API
  const r2 = await core.ensureCredential({ providerId: "bigmodel", configDir, fetchImpl: stub.impl });
  assert.equal(r2.source, "cache");
  assert.equal(stub.calls.length, 4);
  // 磁盘缓存文件 0600 且含 key（POSIX 权限语义；NTFS 无 POSIX 位，Windows 跳过该断言）
  const cacheFile = join(configDir, "zcode-api-key.json");
  assert.ok(existsSync(cacheFile));
  const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
  assert.equal(cache.apiKey, "0ab2a777.ox00kdXX");
  if (process.platform !== "win32") {
    const mode = (await import("node:fs")).statSync(cacheFile).mode & 0o777;
    assert.equal(mode, 0o600, "key 缓存 0600");
  }
  // 指纹变化（模拟桌面端重新授权）→ 重新换 key
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
  // 通道不匹配（只有 zai token，要 bigmodel）
  const secret = core.deriveCredentialSecret();
  writeFileSync(join(home, "v2", "credentials.json"), JSON.stringify({ "oauth:zai:access_token": encryptForTest("ztok", secret) }));
  await assert.rejects(
    () => core.ensureCredential({ providerId: "bigmodel", configDir }),
    (e) => /不匹配/.test(e.message),
  );
  // override 优先且不打 API
  const r = await core.ensureCredential({ providerId: "bigmodel", configDir, override: "manual.key" });
  assert.deepEqual(r, { apiKey: "manual.key", providerId: "bigmodel", source: "override" });
});

test("ensureCredential: 桌面 config.json 现成通道 key 优先（不换 key、不打 API、不读凭据）", async () => {
  const home = join(ROOT, "cred-desktop");
  process.env.AITI_ZCODE_HOME = home;
  mkdirSync(join(home, "v2"), { recursive: true });
  // 凭据文件为空（不可解密也不影响：desktop key 在解密之前命中）
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
  // 同通道再取 = 仍走桌面 key（实时读 config.json，不落磁盘缓存）
  const r2 = await core.ensureCredential({ providerId: "zai-coding-plan", configDir });
  assert.equal(r2.source, "desktop");
  // 其它通道（config.json 无 key）→ 回退原链路：凭据空 → 人话报错
  await assert.rejects(
    () => core.ensureCredential({ providerId: "bigmodel", configDir, fetchImpl: async () => { throw new Error("should not fetch"); } }),
    (e) => /未登录|凭据/.test(e.message),
  );
});

// ============================================================================
// runtime：版本解析 / 下载页解析 / 解压缓存
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
  assert.equal(urls.length, 3, "只取 linux-x64 AppImage（含旧斜杠形态）");
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
  // 假 AppImage：shell 脚本伪装 runtime 的 --appimage-extract 行为
  writeFileSync(fakeApp, `#!/bin/sh
mkdir -p "$PWD/squashfs-root/resources/glm"
printf '#!/usr/bin/env node\\nconsole.log("{}")\\n' > "$PWD/squashfs-root/resources/glm/zcode.cjs"
`);
  chmodSync(fakeApp, 0o755);

  const logs = [];
  const r1 = await core.resolveRuntime({ configDir, autoDownload: false, mountScanDir: emptyMount, winInstallDirs: [], log: (m) => logs.push(m) });
  assert.equal(r1.appVersion, "4.0.0");
  assert.equal(r1.origin, "appimage");
  assert.ok(existsSync(r1.cjsPath), "解压产物 zcode.cjs 存在");
  // 缓存命中：删掉假 AppImage 后仍能解析（来自缓存目录）
  rmSync(fakeApp);
  const r2 = await core.resolveRuntime({ configDir, autoDownload: false, mountScanDir: emptyMount, winInstallDirs: [] });
  assert.equal(r2.cjsPath, r1.cjsPath);
  assert.ok(r2.cjsPath.includes(join(dirname(configDir), "cache", "runtime", "ZCode-4.0.0")), "缓存位于 extRoot/cache（三目录对称）");
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
  assert.equal(core.isReadableFile(locked), false, "stat 通过但 open 失败（断开 FUSE 挂载点同型）应判不可读");
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
  chmodSync(locked, 0o000); // 模拟断开挂载：stat 通过、open 失败（ENOTCONN/EACCES）
  const configDir = cfgOf(join(ROOT, "rt-mount-data"));
  const r = await core.resolveRuntime({ configDir, autoDownload: false, mountScanDir: mount, winInstallDirs: [] });
  assert.equal(r.origin, "mount");
  assert.ok(r.cjsPath.includes(".mount_ZCode-GOOD"), `应跳过不可读残留、选中可读挂载，实际 ${r.cjsPath}`);
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
  // 缺环境变量时跳过对应项
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
  assert.equal(r.appVersion, "3.11.2", "多目录命中取 asar 版本最高者");

  // 无 asar（或 asar 损坏）→ cjs 仍可用，版本缺省
  const winPlain = join(ROOT, "win-plain");
  mkdirSync(join(winPlain, "resources", "glm"), { recursive: true });
  writeFileSync(join(winPlain, "resources", "glm", "zcode.cjs"), "// cli");
  const rp = await core.resolveRuntime({ configDir: cfgOf(join(ROOT, "rt-win-plain")), autoDownload: false, winInstallDirs: [winPlain] });
  assert.equal(rp.origin, "install");
  assert.equal(rp.appVersion, undefined);
});

/** 构造新格式假 asar：头部 16B + header JSON（offset 为字符串，相对 data 区）+ data 区 package.json。 */
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
  // 新格式（header 在头部，offset 为字符串）
  makeFakeAsar(dir, "5.2.1");
  assert.equal(core.detectWindowsInstallVersion(dir), "5.2.1");
  // 旧格式（header 在尾部：[data][u32 size][u32 headerSize][header JSON]，offset 为数字）
  const pkg = JSON.stringify({ name: "zcode", version: "4.0.0" });
  const header = JSON.stringify({ files: { "package.json": { size: pkg.length, offset: 0 } } });
  const headerSize = header.length;
  const size = headerSize + 8;
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(size, 0);
  tail.writeUInt32LE(headerSize, 4);
  writeFileSync(join(dir, "resources", "app.asar"), Buffer.concat([Buffer.from(pkg), Buffer.from(header), tail]));
  assert.equal(core.detectWindowsInstallVersion(dir), "4.0.0");
  // 目录无 asar → null
  const empty = join(ROOT, "detect-empty");
  mkdirSync(join(empty, "resources"), { recursive: true });
  assert.equal(core.detectWindowsInstallVersion(empty), null);
});

test("downloadAppimage: .part 原子落盘 + 小内容拒收（防半文件当缓存）", async () => {
  const { downloadAppimage } = core;
  const dest = join(ROOT, "dl", "ZCode-9.9.9-linux-x64.AppImage");
  // 小内容（<1MB）拒收且不留 .part
  await assert.rejects(
    () => downloadAppimage("https://cdn.test/x", dest, async () => new Response("error page", { status: 200 })),
    /下载内容异常/,
  );
  assert.ok(!existsSync(dest), "不落正式文件");
  assert.ok(!existsSync(`${dest}.part`), "不残留 .part");
  // HTTP 错误拒收
  await assert.rejects(
    () => downloadAppimage("https://cdn.test/x", dest, async () => new Response("no", { status: 404 })),
    /HTTP 404/,
  );
  // abort 信号：fetch 挂起时外部 abort → rejects 且不残留 .part
  const ac = new AbortController();
  const hung = new Promise((resolve) => { ac.signal.addEventListener("abort", () => resolve(new Response("late", { status: 200 }))); });
  const p = downloadAppimage("https://cdn.test/x", dest, async () => hung, () => {}, ac.signal);
  ac.abort();
  await assert.rejects(p);
  assert.ok(!existsSync(`${dest}.part`), "abort 后无 .part 残留");
});

test("detectPlanProvider: coding-plan-cache available 状态选通道 + 缺文件回落 null", () => {
  const home = join(ROOT, "plan-home");
  process.env.AITI_ZCODE_HOME = home;
  rmSync(join(home, "v2"), { recursive: true, force: true });
  assert.equal(core.detectPlanProvider(), null, "文件缺失 → null");
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
  // 仅 start-plan 可用（桌面端体验套餐）：家族仍可裁决（回落同家族 base/coding-plan，不选 start-plan 本身）
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: {
      "builtin:zai-start-plan": { status: "available" },
      "builtin:bigmodel-coding-plan": { status: "unavailable" },
    } },
  }));
  assert.equal(core.detectPlanProvider(), "zai", "仅 zai-start-plan 可用 → 家族 zai（此前返回 null 会回落 bigmodel 种出目录外模型）");
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: {
      "builtin:bigmodel-start-plan": { status: "available" },
      "builtin:zai-start-plan": { status: "unavailable" },
    } },
  }));
  assert.equal(core.detectPlanProvider(), "bigmodel", "仅 bigmodel-start-plan 可用 → 家族 bigmodel");
});

test("动态目录: 注册表+套餐缓存（桌面端同款数据源）→ buildZcodeCatalogRefs/parseModelRef/baseUrlFor", () => {
  const home = join(ROOT, "dyn-home");
  const prevHome = process.env.AITI_ZCODE_HOME;
  process.env.AITI_ZCODE_HOME = home;
  rmSync(join(home, "v2"), { recursive: true, force: true });
  mkdirSync(join(home, "v2"), { recursive: true });
  writeFileSync(join(home, "v2", "config.json"), JSON.stringify({
    provider: {
      // 真实桌面结构：端点写在 options.baseURL（2026-09-12 48/155 实测）；
      // 首条保留顶层 baseURL 覆盖兼容兜底分支。
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

  // 注册表解析：builtin: strip + models 键集透出
  const reg = core.readProviderRegistry();
  const startEntry = reg.find((p) => p.channel === "bigmodel-start-plan");
  assert.equal(startEntry?.baseURL, "https://zcode.z.ai/api/v1/zcode-plan/anthropic");
  assert.deepEqual(reg.find((p) => p.channel === "zai-start-plan")?.models, []);
  assert.deepEqual(
    core.readPlanStatus().filter((x) => x.status === "available").map((x) => x.channel).sort(),
    ["bigmodel-coding-plan", "bigmodel-start-plan"],
  );

  // 目录（2026-09-15 起不再排除）：start-plan 桌面端实据 available → 照常列出，标签带「暂不支持」提示；
  // 未开通（unavailable）或注册表无模型不列（zai-start-plan 模型表为空 → 无条目）。
  const refs = core.buildZcodeCatalogRefs();
  assert.ok(refs.some((m) => m.id === "bigmodel-start-plan/GLM-5.3-Flash" && m.label.includes("暂不支持")), "start-plan available → 照常列出并带「暂不支持」提示");
  assert.ok(!refs.some((m) => m.id.startsWith("zai-start-plan/")), "zai-start-plan 未开通/无模型 → 不列");

  // 无注册表（headless 老机型）→ 回落固定词
  core.resetZcodeCatalogCacheForTests();
  writeFileSync(join(home, "v2", "config.json"), JSON.stringify({ provider: {} }));
  core.resetZcodeCatalogCacheForTests();
  const fallbackRefs = core.buildZcodeCatalogRefs();
  assert.ok(fallbackRefs.some((m) => m.label.endsWith("(bigmodel)")), "注册表缺失 → seed 通道，标签仍=通道 id 原样");
  core.resetZcodeCatalogCacheForTests();
  assert.ok(!refs.some((m) => m.id.startsWith("zai")), "未开通家族（zai 无 available 套餐）→ 不展示");
  assert.ok(!refs.some((m) => m.id === "bigmodel/GLM-5-Turbo"), "注册表权威：注册表已有的通道不再并入 seed 下架档位");
  // 通道独立展示（零归一化）：base / coding-plan 各自出条目，标签 = 通道 id 原样（start-plan 带提示）
  assert.ok(refs.some((m) => m.id === "bigmodel/GLM-5.3" && m.label === "GLM-5.3 (bigmodel)"), "base 通道：标签=通道 id 原样");
  assert.ok(refs.some((m) => m.id === "bigmodel-coding-plan/GLM-5.3" && m.label === "GLM-5.3 (bigmodel-coding-plan)"), "coding-plan 通道独立收录");
  const codingRef = refs.find((m) => m.id === "bigmodel/GLM-5.3");
  assert.ok(codingRef, "base 通道收录注册表模型");
  assert.ok(new Set(refs.map((m) => m.id)).size === refs.length, "目录无重复 ref");

  // seed 兜底：注册表缺该通道模型时并入静态 seed（headless 老机型）
  core.resetZcodeCatalogCacheForTests();
  writeFileSync(join(home, "v2", "config.json"), JSON.stringify({
    provider: { "builtin:bigmodel": { name: "Bigmodel - API Key", models: {} } },
  }));
  const refsSeed = core.buildZcodeCatalogRefs();
  assert.ok(refsSeed.some((m) => m.id === "bigmodel/GLM-5-Turbo"), "注册表无模型 → seed 兜底并入");

  // 恢复完整注册表（供下方 ref 解析/baseUrlFor 断言）
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

  // ref 解析：动态通道合法 + unknown 拒绝；baseUrlFor 注册表优先
  assert.deepEqual(core.parseModelRef("bigmodel-start-plan/GLM-5.3-Flash"), { providerId: "bigmodel-start-plan", modelId: "GLM-5.3-Flash" });
  assert.equal(core.parseModelRef("unknown-ch/m"), null);
  assert.equal(core.baseUrlFor("bigmodel-start-plan"), "https://zcode.z.ai/api/v1/zcode-plan/anthropic");

  // 默认通道家族裁决：仅 start-plan available（无可驱动通道）→ 回落家族（start-plan 本身不作默认，
  // 但同家族 base/coding-plan 可驱动——2026-09-14 修正，此前返回 null 会在只有 zai 套餐的机器上回落 bigmodel）
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
  // 真机 2026-09-15 形态：仅 start-plan available，coding-plan not_entitled（429/1113 死通道）
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: {
      "builtin:zai-start-plan": { status: "available" },
      "builtin:zai-coding-plan": { status: "unavailable", reason: "coding_plan_not_entitled" },
    } },
  }));
  core.resetZcodeCatalogCacheForTests();
  const refs = core.buildZcodeCatalogRefs();
  assert.ok(!refs.some((m) => m.id.startsWith("zai-coding-plan/")), "coding-plan 通道自身 unavailable → 不列（家族连带放行会种出选中即 1113 的死通道）");
  assert.ok(!refs.some((m) => m.id.startsWith("zai-start-plan/")), "start-plan 注册表无模型（models 空）→ 无条目");
  assert.ok(refs.some((m) => m.id === "zai/GLM-5.3"), "base 通道（不在套餐缓存）维持家族门：家族有 available 套餐 → 仍列");
  assert.equal(core.isChannelDriveable("zai-coding-plan"), false);
  assert.equal(core.isChannelDriveable("zai-start-plan"), false);
  assert.equal(core.isChannelDriveable("zai"), true);

  // 对照组：通道自身 available → 照常列出（通道级门不误伤可用通道）
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: {
      "builtin:zai-start-plan": { status: "available" },
      "builtin:zai-coding-plan": { status: "available" },
    } },
  }));
  core.resetZcodeCatalogCacheForTests();
  assert.ok(core.buildZcodeCatalogRefs().some((m) => m.id === "zai-coding-plan/GLM-5.3-Flash"), "通道自身 available → 照常列出");

  // 套餐缓存缺失（headless 老机型）→ null，调用方按旧家族逻辑裁决
  rmSync(join(home, "v2", "coding-plan-cache.json"));
  core.resetZcodeCatalogCacheForTests();
  assert.equal(core.isChannelDriveable("zai-coding-plan"), null);
  assert.equal(core.isChannelDriveable("zai"), null);

  // 缓存在但家族内零 available → 全部不可驱动（与目录为空一致）
  writeFileSync(join(home, "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: { "builtin:zai-coding-plan": { status: "unavailable", reason: "x" } } },
  }));
  core.resetZcodeCatalogCacheForTests();
  assert.equal(core.isChannelDriveable("zai-coding-plan"), false);
  assert.equal(core.isChannelDriveable("zai"), false, "base 通道家族门：家族无 available → false");

  rmSync(join(home, "v2"), { recursive: true, force: true });
  process.env.AITI_ZCODE_HOME = prevHome;
});

test("fetchCaptchaConfig：client/configs 三元组提取 + disabled/缺字段 → null", async () => {
  const okRes = { ok: true, json: async () => ({ data: { configs: { captcha: { enabled: true, prefix: "no8xfe", region: "cn", sceneId: "11xygtvd" } } } }) };
  assert.deepEqual(await core.fetchCaptchaConfig("jwt", async () => okRes), { sceneId: "11xygtvd", prefix: "no8xfe", region: "cn" });
  const disabled = { ok: true, json: async () => ({ data: { configs: { captcha: { enabled: false, prefix: "p", region: "cn", sceneId: "s" } } } }) };
  assert.equal(await core.fetchCaptchaConfig("jwt", async () => disabled), null, "enabled:false → null");
  const noScene = { ok: true, json: async () => ({ data: { configs: { captcha: { enabled: true, prefix: "p" } } } }) };
  assert.equal(await core.fetchCaptchaConfig("jwt", async () => noScene), null, "缺 sceneId → null");
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
  // 回归 2026-09-12 fix：旧逻辑查 oauth:${providerId}:access_token，coding-plan 通道拿不到 token；
  // 修复后 channelFamily 归并到 bigmodel，复用 family 的 OAuth token 换 key。
  core.resetZcodeCatalogCacheForTests();
  core.resetCredentialCacheForTests();
  const home = join(ROOT, "cred-plan");
  process.env.AITI_ZCODE_HOME = home;
  mkdirSync(join(home, "v2"), { recursive: true });
  const secret = core.deriveCredentialSecret();
  const credFile = join(home, "v2", "credentials.json");
  // 桌面端凭据按 family 存（无 bigmodel-coding-plan 专属 token）
  writeFileSync(credFile, JSON.stringify({ "oauth:bigmodel:access_token": encryptForTest("tok-plan", secret), "oauth:active_provider": "bigmodel" }));
  const configDir = cfgOf(join(ROOT, "cred-plan-data"));
  const stub = bigmodelFetchStub("tok-plan");
  const r = await core.ensureCredential({ providerId: "bigmodel-coding-plan", configDir, fetchImpl: stub.impl });
  assert.equal(r.apiKey, "0ab2a777.ox00kdXX");
  assert.equal(r.source, "fresh");
  assert.equal(stub.calls[0].auth, "tok-plan", "coding-plan 通道用 family(bigmodel) 的 OAuth token 换 key");
});

test("ensureCredential: coding-plan 跨家族无 token → 人话报错（不误取别家族）", async () => {
  core.resetZcodeCatalogCacheForTests();
  core.resetCredentialCacheForTests();
  const home = join(ROOT, "cred-plan-cross");
  process.env.AITI_ZCODE_HOME = home;
  mkdirSync(join(home, "v2"), { recursive: true });
  const secret = core.deriveCredentialSecret();
  const credFile = join(home, "v2", "credentials.json");
  // 已登录 bigmodel，但请求 zai-coding-plan（family=zai）→ 不误取 bigmodel 的 token
  writeFileSync(credFile, JSON.stringify({ "oauth:bigmodel:access_token": encryptForTest("tok-x", secret), "oauth:active_provider": "bigmodel" }));
  const configDir = cfgOf(join(ROOT, "cred-plan-cross-data"));
  await assert.rejects(
    core.ensureCredential({ providerId: "zai-coding-plan", configDir, fetchImpl: async () => { throw new Error("should not fetch"); } }),
    /已登录通道为 \[bigmodel\].*zai-coding-plan 不匹配/,
  );
});

// ============================================================================
// wire 契约：handle 每轮驱动（假 runtime 桩 + feature 桩 + override key）
// ============================================================================

const OK_SESSION = "sess_11111111-2222-3333-4444-555555555555";

/** 生成 runtime 桩：把 argv/关键 env dump 到 DUMP 文件，再打印 --json 形态输出。 */
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
    // pipe 写是异步的：必须等 flush 完再 exit，否则 stderr/stdout 被截断
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
    "zcode.transport": "oneshot", // handle wire 测试全部针对单发路径（app-server 通道见 zcode-appserver.test.mjs）
    ...features,
  };
  // 直接覆盖 featureValue（不展开旧对象——旧闭包会把 runtimePath 指到上一测试的桩）；
  // 仅保留 byId（回放测试用）
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
  assert.ok(registered, "provider 已注册");
  assert.equal(registered.agentKey, "zcode");
  assert.equal(registered.type, "zcode");
  const staticModels = await registered.listModels();
  assert.ok(staticModels.length > 0, "静态目录非空（目录随套餐可用性过滤，不钉具体档位——见动态目录用例）");
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
  assert.ok(handle.id.startsWith("zcode:new-"), `临时 id：${handle.id}`);
  assert.equal(handle.capabilities.steer, true); // v4 网关原生 steer（desktop 同款 sendText guide，真机实测）
  assert.equal(handle.capabilities.setModel, true);
  assert.equal(handle.model?.id, "bigmodel/GLM-5.3", "feature 默认模型种子");

  const events = [];
  handle.subscribe((e) => events.push(e));
  await handle.prompt("第一轮");

  // 换绑：session_backend_ready + id = zcode:sess_xxx
  const rebind = events.find((e) => e.type === "session_backend_ready");
  assert.ok(rebind, "session_backend_ready 事件");
  assert.equal(handle.id, `zcode:${OK_SESSION}`);
  assert.equal(rebind.oldId.startsWith("zcode:new-"), true);
  // 回答事件
  const upd = events.find((e) => e.type === "message_update");
  assert.equal(upd?.delta, "桩回答");
  // agent_start/agent_end 对（前端 spinner/收尾词汇；wire 层丢弃的是 turn_start/turn_end）
  const startIdx = events.findIndex((e) => e.type === "agent_start");
  const endIdx = events.findIndex((e) => e.type === "agent_end");
  const settleIdx = events.findIndex((e) => e.type === "agent_settled");
  assert.ok(startIdx >= 0, "agent_start 受理即发");
  assert.ok(endIdx > startIdx && settleIdx > endIdx, "agent_end → agent_settled 顺序");
  assert.ok(events.some((e) => e.type === "agent_settled" && e.stopReason === "end_turn"));
  // usage / context
  const usage = handle.getUsage();
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
  // spawn env/argv 治理面（桩 dump）：模型 ref + 官方端点 + override key + build 模式
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
  assert.ok(!dumped.argv.includes("--resume"), "首轮无 --resume");

  // 第二轮：--resume 真实 sess id（干净替换 featureValue，仅保留 byId）
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
  assert.ok(ri > 0, "第二轮带 --resume");
  assert.equal(dumped2.argv[ri + 1], OK_SESSION);
  assert.ok(!events2.some((e) => e.type === "session_backend_ready"), "已换绑不再重发");
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
  // runTurn 入口会先发 user 气泡 message_end（气泡落定）——error 帧按 stopReason 精确匹配
  const errEnd = events.find((e) => e.type === "message_end" && e.message?.stopReason === "error");
  assert.ok(errEnd, "message_end 错误帧");
  assert.match(errEnd.message.errorMessage, /身份验证失败/);
  assert.equal(errEnd.message.provider, "zcode");
  assert.ok(events.some((e) => e.type === "agent_settled_error"));
  const msgs = await handle.getMessages();
  assert.equal(msgs.at(-1).stopReason, "error", "错误帧进 liveHistory（重开可见）");
  assert.equal(handle.getContextUsage(), undefined, "失败轮无 usage");
  await handle.dispose();
});

test("handle wire: runtime 不可用 → fail-loud error 帧带指引", async () => {
  const { registered } = await setupExtension({ runtimeStub: "/nonexistent/runtime.cjs" });
  const handle = await registered.createSession({ cwd: ROOT });
  const events = [];
  handle.subscribe((e) => events.push(e));
  await handle.prompt("hi");
  const errEnd = events.find((e) => e.type === "message_end" && e.message?.stopReason === "error");
  assert.ok(errEnd?.message.errorMessage.includes("zcode.runtimePath") || /runtime/.test(errEnd.message.errorMessage), "人话报错");
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
  // 1) 目录：不再屏蔽，照常列出并带「暂不支持」提示
  const models = await registered.listModels();
  const sp = models.find((m) => m.id === "bigmodel-start-plan/GLM-5.3-Flash");
  assert.ok(sp, "start-plan 模型照常列出（不再排除）");
  assert.match(sp.label, /暂不支持/, "标签带「暂不支持」提示");
  assert.ok(!models.some((m) => m.id.startsWith("zai-start-plan/")), "zai-start-plan 无实据（套餐缓存无 available）→ 不列");
  // 2) 新建会话显式选 start-plan → 人话拒绝（用户点击即被告知）
  await assert.rejects(
    () => registered.createSession({ cwd: ROOT, model: { provider: "zcode", id: "bigmodel-start-plan/GLM-5.3-Flash" } }),
    /start-plan.*暂不支持/,
  );
  // 3) 运行中切换到 start-plan → 人话拒绝；从 start-plan 切走不拦
  const handle = await registered.createSession({ cwd: ROOT });
  await assert.rejects(
    () => handle.setModel({ id: "bigmodel-start-plan/GLM-5.3-Flash", provider: "zcode" }),
    /start-plan.*暂不支持/,
  );
  assert.ok(await handle.setModel({ id: "bigmodel/GLM-5.3", provider: "zcode" }), "切换到可用通道不拦");
  // 4) start-plan 已知会话（恢复路径语义：模型为 start-plan + 已绑定 sess id）→ 发消息直接人话失败
  // 4a) 恢复的 start-plan 会话即使其通道不在套餐缓存 available（如换套餐后）→ 选择器当前模型仍带提示（合成标签补位）
  handle.model = { id: "zai-start-plan/GLM-5.3-Flash", provider: "zcode" };
  const restoredList = await handle.getAvailableModels();
  const restoredCur = restoredList.find((m) => m.id === "zai-start-plan/GLM-5.3-Flash");
  assert.ok(restoredCur && /暂不支持/.test(restoredCur.label ?? ""), "恢复会话合成条目标签补「暂不支持」（zai-start-plan 不在 available）");
  // 4b) 发消息拦截（bigmodel-start-plan 已知会话 → 专用文案）
  handle.model = { id: "bigmodel-start-plan/GLM-5.3-Flash", provider: "zcode" };
  handle.setKnownSessionId("sess_startplan-1");
  const events = [];
  handle.subscribe((e) => events.push(e));
  await handle.prompt("开始");
  const errEnd = events.find((e) => e.type === "message_end" && e.message?.stopReason === "error");
  assert.ok(errEnd, "发消息人话失败（不 spawn runtime）");
  assert.match(errEnd.message.errorMessage, /start-plan/, "文案含 start-plan");
  assert.match(errEnd.message.errorMessage, /已知会话/, "已知会话专用文案（start 加载的已知会话）");
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
  assert.ok(ri > 0, "首轮即带 --resume（历史行）");
  assert.ok(!events.some((e) => e.type === "session_backend_ready"), "id 未变化无换绑");
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
  // per-agent last used（本文件先前用例写下的状态）会盖过 feature 空值种子——清掉以保证本用例
  // 只验证「套餐探测 → 默认 ref」；last-used 继承另有专项用例。
  rmSync(join(process.env.EXT_MODEL_STATE_DIR, "zcode"), { recursive: true, force: true });
  const stubDir = join(ROOT, "seed-stubs");
  mkdirSync(stubDir, { recursive: true });
  const stub = makeStub(stubDir, "ok.cjs", { session: "sess_seed-1" });
  const { registered } = await setupExtension({ runtimeStub: stub, features: { "zcode.model": "" } });
  const handle = await registered.createSession({ cwd: ROOT });
  assert.equal(handle.model?.id, "zai/GLM-5.3-Flash", "zai 套餐 → 默认 ref 跟随 zai 通道（模型=DEFAULT_MODEL_REF 的 Flash）");
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
  // 直接写一份「上次使用」状态文件（避开 persistModelState 的 fire-and-forget 竞态）
  const { writeExtModelState } = await import("../_shared/ext-model-state.ts");
  await writeExtModelState({
    agentKey: "zcode", sessionId: "zcode:prev-session",
    selected: { provider: "zcode", id: "zai/GLM-5.3-Flash" }, models: [], updatedAt: "",
  });
  const { registered } = await setupExtension({ runtimeStub: stub, features: { "zcode.model": "", "zcode.apiKeyOverride": "override.key" } });
  const handle = await registered.createSession({ cwd: ROOT });
  assert.equal(handle.model?.id, "zai/GLM-5.3-Flash", "新会话默认模型 = 该 agent 上次使用的模型");
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
  // mock services.sessions 出口（session-manager 的读取面）
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
  assert.equal(msgs.length, 2, "历史已回填 liveHistory");
  assert.equal(msgs[0].content[0].text, "历史问题");
  assert.equal(msgs[1].content[0].text, "历史回答");
  // 消息级模型标签（前端 MessageView 渲染依赖 message.model + message.provider）；
  // 两字段原样透传源库 providerID/modelID，不归一不改写
  assert.equal(msgs[1].model, "GLM-5.3");
  assert.equal(msgs[1].provider, "bigmodel");
  assert.equal(msgs[0].model, undefined, "user 消息不带模型标签");
  // 继续聊：新轮消息追加在历史之后
  await handle.prompt("新问题");
  const msgs2 = await handle.getMessages();
  assert.equal(msgs2.length, 4);
  assert.equal(msgs2[3].content[0].text, "新轮回答");
  await handle.dispose();
  // 图片回放：images → content image block（前端 MessageView 原生渲染形状）
  globalThis.__piWebExt.byId = () => ({
    ext: { services: { sessions: { async parseSession() {
      return { meta: {}, messages: [
        { role: "user", text: "看这张图", images: [
          { mime: "image/png", filename: "截图.png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
        ] },
      ] };
    } } } },
  });
  // 会话真实模型恢复：meta.model（状态文件无该会话记录时生效）
  assert.equal(handle.getModel()?.id, "zai/GLM-5.3-Flash", "回放恢复会话模型");
  const h3 = await registered.createSession({ cwd: ROOT, sessionId: "sess_replay-3" });
  const msgs3 = await h3.getMessages();
  assert.equal(msgs3.length, 1);
  assert.equal(msgs3[0].content.length, 2, "text + image 两块");
  assert.deepEqual(msgs3[0].content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });
  await h3.dispose();
  // 缺席 fail-silent：byId 无 session-manager → 不回放但不报错
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
  // 慢桩：首轮 800ms（给排队留窗口），回答文本含模式以区分轮次
  const slow = join(stubDir, "slow.cjs");
  writeFileSync(slow, `#!/usr/bin/env node
process.on("uncaughtException", (e) => require("node:fs").writeFileSync("/tmp/q-crash.log", String(e.stack ?? e)));
process.on("unhandledRejection", (e) => require("node:fs").writeFileSync("/tmp/q-crash.log", "rejection: " + String(e)));
const args = process.argv.slice(2);
const mode = args[args.indexOf("--mode") + 1];
setTimeout(() => {
  // 不加行尾换行——跨层转义易碎；parseTurnOutput 直接解析整段
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
  // 运行中再发两条 → 排队不报错
  await handle.prompt("第二轮(排队)");
  await handle.prompt("第三轮(排队)");
  assert.equal((await handle.getMessages()).filter((m) => m.role === "user").length, 1, "排队消息暂不进 liveHistory");
  await p1;
  // settle 后自动续轮：等待排队轮完成
  for (let i = 0; i < 40 && handle.isRunning(); i++) await new Promise((r) => setTimeout(r, 100));
  for (let i = 0; i < 40 && (await handle.getMessages()).filter((m) => m.role === "user").length < 3; i++) await new Promise((r) => setTimeout(r, 100));
  const msgs = await handle.getMessages();
  assert.equal(msgs.filter((m) => m.role === "user").length, 3, "排队消息全部落 liveHistory");
  assert.ok(events.some((e) => e.type === "queue_update" && e.followUp?.length === 2), "queue_update 同步排队区");
  // setPermissionMode：desiredMode 下轮生效
  assert.ok(await handle.setPermissionMode("plan"));
  await assert.rejects(() => handle.setPermissionMode("bogus"), /非法权限模式/);
  await handle.dispose();
});

test("handle wire: abort 杀当前轮子进程（settled 带非 end_turn）", async () => {
  const stubDir = join(ROOT, "abort-stubs");
  mkdirSync(stubDir, { recursive: true });
  // 慢桩：2 秒后才打印（给 abort 留窗口）
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
  assert.ok(Date.now() - t0 < 1500, "abort 后本轮很快 settle");
  const settled = events.find((e) => e.type === "agent_settled");
  assert.ok(settled, "有 settled 帧");
  assert.equal(settled.stopReason, "aborted", "SIGTERM → aborted（用户主动中止，非错误）");
  assert.ok(!events.some((e) => e.type === "message_update"), "被中止轮无回答");
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
  // 建最小 db：readZcodeSessionUpdatedMs 只查 session.time_updated（parse 由下方 mock 服务代偿）
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
  // parse 返回随「外部写入」推进：首阶段 1 条（seed），T2 后 2 条（重建）
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
  assert.equal((await handle.getMessages()).length, 1, "seed 历史 1 条");
  assert.equal(parseCalls, 1, "seed 时 parse 一次");

  // 水位未变 → 不重复 parse（零开销）
  assert.equal((await handle.getMessages()).length, 1);
  assert.equal(parseCalls, 1, "rev 不变不重读源");

  // 桌面端外部写入：db 水位前进 + 源新增一条 assistant
  writeTs("sess_ext-1", T2);
  extMessages = [
    { role: "user", text: "历史问题" },
    { role: "assistant", text: "历史回答", model: "GLM-5.3", provider: "bigmodel" },
  ];
  const msgs = await handle.getMessages();
  assert.equal(msgs.length, 2, "外部推进 → 重建为最新历史");
  assert.equal(msgs[1].content[0].text, "历史回答");
  assert.equal(parseCalls, 2, "推进才重读源一次");

  // 重建后水位已同步 → 再取不重读
  assert.equal((await handle.getMessages()).length, 2);
  assert.equal(parseCalls, 2);

  await handle.dispose();
  delete globalThis.__piWebExt.byId;
  process.env.AITI_ZCODE_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});
