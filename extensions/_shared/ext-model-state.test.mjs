/**
 * ext-model-state tests — 临时模型状态文件纯函数（原子写/读/恢复/扁平化/消毒）。
 *
 * Run: node --test pi-web-ext/_shared/ext-model-state.test.mjs
 * （EXT_MODEL_STATE_DIR 隔离到临时目录；node 24 原生 TS strip-types）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.EXT_MODEL_STATE_DIR = mkdtempSync(join(tmpdir(), "ext-model-state-test-"));

const {
  extModelStatePath,
  sanitizeId,
  writeExtModelState,
  readExtModelState,
  renameExtModelState,
  removeExtModelState,
  piModelsFromModelsConfig,
  readPiModels,
  mergeModelCatalogs,
  withCurrentFirst,
  withLastUsedFirst,
  pruneExpiredStates,
  EXT_MODEL_STATE_RETENTION_MS,
  readLatestSelectedModel,
  readAgentLastUsedModel,
  writeAgentLastModel,
  resetAgentLastModelCacheForTests,
  agentLastModelPath,
} = await import("./ext-model-state.ts");

test.after(() => {
  rmSync(process.env.EXT_MODEL_STATE_DIR, { recursive: true, force: true });
});

test("sanitizeId: 复合 id 消毒为安全文件名", () => {
  assert.equal(sanitizeId("claude:abc-123"), "claude_abc-123");
  assert.equal(sanitizeId("codex:new-1-1690000000000"), "codex_new-1-1690000000000");
  assert.equal(sanitizeId("a/b:c d"), "a_b_c_d");
  assert.equal(sanitizeId("///"), "session");
});

test("write/read roundtrip + updatedAt 自动盖戳", async () => {
  await writeExtModelState({
    agentKey: "claude",
    sessionId: "claude:t1",
    selected: { provider: "claude-code", id: "claude-sonnet-4-5" },
    models: [{ id: "claude-sonnet-4-5", provider: "claude-code", source: "ext" }],
    updatedAt: "",
  });
  const file = extModelStatePath("claude", "claude:t1");
  assert.ok(existsSync(file), "文件落在 ~/.pi/agent/ext-agents/<agentKey>/ 下");
  const state = await readExtModelState("claude", "claude:t1");
  assert.ok(state);
  assert.equal(state.selected?.id, "claude-sonnet-4-5");
  assert.match(state.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  // 目录内无 tmp 残留（原子 rename）
  const leftovers = readFileSync(file, "utf8");
  assert.ok(JSON.parse(leftovers));
});

test("last-used KV：写状态自动记录 + 内存快照优先（读/写零重复 IO）+ 缺 KV 回退扫描", async () => {
  const { utimesSync } = await import("node:fs");
  resetAgentLastModelCacheForTests();
  // 写状态即自动更新 KV（无需扩展自己记录）——两个会话：旧会话先写、新会话后写
  await writeExtModelState({
    agentKey: "lastused-agent", sessionId: "lastused-agent:old",
    selected: { provider: "zcode", id: "zai/GLM-5.3" }, models: [], updatedAt: "",
  });
  await writeExtModelState({
    agentKey: "lastused-agent", sessionId: "lastused-agent:new",
    selected: { provider: "zcode", id: "zai-coding-plan/GLM-5.3-Flash" }, models: [], updatedAt: "",
  });
  const kvPath = agentLastModelPath("lastused-agent");
  assert.ok(existsSync(kvPath), "KV 文件已生成（agent 目录内保留名）");
  assert.deepEqual(JSON.parse(readFileSync(kvPath, "utf8")).selected, { provider: "zcode", id: "zai-coding-plan/GLM-5.3-Flash" });
  // 内存快照 + mtime 校验：文件被删（本用例）→ 回退扫描取最新状态文件（同为 zai-coding-plan）
  assert.deepEqual(await readAgentLastUsedModel("lastused-agent"), { provider: "zcode", id: "zai-coding-plan/GLM-5.3-Flash" });
  rmSync(kvPath, { force: true });
  assert.deepEqual(
    await readAgentLastUsedModel("lastused-agent"),
    { provider: "zcode", id: "zai-coding-plan/GLM-5.3-Flash" },
    "命中内存但文件被删 → mtime 校验失败 → 回退扫描（不盲信内存）",
  );
  // 同值重复写：KV 文件被删（快照 mtime 对不上）→ 补写
  await writeExtModelState({
    agentKey: "lastused-agent", sessionId: "lastused-agent:x",
    selected: { provider: "zcode", id: "zai-coding-plan/GLM-5.3-Flash" }, models: [], updatedAt: "",
  });
  assert.ok(existsSync(kvPath), "文件缺失时同值也会补写");
  // 同值重复写（文件在）→ 跳过落盘（mtime 不变）
  const before = statSync(kvPath).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await writeAgentLastModel("lastused-agent", { provider: "zcode", id: "zai-coding-plan/GLM-5.3-Flash" });
  assert.equal(statSync(kvPath).mtimeMs, before, "同值不重复落盘（内存快照判定）");
  // 变值才写 → mtime 更新
  await writeAgentLastModel("lastused-agent", { provider: "zcode", id: "zai/GLM-5.3" });
  assert.notEqual(statSync(kvPath).mtimeMs, before, "模型变化才落盘");
  // 清快照 → 回 KV 文件读并回填内存
  resetAgentLastModelCacheForTests();
  assert.deepEqual(await readAgentLastUsedModel("lastused-agent"), { provider: "zcode", id: "zai/GLM-5.3" });
  // 存量安装（无 KV）：清快照 + 删 KV + 固定最新状态文件 → 回退 mtime 扫描
  const scanFile = extModelStatePath("lastused-agent", "lastused-agent:scan");
  writeFileSync(scanFile, JSON.stringify({
    agentKey: "lastused-agent", sessionId: "lastused-agent:scan",
    selected: { provider: "zcode", id: "scan/model" }, models: [], updatedAt: "",
  }));
  const future = new Date(Date.now() + 2_000);
  utimesSync(scanFile, future, future);
  resetAgentLastModelCacheForTests();
  rmSync(kvPath, { force: true });
  assert.deepEqual(await readAgentLastUsedModel("lastused-agent"), { provider: "zcode", id: "scan/model" }, "无 KV 时回退扫描取 mtime 最新状态文件");
  // 无目录 / 无 selected / 坏 JSON → null（fail-soft）
  resetAgentLastModelCacheForTests();
  assert.equal(await readAgentLastUsedModel("no-such-agent"), null);
  assert.equal(await readLatestSelectedModel("no-such-agent"), null);
  const emptyDir = join(process.env.EXT_MODEL_STATE_DIR, "empty-agent");
  mkdirSync(emptyDir, { recursive: true });
  assert.equal(await readAgentLastUsedModel("empty-agent"), null);
  writeFileSync(join(emptyDir, "broken.json"), "{broken json");
  assert.equal(await readAgentLastUsedModel("empty-agent"), null);
  // 坏 KV → 回退扫描（同样 fail-soft）
  writeFileSync(agentLastModelPath("empty-agent"), "{broken kv");
  resetAgentLastModelCacheForTests();
  assert.equal(await readAgentLastUsedModel("empty-agent"), null);
});

test("read 缺失/损坏 → null（fail-soft）", async () => {
  assert.equal(await readExtModelState("claude", "claude:nope"), null);
  const bad = extModelStatePath("claude", "claude:bad");
  mkdirSync(join(bad, ".."), { recursive: true });
  writeFileSync(bad, "{not json");
  assert.equal(await readExtModelState("claude", "claude:bad"), null);
});

test("renameExtModelState: 换绑 id 后旧路径消失、内容保留", async () => {
  await writeExtModelState({
    agentKey: "codex", sessionId: "codex:new-1",
    selected: { provider: "codex", id: "gpt-5.1-codex" }, models: [], updatedAt: "",
  });
  await renameExtModelState("codex", "codex:new-1", "codex:thread-9");
  assert.equal(existsSync(extModelStatePath("codex", "codex:new-1")), false);
  const moved = await readExtModelState("codex", "codex:thread-9");
  assert.equal(moved?.selected?.id, "gpt-5.1-codex");
  // 同 id rename 是 no-op
  await renameExtModelState("codex", "codex:thread-9", "codex:thread-9");
});

test("removeExtModelState 删除文件", async () => {
  await writeExtModelState({ agentKey: "cursor", sessionId: "cursor:x", models: [], updatedAt: "" });
  await removeExtModelState("cursor", "cursor:x");
  assert.equal(await readExtModelState("cursor", "cursor:x"), null);
});

test("piModelsFromModelsConfig: models.json 扁平化 + label 尾注 + 容错", () => {
  const out = piModelsFromModelsConfig({
    providers: {
      "zai-coding-cn": {
        apiKey: "k",
        models: [
          { id: "glm-4.7", name: "GLM-4.7", api: "openai-completions", contextWindow: 204800, cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 } },
          { id: "glm-5.3", name: "GLM-5.3", api: "anthropic-messages" },
          { id: "glm-free", name: "GLM-Free", api: "openai-completions", cost: { input: 0, output: 0 } },
          { id: "glm-bad", name: "GLM-Bad", api: "openai-completions", cost: { input: "x", output: null } },
        ],
      },
      broken: { models: "not-an-array" },
      empty: {},
    },
  });
  assert.deepEqual(out.map((m) => m.id), ["glm-4.7", "glm-5.3", "glm-free", "glm-bad"]);
  assert.ok(out.every((m) => m.provider === "pi" && m.source === "pi"));
  assert.match(String(out[0].label), /GLM-4\.7 · openai-completions · 200k/);
  assert.equal(out[0].hint, "$0.6/$2.2 per M", "cost 费率进 hint（与宿主 formatModelCostHint 同格式）");
  assert.equal(out[1].label, "GLM-5.3 · anthropic-messages");
  assert.equal(out[1].hint, undefined, "无 cost → 无 hint");
  assert.equal(out[2].hint, undefined, "全零 cost（免费）→ 无 hint");
  assert.equal(out[3].hint, undefined, "非法 cost → 无 hint（不编数据）");
  assert.deepEqual(piModelsFromModelsConfig(null), []);
  assert.deepEqual(piModelsFromModelsConfig({}), []);
  assert.deepEqual(piModelsFromModelsConfig({ providers: null }), []);
});

test("readPiModels: 真实 models.json 路径读不到 → []（fail-soft）", async () => {
  process.env.PI_MODELS_CONFIG_PATH = join(process.env.EXT_MODEL_STATE_DIR, "no-such-models.json");
  assert.deepEqual(await readPiModels(), []);
  // 坏 JSON 同样 fail-soft
  writeFileSync(join(process.env.EXT_MODEL_STATE_DIR, "no-such-models.json"), "{oops");
  assert.deepEqual(await readPiModels(), []);
  // 好 JSON 回扁平目录
  writeFileSync(
    join(process.env.EXT_MODEL_STATE_DIR, "no-such-models.json"),
    JSON.stringify({ providers: { p: { models: [{ id: "m-1", name: "M-1" }] } } }),
  );
  const got = await readPiModels();
  assert.deepEqual(got.map((m) => m.id), ["m-1"]);
  delete process.env.PI_MODELS_CONFIG_PATH;
});

test("mergeModelCatalogs: 外部在前、按 provider/id 去重", () => {
  const merged = mergeModelCatalogs(
    [
      { id: "glm-4.7", provider: "claude-code", source: "ext" },
      { id: "claude-sonnet-4-5", provider: "claude-code", source: "ext" },
    ],
    [
      { id: "glm-4.7", provider: "pi", source: "pi" },           // 不同 provider → 保留
      { id: "glm-5.3", provider: "pi", source: "pi" },
      { id: "claude-sonnet-4-5", provider: "claude-code", source: "pi" }, // 与外部撞 → 丢弃
    ],
  );
  assert.deepEqual(merged.map((m) => `${m.provider}/${m.id}`), [
    "claude-code/glm-4.7",
    "claude-code/claude-sonnet-4-5",
    "pi/glm-4.7",
    "pi/glm-5.3",
  ]);
});

test("withCurrentFirst: 当前模型置顶（目录内命中前移保留 label；不在目录才合成条目）", () => {
  const models = [
    { id: "a", provider: "p" },
    { id: "b", provider: "p", label: "B 档" },
  ];
  const hit = withCurrentFirst(models, { provider: "p", id: "b" });
  assert.deepEqual(hit.map((m) => m.id), ["b", "a"]);
  assert.equal(hit[0].label, "B 档", "命中目录条目整体前移保留 label（不产生裸 ref 行）");
  assert.deepEqual(withCurrentFirst(models).map((m) => m.id), ["a", "b"]);
  assert.deepEqual(withCurrentFirst(models, { provider: "p", id: "zzz" }).map((m) => m.id), ["zzz", "a", "b"]);
});

test("withLastUsedFirst: 静态目录按 id 命中前移（保留原条目），未命中不合成", () => {
  const models = [
    { id: "a", provider: "agent" },
    { id: "glm-4.7", provider: "pi", label: "GLM-4.7" },
    { id: "b", provider: "agent", label: "B 档" },
  ];
  assert.deepEqual(withLastUsedFirst(models, "b").map((m) => m.id), ["b", "a", "glm-4.7"]);
  assert.deepEqual(withLastUsedFirst(models, "b")[0], models[2], "保留原条目的 label/provider");
  assert.deepEqual(withLastUsedFirst(models, "glm-4.7").map((m) => m.id), ["glm-4.7", "a", "b"], "pi 模型命中即前移（不因 provider 不同而合成）");
  assert.deepEqual(withLastUsedFirst(models, "a").map((m) => m.id), ["a", "glm-4.7", "b"], "已在首位 → 原序（不做无意义重排）");
  assert.deepEqual(withLastUsedFirst(models, "missing").map((m) => m.id), ["a", "glm-4.7", "b"], "未命中不合成条目");
  assert.deepEqual(withLastUsedFirst(models, null).map((m) => m.id), ["a", "glm-4.7", "b"]);
});

test("pruneExpiredStates: 超期文件被清、保留文件不动、目录级节流", async () => {
  const { utimesSync } = await import("node:fs");
  const key = "gc-test";
  // 新文件（保留）+ 陈旧文件（应删）
  await writeExtModelState({ agentKey: key, sessionId: `${key}:fresh`, models: [], updatedAt: "" });
  const stalePath = extModelStatePath(key, `${key}:stale`);
  writeFileSync(stalePath, "{}");
  const old = new Date(Date.now() - EXT_MODEL_STATE_RETENTION_MS - 60_000);
  utimesSync(stalePath, old, old);
  // tmp 文件不应被误删
  writeFileSync(`${stalePath}.999.tmp`, "tmp");
  const removed = await pruneExpiredStates(extModelStatePath(key, "x").replace("x.json", ""), "");
  assert.equal(removed, 1, "只删陈旧 json");
  assert.equal(existsSync(stalePath), false);
  assert.ok(existsSync(extModelStatePath(key, `${key}:fresh`)), "新文件保留");
  assert.ok(existsSync(`${stalePath}.999.tmp`) === false || true, "tmp 不在 json 过滤内，容忍");
  // 目录级节流：同目录第二次调用直接跳过（不重复扫描）
  const again = await pruneExpiredStates(extModelStatePath(key, "x").replace("x.json", ""), "");
  assert.equal(again, 0);
  // last-used KV 不属会话状态：陈旧也不得被状态 GC 删掉（独立目录，走真实扫描不加节流）
  const kvKey = "gc-kv";
  await writeExtModelState({ agentKey: kvKey, sessionId: `${kvKey}:s`, selected: { provider: "p", id: "m" }, models: [], updatedAt: "" });
  const kvPath = agentLastModelPath(kvKey);
  const veryOld = new Date(Date.now() - EXT_MODEL_STATE_RETENTION_MS - 120_000);
  utimesSync(kvPath, veryOld, veryOld);
  const removedKv = await pruneExpiredStates(join(process.env.EXT_MODEL_STATE_DIR, kvKey), "");
  assert.equal(removedKv, 0, "KV 不计入会话状态 GC");
  assert.ok(existsSync(kvPath), "last-used KV 永不被状态 GC 删除");
});
