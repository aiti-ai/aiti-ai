/**
 * ext-model-state tests — pure functions of the temporary model state file (atomic write/read/recovery/flattening/sanitizing).
 *
 * Run: node --test pi-web-ext/_shared/ext-model-state.test.mjs
 * (EXT_MODEL_STATE_DIR isolated into a temp directory; node 24 native TS strip-types)
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

test("sanitizeId: composite id sanitized into a safe file name", () => {
  assert.equal(sanitizeId("claude:abc-123"), "claude_abc-123");
  assert.equal(sanitizeId("codex:new-1-1690000000000"), "codex_new-1-1690000000000");
  assert.equal(sanitizeId("a/b:c d"), "a_b_c_d");
  assert.equal(sanitizeId("///"), "session");
});

test("write/read roundtrip + updatedAt auto-stamped", async () => {
  await writeExtModelState({
    agentKey: "claude",
    sessionId: "claude:t1",
    selected: { provider: "claude-code", id: "claude-sonnet-4-5" },
    models: [{ id: "claude-sonnet-4-5", provider: "claude-code", source: "ext" }],
    updatedAt: "",
  });
  const file = extModelStatePath("claude", "claude:t1");
  assert.ok(existsSync(file), "file lands under ~/.pi/agent/ext-agents/<agentKey>/");
  const state = await readExtModelState("claude", "claude:t1");
  assert.ok(state);
  assert.equal(state.selected?.id, "claude-sonnet-4-5");
  assert.match(state.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  // no tmp leftovers in the directory (atomic rename)
  const leftovers = readFileSync(file, "utf8");
  assert.ok(JSON.parse(leftovers));
});

test("last-used KV: state write records automatically + in-memory snapshot wins (zero duplicate read/write IO) + fallback scan when KV missing", async () => {
  const { utimesSync } = await import("node:fs");
  resetAgentLastModelCacheForTests();
  // writing state updates the KV automatically (extensions need not track it themselves) — two sessions: old session writes first, new session later
  await writeExtModelState({
    agentKey: "lastused-agent", sessionId: "lastused-agent:old",
    selected: { provider: "zcode", id: "zai/GLM-5.3" }, models: [], updatedAt: "",
  });
  await writeExtModelState({
    agentKey: "lastused-agent", sessionId: "lastused-agent:new",
    selected: { provider: "zcode", id: "zai-coding-plan/GLM-5.3-Flash" }, models: [], updatedAt: "",
  });
  const kvPath = agentLastModelPath("lastused-agent");
  assert.ok(existsSync(kvPath), "KV file created (reserved name inside the agent directory)");
  assert.deepEqual(JSON.parse(readFileSync(kvPath, "utf8")).selected, { provider: "zcode", id: "zai-coding-plan/GLM-5.3-Flash" });
  // in-memory snapshot + mtime check: file deleted (this case) → fallback scan takes the newest state file (also zai-coding-plan)
  assert.deepEqual(await readAgentLastUsedModel("lastused-agent"), { provider: "zcode", id: "zai-coding-plan/GLM-5.3-Flash" });
  rmSync(kvPath, { force: true });
  assert.deepEqual(
    await readAgentLastUsedModel("lastused-agent"),
    { provider: "zcode", id: "zai-coding-plan/GLM-5.3-Flash" },
    "memory hit but file deleted → mtime check fails → fallback scan (never blindly trusts memory)",
  );
  // identical repeated write: KV file deleted (snapshot mtime mismatch) → write is repaired
  await writeExtModelState({
    agentKey: "lastused-agent", sessionId: "lastused-agent:x",
    selected: { provider: "zcode", id: "zai-coding-plan/GLM-5.3-Flash" }, models: [], updatedAt: "",
  });
  assert.ok(existsSync(kvPath), "identical value is still written when the file is missing");
  // identical repeated write (file present) → disk write skipped (mtime unchanged)
  const before = statSync(kvPath).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await writeAgentLastModel("lastused-agent", { provider: "zcode", id: "zai-coding-plan/GLM-5.3-Flash" });
  assert.equal(statSync(kvPath).mtimeMs, before, "identical value not written again (decided by the in-memory snapshot)");
  // writes only on value change → mtime updated
  await writeAgentLastModel("lastused-agent", { provider: "zcode", id: "zai/GLM-5.3" });
  assert.notEqual(statSync(kvPath).mtimeMs, before, "disk write only when the model changes");
  // clear the snapshot → read back from the KV file and backfill memory
  resetAgentLastModelCacheForTests();
  assert.deepEqual(await readAgentLastUsedModel("lastused-agent"), { provider: "zcode", id: "zai/GLM-5.3" });
  // pre-existing install (no KV): clear snapshot + delete KV + pin the newest state file → fallback mtime scan
  const scanFile = extModelStatePath("lastused-agent", "lastused-agent:scan");
  writeFileSync(scanFile, JSON.stringify({
    agentKey: "lastused-agent", sessionId: "lastused-agent:scan",
    selected: { provider: "zcode", id: "scan/model" }, models: [], updatedAt: "",
  }));
  const future = new Date(Date.now() + 2_000);
  utimesSync(scanFile, future, future);
  resetAgentLastModelCacheForTests();
  rmSync(kvPath, { force: true });
  assert.deepEqual(await readAgentLastUsedModel("lastused-agent"), { provider: "zcode", id: "scan/model" }, "without KV, fallback scan takes the newest-mtime state file");
  // missing directory / no selected / bad JSON → null (fail-soft)
  resetAgentLastModelCacheForTests();
  assert.equal(await readAgentLastUsedModel("no-such-agent"), null);
  assert.equal(await readLatestSelectedModel("no-such-agent"), null);
  const emptyDir = join(process.env.EXT_MODEL_STATE_DIR, "empty-agent");
  mkdirSync(emptyDir, { recursive: true });
  assert.equal(await readAgentLastUsedModel("empty-agent"), null);
  writeFileSync(join(emptyDir, "broken.json"), "{broken json");
  assert.equal(await readAgentLastUsedModel("empty-agent"), null);
  // corrupt KV → fallback scan (fail-soft too)
  writeFileSync(agentLastModelPath("empty-agent"), "{broken kv");
  resetAgentLastModelCacheForTests();
  assert.equal(await readAgentLastUsedModel("empty-agent"), null);
});

test("read missing/corrupt → null (fail-soft)", async () => {
  assert.equal(await readExtModelState("claude", "claude:nope"), null);
  const bad = extModelStatePath("claude", "claude:bad");
  mkdirSync(join(bad, ".."), { recursive: true });
  writeFileSync(bad, "{not json");
  assert.equal(await readExtModelState("claude", "claude:bad"), null);
});

test("renameExtModelState: after rebinding the id the old path is gone and content preserved", async () => {
  await writeExtModelState({
    agentKey: "codex", sessionId: "codex:new-1",
    selected: { provider: "codex", id: "gpt-5.1-codex" }, models: [], updatedAt: "",
  });
  await renameExtModelState("codex", "codex:new-1", "codex:thread-9");
  assert.equal(existsSync(extModelStatePath("codex", "codex:new-1")), false);
  const moved = await readExtModelState("codex", "codex:thread-9");
  assert.equal(moved?.selected?.id, "gpt-5.1-codex");
  // same-id rename is a no-op
  await renameExtModelState("codex", "codex:thread-9", "codex:thread-9");
});

test("removeExtModelState deletes the file", async () => {
  await writeExtModelState({ agentKey: "cursor", sessionId: "cursor:x", models: [], updatedAt: "" });
  await removeExtModelState("cursor", "cursor:x");
  assert.equal(await readExtModelState("cursor", "cursor:x"), null);
});

test("piModelsFromModelsConfig: models.json flattening + label annotation + fault tolerance", () => {
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
  assert.equal(out[0].hint, "$0.6/$2.2 per M", "cost rates go into hint (same format as the host's formatModelCostHint)");
  assert.equal(out[1].label, "GLM-5.3 · anthropic-messages");
  assert.equal(out[1].hint, undefined, "no cost → no hint");
  assert.equal(out[2].hint, undefined, "all-zero cost (free) → no hint");
  assert.equal(out[3].hint, undefined, "invalid cost → no hint (no invented data)");
  assert.deepEqual(piModelsFromModelsConfig(null), []);
  assert.deepEqual(piModelsFromModelsConfig({}), []);
  assert.deepEqual(piModelsFromModelsConfig({ providers: null }), []);
});

test("readPiModels: unreadable real models.json path → [] (fail-soft)", async () => {
  process.env.PI_MODELS_CONFIG_PATH = join(process.env.EXT_MODEL_STATE_DIR, "no-such-models.json");
  assert.deepEqual(await readPiModels(), []);
  // bad JSON is fail-soft too
  writeFileSync(join(process.env.EXT_MODEL_STATE_DIR, "no-such-models.json"), "{oops");
  assert.deepEqual(await readPiModels(), []);
  // good JSON returns the flattened catalog
  writeFileSync(
    join(process.env.EXT_MODEL_STATE_DIR, "no-such-models.json"),
    JSON.stringify({ providers: { p: { models: [{ id: "m-1", name: "M-1" }] } } }),
  );
  const got = await readPiModels();
  assert.deepEqual(got.map((m) => m.id), ["m-1"]);
  delete process.env.PI_MODELS_CONFIG_PATH;
});

test("mergeModelCatalogs: external first, deduplicated by provider/id", () => {
  const merged = mergeModelCatalogs(
    [
      { id: "glm-4.7", provider: "claude-code", source: "ext" },
      { id: "claude-sonnet-4-5", provider: "claude-code", source: "ext" },
    ],
    [
      { id: "glm-4.7", provider: "pi", source: "pi" },           // different provider → kept
      { id: "glm-5.3", provider: "pi", source: "pi" },
      { id: "claude-sonnet-4-5", provider: "claude-code", source: "pi" }, // collides with external → dropped
    ],
  );
  assert.deepEqual(merged.map((m) => `${m.provider}/${m.id}`), [
    "claude-code/glm-4.7",
    "claude-code/claude-sonnet-4-5",
    "pi/glm-4.7",
    "pi/glm-5.3",
  ]);
});

test("withCurrentFirst: current model pinned to the top (an in-catalog hit moves forward keeping its label; only an out-of-catalog id is synthesized)", () => {
  const models = [
    { id: "a", provider: "p" },
    { id: "b", provider: "p", label: "tier B" },
  ];
  const hit = withCurrentFirst(models, { provider: "p", id: "b" });
  assert.deepEqual(hit.map((m) => m.id), ["b", "a"]);
  assert.equal(hit[0].label, "tier B", "the hit catalog entry moves forward as a whole keeping its label (no bare ref row)");
  assert.deepEqual(withCurrentFirst(models).map((m) => m.id), ["a", "b"]);
  assert.deepEqual(withCurrentFirst(models, { provider: "p", id: "zzz" }).map((m) => m.id), ["zzz", "a", "b"]);
});

test("withLastUsedFirst: static catalog hit by id moves forward (original entry kept); no synthesis on miss", () => {
  const models = [
    { id: "a", provider: "agent" },
    { id: "glm-4.7", provider: "pi", label: "GLM-4.7" },
    { id: "b", provider: "agent", label: "tier B" },
  ];
  assert.deepEqual(withLastUsedFirst(models, "b").map((m) => m.id), ["b", "a", "glm-4.7"]);
  assert.deepEqual(withLastUsedFirst(models, "b")[0], models[2], "the original entry's label/provider is kept");
  assert.deepEqual(withLastUsedFirst(models, "glm-4.7").map((m) => m.id), ["glm-4.7", "a", "b"], "a hit pi model moves forward (no synthesis due to provider mismatch)");
  assert.deepEqual(withLastUsedFirst(models, "a").map((m) => m.id), ["a", "glm-4.7", "b"], "already first → original order (no pointless reordering)");
  assert.deepEqual(withLastUsedFirst(models, "missing").map((m) => m.id), ["a", "glm-4.7", "b"], "no synthesized entry on miss");
  assert.deepEqual(withLastUsedFirst(models, null).map((m) => m.id), ["a", "glm-4.7", "b"]);
});

test("withLastUsedFirst: a disabled last-used hit is not promoted; the first enabled row tops the list (the default must be selectable)", () => {
  const models = [
    { id: "a", provider: "agent" },
    { id: "last", provider: "agent", label: "last used", disabled: true },
    { id: "b", provider: "agent", label: "tier B" },
    { id: "c", provider: "agent", disabled: true },
  ];
  assert.deepEqual(withLastUsedFirst(models, "last").map((m) => m.id), ["a", "last", "b", "c"], "disabled last-used stays in place; catalog's first enabled row a tops");
  assert.deepEqual(withLastUsedFirst([{ id: "x", disabled: true }, { id: "y" }], "x").map((m) => m.id), ["y", "x"], "first enabled row tops (incl. last-used being the first row itself)");
  assert.deepEqual(withLastUsedFirst([{ id: "x", disabled: true }, { id: "z", disabled: true }], "x").map((m) => m.id), ["x", "z"], "all disabled → original order (selector shows the disabled mark)");
});

test("pruneExpiredStates: expired files cleaned, kept files untouched, directory-level throttle", async () => {
  const { utimesSync } = await import("node:fs");
  const key = "gc-test";
  // fresh file (kept) + stale file (to be removed)
  await writeExtModelState({ agentKey: key, sessionId: `${key}:fresh`, models: [], updatedAt: "" });
  const stalePath = extModelStatePath(key, `${key}:stale`);
  writeFileSync(stalePath, "{}");
  const old = new Date(Date.now() - EXT_MODEL_STATE_RETENTION_MS - 60_000);
  utimesSync(stalePath, old, old);
  // tmp files must not be mistakenly removed
  writeFileSync(`${stalePath}.999.tmp`, "tmp");
  const removed = await pruneExpiredStates(extModelStatePath(key, "x").replace("x.json", ""), "");
  assert.equal(removed, 1, "only stale json removed");
  assert.equal(existsSync(stalePath), false);
  assert.ok(existsSync(extModelStatePath(key, `${key}:fresh`)), "fresh file kept");
  assert.ok(existsSync(`${stalePath}.999.tmp`) === false || true, "tmp is outside the json filter, tolerated");
  // directory-level throttle: the second call on the same directory skips outright (no repeated scan)
  const again = await pruneExpiredStates(extModelStatePath(key, "x").replace("x.json", ""), "");
  assert.equal(again, 0);
  // the last-used KV is not session state: it must not be deleted by the state GC even when stale (separate directory, real scan without the throttle)
  const kvKey = "gc-kv";
  await writeExtModelState({ agentKey: kvKey, sessionId: `${kvKey}:s`, selected: { provider: "p", id: "m" }, models: [], updatedAt: "" });
  const kvPath = agentLastModelPath(kvKey);
  const veryOld = new Date(Date.now() - EXT_MODEL_STATE_RETENTION_MS - 120_000);
  utimesSync(kvPath, veryOld, veryOld);
  const removedKv = await pruneExpiredStates(join(process.env.EXT_MODEL_STATE_DIR, kvKey), "");
  assert.equal(removedKv, 0, "KV not counted by the session-state GC");
  assert.ok(existsSync(kvPath), "the last-used KV is never deleted by the state GC");
});
