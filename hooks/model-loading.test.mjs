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
const schedule = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "MODELS_RETRY_DELAYS_MS");
// loadModels 现在经模块级 fetchModelsShared（加载窗口合流）发请求——
// 沙箱需要连同其依赖（缓存 Map / TTL）一起注入（每个 setup 一份新 Map，测试间隔离）。
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
const retryScript = script(retry.getText(source));

function setup(fetchImpl) {
  const writes = [];
  const delays = [];
  const context = {
    Error, DOMException,
    controller: new AbortController(),
    newSessionCwd: "/project", session: null, isNew: true, newSessionBackend: null,
    sessionIdRef: { current: null }, thinkingLevelOverrideRef: { current: null },
    // fork 用 apiUrl() 包装子路径部署（/dev 前缀）的 API 地址；沙盒内直通。
    apiUrl: (path) => path,
    fetch: fetchImpl,
    delay: async (ms) => { delays.push(ms); },
  };
  // 这些片段必须在**同一个 context 对象**上求值：函数闭包的自由变量按创建时的
  // context 解析——换成空 context 求值会报 “modelsShared is not defined”。
  context.MODELS_RETRY_DELAYS_MS = script(schedule.initializer.getText(source)).runInNewContext(context);
  context.modelsShared = script(`(${sharedMapDecl.initializer.getText(source)})`).runInNewContext(context);
  context.MODELS_SHARED_TTL_MS = script(`(${sharedTtlDecl.initializer.getText(source)})`).runInNewContext(context);
  context.fetchModelsShared = script(`(${sharedFn.getText(source)})`).runInNewContext(context);
  for (const name of ["ModelError", "ModelNames", "ModelScopeWarnings", "ModelThinkingLevels", "ModelThinkingLevelMaps", "ModelList", "NewSessionDefaultModel", "ThinkingLevel"]) {
    context[`set${name}`] = (value) => writes.push([name, value]);
  }
  context.loadModels = loadScript.runInNewContext(context);
  return { context, writes, delays, run: () => retryScript.runInNewContext(context) };
}

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
  assert.ok(recovered.writes.some(([name, value]) => name === "ThinkingLevel" && value === "high"));
});

test("cancelling model loads prevents state writes and further retries", async () => {
  // 共享请求不再透传调用方 signal（否则先卸载的调用方会拆掉其他调用方的共享请求）；
  // 调用方中止语义由 loadModels 在结果返回后 throwIfAborted 保证——故这里让共享请求
  // 照常返回，断言调用方零写入/零重试。
  for (const status of [200, 403]) {
    const reading = Promise.withResolvers();
    const release = Promise.withResolvers();
    const state = setup(async () => ({
      ok: status === 200, status,
      json: async () => { reading.resolve(); await release.promise; return { models: {}, modelList: [] }; },
    }));
    const completed = state.run();
    await reading.promise; // 请求已在飞
    state.context.controller.abort();
    release.resolve(); // 放行共享请求
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
