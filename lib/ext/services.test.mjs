/**
 * ExtServicesRegistry + ctx.services/ctx.features 接线单元测试（node --test）
 *
 * 覆盖（DI 方案 P0 验收）：provide/get、key 前缀校验（防冒充）、disposer 幂等与
 * 守卫、onChange up/down、require 事件驱动命中/等待/超时、revokeExt/clear 反卷、
 * status 服务清单、registry 接线（扩展 startup provide → get；reload 反卷再上线；
 * core.* 预置；features.get/on）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { ExtServicesRegistry, assertServiceKey } = await import("./services.ts");
const { ExtRegistryImpl } = await import("./registry.ts");

// ── 内核：provide / get ──────────────────────────────────────────────────────

test("provide/get 往返；缺席 undefined", () => {
  const r = new ExtServicesRegistry();
  assert.equal(r.get("a.svc"), undefined);
  const off = r.provide("a", "a.svc", { hello: 1 });
  assert.deepEqual(r.get("a.svc"), { hello: 1 });
  off();
  assert.equal(r.get("a.svc"), undefined);
});

test("key 前缀校验：冒充其他扩展 / core.* 均拒绝", () => {
  const r = new ExtServicesRegistry();
  assert.throws(() => r.provide("a", "b.svc", 1), /前缀/);
  assert.throws(() => r.provide("a", "core.sessions", 1), /前缀/);
  assert.throws(() => r.provide("a", "a", 1), /前缀/); // 缺 name 段
  assert.doesNotThrow(() => r.provide("core", "core.sessions", {}));
});

test("同 key 重复 provide：原扩展替换 impl，不重复发 up", () => {
  const r = new ExtServicesRegistry();
  const events = [];
  r.onChange((key, phase) => events.push(`${key}:${phase}`));
  const off1 = r.provide("a", "a.svc", 1);
  const off2 = r.provide("a", "a.svc", 2); // 同扩展重提供 = 替换（仍 up 态，不发 up/down）
  assert.equal(r.get("a.svc"), 2);
  assert.deepEqual(events, ["a.svc:up"]);
  off1(); // 旧注册的 disposer：impl 已被替换，守卫生效 → 不移除
  assert.equal(r.get("a.svc"), 2);
  assert.deepEqual(events, ["a.svc:up"]);
  off2(); // 当前注册的 disposer：正常移除 + down
  assert.equal(r.get("a.svc"), undefined);
  assert.deepEqual(events, ["a.svc:up", "a.svc:down"]);
});

test("disposer 幂等；down 只发一次", () => {
  const r = new ExtServicesRegistry();
  const events = [];
  r.onChange((key, phase) => events.push(phase));
  const off = r.provide("a", "a.svc", 1);
  off();
  off();
  assert.deepEqual(events, ["up", "down"]);
});

// ── 内核：onChange / require ────────────────────────────────────────────────

test("require：命中即返（事件驱动零等待）", async () => {
  const r = new ExtServicesRegistry();
  r.provide("a", "a.svc", "impl");
  assert.equal(await r.require("a.svc"), "impl");
});

test("require：未命中挂起，provide 时 resolve（非轮询）", async () => {
  const r = new ExtServicesRegistry();
  const p = r.require("a.svc", 1000);
  setTimeout(() => r.provide("a", "a.svc", "late"), 20);
  assert.equal(await p, "late");
});

test("require：超时拒绝（错误含 key 与超时时长）", async () => {
  const r = new ExtServicesRegistry();
  await assert.rejects(r.require("a.missing", 30), /a\.missing.*30ms/);
});

test("revokeExt 反卷 + clear + list（status 服务清单）", () => {
  const r = new ExtServicesRegistry();
  r.provide("a", "a.x", 1);
  r.provide("a", "a.y", 2);
  r.provide("b", "b.x", 3);
  r.provide("core", "core.sessions", {});
  const down = [];
  r.onChange((key, phase) => { if (phase === "down") down.push(key); });
  assert.deepEqual(r.list().sort((x, y) => x.key.localeCompare(y.key)), [
    { key: "a.x", extId: "a" }, { key: "a.y", extId: "a" },
    { key: "b.x", extId: "b" }, { key: "core.sessions", extId: "core" },
  ]);
  assert.deepEqual(r.revokeExt("a").sort(), ["a.x", "a.y"]);
  assert.equal(r.get("a.x"), undefined);
  assert.equal(r.get("b.x"), 3);
  assert.deepEqual(down.sort(), ["a.x", "a.y"]);
  r.clear();
  assert.deepEqual(r.list(), []);
  assert.equal(down.includes("b.x") && down.includes("core.sessions"), true);
});

// ── registry 接线：ctx.services / ctx.features / core.* / reload 反卷 ────────

const FAKE_CORE = {
  async listSessions() { return []; },
  async getRunningSessionIds() { return []; },
  async getHomeDir() { return "/home/test"; },
};

function writeExt(root, id, entry) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), entry);
  const clientDir = join(dir, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "demo.mjs"), "export default {}\n");
  return dir;
}

test("registry 接线：startup provide → services.get；features.get/on；reload 反卷再上线", async () => {
  const root = mkdtempSync(join(tmpdir(), "ext-services-"));
  try {
    writeExt(root, "provider", `
      export default {
        id: "provider", name: "P", version: "1.0.0", client: "client/demo.mjs",
        ui: { toolbar: [{ id: "t1", label: "T1" }] },
        features: [{ id: "gate", label: "G", type: "boolean", default: true }],
        server: {
          startup(ctx) {
            ctx.services.provide("provider.svc", { n: 42 });
            globalThis.__tFeaturesDefault = ctx.features.get("gate");            // 本扩展、缺省 true
            globalThis.__tFeaturesOther = ctx.features.get("provider", "gate");  // 显式 extId + fid
            globalThis.__tOff = ctx.features.on(() => { globalThis.__tFeatureChanged = (globalThis.__tFeatureChanged || 0) + 1; });
          },
          shutdown() {},
        },
      };
    `);
    writeExt(root, "consumer", `
      export default {
        id: "consumer", name: "C", version: "1.0.0", client: "client/demo.mjs",
        server: {
          startup(ctx) {
            globalThis.__tGotSvc = ctx.services.get("provider.svc") ?? null;
            globalThis.__tRequire = null;
            ctx.services.require("provider.svc", 1000).then((s) => { globalThis.__tRequire = s; });
            globalThis.__tServiceDowns = globalThis.__tServiceDowns || 0;
            ctx.services.onChange((key, phase) => { if (key === "provider.svc" && phase === "down") globalThis.__tServiceDowns += 1; });
          },
        },
      };
    `);

    delete globalThis.__tGotSvc;
    delete globalThis.__tRequire;
    delete globalThis.__tFeaturesDefault;
    delete globalThis.__tFeaturesOther;
    delete globalThis.__tFeatureChanged;
    delete globalThis.__tServiceDownSeen;

    const reg = new ExtRegistryImpl({
      core: FAKE_CORE,
      extensionsRootOverride: root,
      extraExtensionsRootsOverride: [],
      devExtensionsRootOverride: null,
      bundledExtensionsRootOverride: join(root, "_none"),
      dataRootOverride: join(root, "_data"),
    });

    await reg.loadAll();
    await reg.startAll();

    // core.* 预置 + 扩展服务都在清单里
    const keys = reg.services.list().map((s) => s.key);
    assert.equal(keys.includes("core.sessions"), true);
    assert.equal(keys.includes("core.registry"), true);
    assert.equal(keys.includes("provider.svc"), true);

    // 消费方启动序不确定（本测试里 consumer 按字母序先于 provider——方案 R2 现实）：
    // 软 get 在启动期可能缺席；require（事件等待）是启动期硬依赖的正解，provider
    // provide 后 waiter 被事件驱动 resolve。
    assert.equal(globalThis.__tGotSvc, null);
    assert.deepEqual(globalThis.__tRequire, { n: 42 });

    // core.sessions 只读视图（globalThis.__piSessions 惰性现取）
    globalThis.__piSessions = new Map([["s1", { id: "s1" }]]);
    const sessions = reg.services.get("core.sessions");
    assert.deepEqual(sessions.ids(), ["s1"]);
    assert.deepEqual(sessions.get("s1"), { id: "s1" });
    assert.equal(sessions.has("nope"), false);

    // core.registry 投影（含 ui 只读视图——extman 插槽详情消费面）
    const proj = reg.services.get("core.registry").get("provider");
    assert.equal(proj.name, "P");
    assert.equal(typeof reg.services.get("core.registry").status(), "object");
    const ui = reg.services.get("core.registry").ui("provider");
    assert.deepEqual(ui.toolbar?.map((x) => x.id), ["t1"]); // ui 声明可读（只读视图）
    assert.equal(reg.services.get("core.registry").ui("nope"), null);

    // features：声明 default true；setFeatureValue 后 on 触发
    assert.equal(globalThis.__tFeaturesDefault, true);
    assert.equal(globalThis.__tFeaturesOther, true);
    reg.setFeatureValue("provider", "gate", false);
    assert.equal(reg.featureValue("provider", "gate"), false);
    assert.equal(globalThis.__tFeatureChanged, 1);

    // reload：shutdown 反卷（消费方看到 down）→ startAll 重新上线
    await reg.reload();
    assert.equal(globalThis.__tServiceDowns >= 1, true);
    assert.equal(reg.services.get("provider.svc")?.n, 42);
    const keys2 = reg.services.list().map((s) => s.key);
    assert.equal(keys2.includes("provider.svc") && keys2.includes("core.sessions"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const k of ["__tGotSvc", "__tRequire", "__tFeaturesDefault", "__tFeaturesOther", "__tFeatureChanged", "__tServiceDowns", "__tOff", "__piSessions"]) delete globalThis[k];
  }
});

test("assertServiceKey：直接导出的校验函数行为一致", () => {
  assert.throws(() => assertServiceKey("x", "y.z"), /前缀/);
  assert.doesNotThrow(() => assertServiceKey("x", "x.z"));
});
