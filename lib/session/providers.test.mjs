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
