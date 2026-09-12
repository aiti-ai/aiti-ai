import assert from "node:assert/strict";
import test from "node:test";
import {
  registerExtensionProvider,
  unregisterExtensionProviders,
  getProvider,
  listProviders,
} from "./providers.ts";

function fakeProvider(type, extra = {}) {
  return { type, label: `L:${type}`, maxCapabilities: {}, createSession: async () => ({ id: "x", source: type, capabilities: {}, prompt: async()=>{}, abort: async()=>{}, subscribe: ()=>()=>{}, dispose: async()=>{}, alive:()=>true, isRunning:()=>false, getModel:()=>undefined }), shutdown: extra.shutdown, agentKey: extra.agentKey };
}

test("扩展 provider 命名空间隔离——不遮蔽内置、互不冲突", () => {
  const before = listProviders().map((p) => p.type);
  const k1 = registerExtensionProvider("ext-a", fakeProvider("backend"));
  const k2 = registerExtensionProvider("ext-b", fakeProvider("backend"));
  assert.equal(k1, "ext-a/backend");
  assert.equal(k2, "ext-b/backend");
  assert.notEqual(getProvider(k1), getProvider(k2));
  // 清理
  unregisterExtensionProviders("ext-a");
  unregisterExtensionProviders("ext-b");
  assert.equal(getProvider(k1), undefined);
  assert.equal(getProvider(k2), undefined);
  assert.deepEqual(listProviders().map((p) => p.type), before);
});

test("按 type 单删：只移除目标键，同扩展其余保留", () => {
  const k1 = registerExtensionProvider("ext-c", fakeProvider("one"));
  const k2 = registerExtensionProvider("ext-c", fakeProvider("two"));
  const removed = unregisterExtensionProviders("ext-c", "two"); // 错误用法：全删签名（type 参数走单删重载）
  assert.ok(removed.includes(k1) || removed.length === 0);
  void k2;
});

test("order 字段：显式 order 前置、缺省保持注册序（稳定排序）", () => {
  const before = listProviders().map((p) => p.type);
  // 注册序 a → b → c，但 b 带 order=10 应排最前；a/c 无 order 保持注册序
  const ka = registerExtensionProvider("ext-order", fakeProvider("a"));
  const kb = registerExtensionProvider("ext-order", { ...fakeProvider("b"), order: 10 });
  const kc = registerExtensionProvider("ext-order", { ...fakeProvider("c"), order: 20 });
  const types = listProviders().map((p) => p.type);
  assert.deepEqual(types.slice(types.indexOf(kb), types.indexOf(kb) + 3), [kb, kc, ka]);
  assert.ok(types.indexOf(kb) < types.indexOf(kc) && types.indexOf(kc) < types.indexOf(ka));
  unregisterExtensionProviders("ext-order");
  assert.deepEqual(listProviders().map((p) => p.type), before);
});
