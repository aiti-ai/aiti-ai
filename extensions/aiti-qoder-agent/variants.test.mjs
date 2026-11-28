/**
 * aiti-qoder-agent — 变体键一致性单测。
 *
 * 钉死的不变量（2026-09-20 事故回归：CN 变体 agentKey 误写成 provider type 的值
 * "qoder-cn"，而 All Sessions 行 id 前缀是 "qodercn"，宿主 findProvidersForAgent
 * 精确匹配落空 → qodercn:<sid> 的会话 URL 与接管全部 404「会话不存在」）：
 *   agentKey = All Sessions join key = handle.id 复合前缀 = session-manager 适配器 id
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/variants.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { QODER_VARIANTS, qoderVariant } = await import("./variants.ts");
const { builtinAdapters } = await import("../session-manager/lib/agents/registry.ts");

const adapterIds = new Set(builtinAdapters().map((a) => a.id));

test("每个变体的 agentKey 都是 session-manager 已注册的适配器 id（否则该变体历史行永远打不开）", () => {
  for (const v of QODER_VARIANTS) {
    assert.ok(adapterIds.has(v.agentKey), `${v.variant}: agentKey "${v.agentKey}" 不在适配器 id 表里`);
  }
});

test("agentKey 互不重复（同 join key 双注册会让认领/恢复撞车）", () => {
  const keys = QODER_VARIANTS.map((v) => v.agentKey);
  assert.equal(new Set(keys).size, keys.length);
});

test("CN 变体：注册键 type 与 join key agentKey 各自固定且不同名", () => {
  const cn = qoderVariant("cn");
  assert.equal(cn.type, "qoder-cn", "provider type 是注册键（recycleApi providerType / 前端后端记忆引用）");
  assert.equal(cn.agentKey, "qodercn", "复合 id 前缀（All Sessions 行 id）是 qodercn");
  assert.notEqual(cn.type, cn.agentKey);
  assert.equal(qoderVariant("intl").agentKey, "qoder");
});

test("stateKey 与 agentKey 分层：模型状态文件命名空间不随 join key 改动（存量数据零迁移）", () => {
  assert.equal(qoderVariant("cn").stateKey, "qoder-cn");
  assert.equal(qoderVariant("intl").stateKey, "qoder");
});

test("未知变体回落 intl（qoderVariant 不抛，调用方拿到可用键）", () => {
  assert.equal(qoderVariant("nope"), qoderVariant("intl"));
});
