/**
 * aiti-qoder-agent — 模型身份与新建页默认项单测。
 *
 * 钉死两件事（bug：new session 的模型永远默认 auto）：
 *  1. qodercli 帧回报的是 display_name（"Qwen3.8-Flash"）而非目录 key（"qfmodel"）——
 *     persistModelState 写状态前必须归一，否则 last-used KV 是废值；
 *  2. 新建页默认项 = 宿主取静态目录 list[0]，所以 qoderStaticCatalog 必须把上次使用的
 *     模型置顶；老版本写下的 label 形态 KV 也要能命中（不再落回目录首行 auto）。
 *
 * Run: node scripts/test-web-ext.mjs --only aiti-qoder-agent
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const stateDir = mkdtempSync(join(tmpdir(), "qoder-model-state-"));
process.env.EXT_MODEL_STATE_DIR = stateDir;
// pi 目录恒空：只测外部（qoder）目录自身的排序
process.env.PI_MODELS_CONFIG_PATH = join(stateDir, "no-models.json");

const { QoderHandle, qoderStaticCatalog, resolveCatalogEntry } = await import("./index.ts");
const {
  readExtModelState, readAgentLastUsedModel, resetAgentLastModelCacheForTests,
} = await import("@aiti-ai/ext-shared/ext-model-state");

const STATE_KEY = "qoder-cn"; // variant "cn" 的状态命名空间（见 variants.ts）

function fakeClient() {
  return {
    listModels: async () => [
      { key: "auto", display_name: "Auto", enable: true },
      { key: "qmodel_38max", display_name: "Qwen3.8-Max", enable: true },
      { key: "qfmodel", display_name: "Qwen3.8-Flash", enable: true },
      { key: "hidden", display_name: "Hidden", enable: false },
    ],
  };
}

function makeHandle() {
  const stdout = new PassThrough();
  const child = {
    stdout,
    stderr: { on() {} },
    stdin: { write: () => true, writable: true, on() {} },
    once() {},
    kill() {},
    exitCode: null,
  };
  return new QoderHandle(`qodercn:sess-${Math.random().toString(36).slice(2)}`, child, fakeClient(), "/tmp", "cn");
}

function writeLastModelKV(selected) {
  const dir = join(stateDir, STATE_KEY);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "_last-model.json"), JSON.stringify({ agentKey: STATE_KEY, selected }));
  resetAgentLastModelCacheForTests();
}

test("resolveCatalogEntry: id 精确优先，label 大小写兜底，未命中返 null", () => {
  const models = [
    { id: "auto", provider: "qoder", label: "Auto", source: "ext" },
    { id: "qfmodel", provider: "qoder", label: "Qwen3.8-Flash", source: "ext" },
  ];
  assert.equal(resolveCatalogEntry(models, { id: "qfmodel" })?.label, "Qwen3.8-Flash", "id 命中");
  assert.equal(resolveCatalogEntry(models, { id: "Qwen3.8-Flash" })?.id, "qfmodel", "label 命中");
  assert.equal(resolveCatalogEntry(models, { id: "qwen3.8-flash" })?.id, "qfmodel", "label 大小写不敏感");
  assert.equal(resolveCatalogEntry(models, { id: "nope" }), null);
  assert.equal(resolveCatalogEntry(models, null), null);
});

test("persistModelState: CLI 回报 display_name 也写目录 key", async () => {
  resetAgentLastModelCacheForTests();
  const h = makeHandle();
  h.model = { id: "Qwen3.8-Flash", provider: "qoder" }; // trackModel 收到的原始帧值
  await h.persistModelState();
  assert.equal(h.model.id, "qfmodel", "当前模型归一到目录 key（provider 不变）");
  assert.equal(h.model.provider, "qoder");
  const st = await readExtModelState(STATE_KEY, h.id);
  assert.equal(st?.selected?.id, "qfmodel", "会话状态文件写归一后的 key");
  assert.equal((await readAgentLastUsedModel(STATE_KEY))?.id, "qfmodel", "agent 级 last-used KV 同步归一");
});

test("persistModelState: 目录外的模型名原样保留（不猜、不合成）", async () => {
  resetAgentLastModelCacheForTests();
  const h = makeHandle();
  h.model = { id: "Some-New-Model", provider: "qoder" };
  await h.persistModelState();
  assert.equal(h.model.id, "Some-New-Model", "目录未命中时保持原值");
  assert.equal((await readAgentLastUsedModel(STATE_KEY))?.id, "Some-New-Model");
});

test("qoderStaticCatalog: 上次使用的模型置顶（新建页默认项）", async () => {
  writeLastModelKV({ id: "qfmodel", provider: "qoder" });
  const list = await qoderStaticCatalog(fakeClient(), STATE_KEY);
  assert.deepEqual(list.map((m) => m.id), ["qfmodel", "auto", "qmodel_38max"], "置顶前移，禁用的不入目录");
});

test("qoderStaticCatalog: 存量 label 形态的 KV 同样置顶（老版本写坏的状态不再退化 auto）", async () => {
  writeLastModelKV({ id: "Qwen3.8-Flash", provider: "qoder" });
  const list = await qoderStaticCatalog(fakeClient(), STATE_KEY);
  assert.equal(list[0].id, "qfmodel", "默认项 = 上次使用的模型，而不是目录首行 auto");
});

test("qoderStaticCatalog: 无 last-used 时保持目录原序", async () => {
  rmSync(join(stateDir, STATE_KEY, "_last-model.json"), { force: true });
  resetAgentLastModelCacheForTests();
  const list = await qoderStaticCatalog(fakeClient(), STATE_KEY);
  assert.deepEqual(list.map((m) => m.id), ["auto", "qmodel_38max", "qfmodel"]);
});

test("qoderStaticCatalog: price_factor 映射为选择器 hint（尾零裁剪；非有限数/缺失不编数据）", async () => {
  rmSync(join(stateDir, STATE_KEY, "_last-model.json"), { force: true });
  resetAgentLastModelCacheForTests();
  const client = {
    listModels: async () => [
      { key: "auto", display_name: "Auto", enable: true, price_factor: 0.5 },
      { key: "promo", display_name: "Promo", enable: true, price_factor: 0.1, original_price_factor: 0.5 },
      { key: "one", display_name: "One", enable: true, price_factor: 1 },
      { key: "nofee", display_name: "NoFee", enable: true },
      { key: "bad", display_name: "Bad", enable: true, price_factor: "x" },
    ],
  };
  const list = await qoderStaticCatalog(client, STATE_KEY);
  const byId = Object.fromEntries(list.map((m) => [m.id, m]));
  assert.equal(byId.auto.hint, "0.5x");
  assert.equal(byId.promo.hint, "0.1x→0.5x", "限时降价附原价（现价→原价）");
  assert.equal(byId.one.hint, "1x");
  assert.equal(byId.nofee.hint, undefined);
  assert.equal(byId.bad.hint, undefined);
});

test.after(() => {
  rmSync(stateDir, { recursive: true, force: true });
});
