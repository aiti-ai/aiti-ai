import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile(
  "useAgentSession.ts",
  await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const nodes = [];
function visit(node) {
  nodes.push(node);
  ts.forEachChild(node, visit);
}
visit(source);
const loader = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "loadModels");
// loadModels now delegates the "response -> state" mapping to applyModelsResponse (shared by
// cache replay and network results); the sandbox likewise extracts its function body and
// evaluates it on the same context as loadModels (free variables = setters/refs).
const applyDecl = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "applyModelsResponse");
const schedule = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "MODELS_RETRY_DELAYS_MS");
// loadModels now issues requests via the module-level fetchModelsShared (load-window
// coalescing) -- the sandbox must inject it together with its dependencies (the shared
// Map / TTL); each setup gets a fresh Map so tests stay isolated.
const sharedFn = nodes.find((node) => ts.isFunctionDeclaration(node) && node.name?.getText(source) === "fetchModelsShared");
const sharedMapDecl = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "modelsShared");
const sharedTtlDecl = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "MODELS_SHARED_TTL_MS");
const effect = nodes.find((node) => ts.isCallExpression(node)
  && node.expression.getText(source) === "useEffect"
  && node.arguments[1]?.getText(source) === "[loadModels, modelsRefreshKey]");
const retry = effect.arguments[0].body.statements.find(ts.isExpressionStatement).expression;
function script(text) {
  return new Script(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
}
const loadScript = script(`(${loader.initializer.arguments[0].getText(source)})`);
const applyScript = applyDecl ? script(`(${applyDecl.initializer.arguments[0].getText(source)})`) : null;
const retryScript = script(retry.getText(source));

function setup(fetchImpl, opts = {}) {
  const writes = [];
  const delays = [];
  const context = {
    Error, DOMException,
    controller: new AbortController(),
    newSessionCwd: "/project", session: null, isNew: true, newSessionBackend: null,
    sessionIdRef: { current: null }, thinkingLevelOverrideRef: { current: null }, newSessionModelOverrideRef: { current: null },
    // The fork wraps API addresses for sub-path deployments (/dev prefix) with apiUrl(); inside the sandbox it passes through.
    apiUrl: (path) => path,
    thinkingLevelPinsRef: { current: {} }, defaultThinkingLevelRef: { current: null },
    asConcreteThinkingLevel: (value) => (!value || value === "auto" ? null : value),
    fetch: fetchImpl,
    delay: async (ms) => { delays.push(ms); },
  };
  // These snippets must be evaluated on the **same context object**: free variables of the
  // function closures resolve against the context they were created in -- evaluating them
  // on a fresh empty context fails with "modelsShared is not defined".
  context.MODELS_RETRY_DELAYS_MS = script(schedule.initializer.getText(source)).runInNewContext(context);
  context.modelsShared = script(`(${sharedMapDecl.initializer.getText(source)})`).runInNewContext(context);
  context.MODELS_SHARED_TTL_MS = script(`(${sharedTtlDecl.initializer.getText(source)})`).runInNewContext(context);
  context.fetchModelsShared = script(`(${sharedFn.getText(source)})`).runInNewContext(context);
  for (const name of ["ModelError", "ModelNames", "ModelScopeWarnings", "ModelThinkingLevels", "ModelThinkingLevelMaps", "ModelList", "NewSessionDefaultModel", "NewSessionDefaultThinkingLevel", "SavedDefaultThinkingLevel", "NewSessionModel"]) {
    context[`set${name}`] = (value) => writes.push([name, value]);
  }
  // Client-side cache layer: by default no cache hits / no writes (existing tests unaffected);
  // tests can inject hit/write probes.
  context.readCachedModels = opts.readCachedModels ?? (() => null);
  context.writeCachedModels = opts.writeCachedModels ?? (() => {});
  if (applyScript) context.applyModelsResponse = applyScript.runInNewContext(context);
  context.loadModels = loadScript.runInNewContext(context);
  return { context, writes, delays, run: () => retryScript.runInNewContext(context) };
}

test("cached models render before the network response arrives", async () => {
  const cached = {
    models: { "custom:cached": "Cached" },
    modelList: [{ id: "cached", name: "Cached", provider: "custom" }],
    defaultModel: { provider: "custom", modelId: "cached" },
  };
  const cachedWrites = [];
  const reads = [];
  const state = setup(async () => Response.json({
    models: { "custom:net": "Net" },
    modelList: [{ id: "net", name: "Net", provider: "custom" }],
  }), {
    readCachedModels: (cwd) => { reads.push(cwd); return cached; },
    writeCachedModels: (cwd, data) => { cachedWrites.push({ cwd, data }); },
  });
  await state.run();
  // Same cwd: cache is replayed first, then overwritten once the network result arrives
  const listWrites = state.writes.filter(([name]) => name === "ModelList").map(([, value]) => value[0]?.name);
  assert.deepEqual(listWrites, ["Cached", "Net"]);
  assert.deepEqual(reads, ["/project"]);
  assert.equal(cachedWrites.length, 1);
  assert.equal(cachedWrites[0].cwd, "/project");
  assert.equal(cachedWrites[0].data.modelList[0].name, "Net");
  // The cached default model also takes effect before the network response arrives
  assert.ok(state.writes.some(([name, value]) => name === "NewSessionDefaultModel" && value?.modelId === "cached"));
});

test("cached models stay visible when every refresh attempt fails", async () => {
  const cached = { models: { "custom:cached": "Cached" }, modelList: [{ id: "cached", name: "Cached", provider: "custom" }] };
  const state = setup(async () => { throw new TypeError("Failed to fetch"); }, {
    readCachedModels: () => cached,
  });
  await state.run();
  assert.ok(state.writes.some(([name, value]) => name === "ModelList" && value[0]?.name === "Cached"));
  // Cache replay writes ModelError=null once first (nothing to show yet), then each failure records the error
  const errors = state.writes.filter(([name]) => name === "ModelError").map(([, value]) => value).filter(Boolean);
  assert.deepEqual(errors, ["Failed to fetch", "Failed to fetch", "Failed to fetch", "Failed to fetch"]);
});

test("model-load failures stay visible through bounded retries and clear on recovery", async () => {
  for (const [fetchImpl, expected] of [
    [async () => { throw new TypeError("Failed to fetch"); }, "Failed to fetch"],
    [async () => Response.json({ error: "Access denied" }, { status: 403 }), "Access denied"],
    [async () => new Response("Unavailable", { status: 503 }), "Failed to load models (HTTP 503)"],
    [async () => ({ ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } }), "Invalid JSON"],
  ]) {
    const state = setup(fetchImpl);
    await state.run();
    assert.deepEqual(state.delays, [2_000, 5_000, 10_000]);
    assert.deepEqual(state.writes, Array.from({ length: 4 }, () => ["ModelError", expected]));
  }

  let attempts = 0;
  const recovered = setup(async () => {
    if (++attempts === 1) throw new TypeError("Failed to fetch");
    return Response.json({
      models: { "custom:test": "Test" },
      modelList: [{ provider: "custom", id: "test", name: "Test" }],
      defaultModel: { provider: "custom", modelId: "test" },
      thinkingLevelPins: { "custom/test": "high" },
    });
  });
  await recovered.run();
  assert.equal(attempts, 2);
  assert.deepEqual(recovered.delays, [2_000]);
  assert.deepEqual(recovered.writes.filter(([name]) => name === "ModelError"), [["ModelError", "Failed to fetch"], ["ModelError", null]]);
  assert.ok(recovered.writes.some(([name, value]) => name === "ModelList" && value[0].id === "test"));
  assert.ok(recovered.writes.some(([name, value]) => name === "NewSessionDefaultModel" && value.modelId === "test"));
  assert.ok(recovered.writes.some(([name, value]) => name === "NewSessionDefaultThinkingLevel" && value === "high"));
});

test("cancelling model loads prevents state writes and further retries", async () => {
  // The shared request no longer forwards the caller's signal (otherwise a caller that
  // unmounts first would tear down the shared request of other callers); caller abort
  // semantics are guaranteed by loadModels calling throwIfAborted after the result
  // returns -- so here the shared request returns normally and we assert zero writes/zero retries.
  for (const status of [200, 403]) {
    const reading = Promise.withResolvers();
    const release = Promise.withResolvers();
    const state = setup(async () => ({
      ok: status === 200, status,
      json: async () => { reading.resolve(); await release.promise; return { models: {}, modelList: [] }; },
    }));
    const completed = state.run();
    await reading.promise; // request is in flight
    state.context.controller.abort();
    release.resolve(); // release the shared request
    await completed;
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.delays, []);
  }

  const late = setup(async () => ({
    ok: true,
    json: async () => {
      late.context.controller.abort();
      return { models: {}, modelList: [] };
    },
  }));
  await late.run();
  assert.deepEqual(late.writes, []);

  let attempts = 0;
  const waiting = setup(async () => { attempts++; throw new TypeError("Failed to fetch"); });
  waiting.context.delay = async () => waiting.context.controller.abort();
  await waiting.run();
  assert.equal(attempts, 1);
});

test("a picked model the folder offers keeps its pinned reasoning level; one it does not list goes back to automatic", async () => {
  const catalog = {
    models: { "custom:test": "Test", "custom:fast": "Fast" },
    modelList: [{ provider: "custom", id: "test", name: "Test" }, { provider: "custom", id: "fast", name: "Fast" }],
    defaultModel: { provider: "custom", modelId: "test" },
    thinkingLevelPins: { "custom/test": "high", "custom/fast": "low" },
  };
  // Carried over from the composer this one replaced, and offered here.
  const offered = setup(async () => Response.json(catalog));
  const fast = { provider: "custom", modelId: "fast" };
  offered.context.newSessionModelOverrideRef.current = fast;
  await offered.run();
  assert.equal(offered.context.newSessionModelOverrideRef.current, fast);
  assert.ok(!offered.writes.some(([name]) => name === "NewSessionModel"));
  assert.ok(offered.writes.some(([name, value]) => name === "NewSessionDefaultThinkingLevel" && value === "low"));

  // A model another project scoped in that this one does not list.
  const missing = setup(async () => Response.json(catalog));
  missing.context.newSessionModelOverrideRef.current = { provider: "other", modelId: "gone" };
  await missing.run();
  assert.equal(missing.context.newSessionModelOverrideRef.current, null);
  assert.ok(missing.writes.some(([name, value]) => name === "NewSessionModel" && value === null));
  assert.ok(missing.writes.some(([name, value]) => name === "NewSessionDefaultThinkingLevel" && value === "high"));

  // A failed load answers 200 with no models (withSafeModelLoadFailure): nothing to compare with, the pick stays.
  const failed = setup(async () => Response.json({ models: {}, modelList: [], defaultModel: null, modelError: "Models could not be loaded" }));
  failed.context.newSessionModelOverrideRef.current = fast;
  await failed.run();
  assert.equal(failed.context.newSessionModelOverrideRef.current, fast);
  assert.ok(!failed.writes.some(([name]) => name === "NewSessionModel"));

  // Once the session exists it keeps whatever it was started with.
  const started = setup(async () => Response.json(catalog));
  started.context.sessionIdRef.current = "live";
  started.context.newSessionModelOverrideRef.current = { provider: "other", modelId: "gone" };
  await started.run();
  assert.deepEqual(started.context.newSessionModelOverrideRef.current, { provider: "other", modelId: "gone" });
});
