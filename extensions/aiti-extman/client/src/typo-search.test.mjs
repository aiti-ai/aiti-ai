// typo-search 单测：node --test client/src/typo-search.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { osaDistance, typoThreshold, typoMatch } from "./typo-search.mjs";

const HAY = "service-tunnels 服务隧道 Service Tunnels 本机服务一键公网可达 @aiti-ai/aiti-service-tunnels";

test("osaDistance: 转置算 1 步（Damerau 语义，纯 Levenshtein 会是 2）", () => {
  assert.equal(osaDistance("servcie", "service"), 1);
  assert.equal(osaDistance("sevice", "service"), 1); // 删 r
  assert.equal(osaDistance("service", "service"), 0);
  assert.equal(osaDistance("abc", "yxa"), 3);
  assert.equal(osaDistance("", "ab"), 2);
});

test("typoThreshold: 按长度自适应", () => {
  assert.equal(typoThreshold("abc"), 0); // ≤3 不启用
  assert.equal(typoThreshold("sevice"), 1); // 4-7
  assert.equal(typoThreshold("service-tunnels"), 2); // 8+
});

test("typoMatch: 用户用例——servcie / sevice 命中 service-tunnels", () => {
  assert.equal(typoMatch("servcie", HAY), true);
  assert.equal(typoMatch("sevice", HAY), true);
  assert.equal(typoMatch("servie", HAY), true);
  assert.equal(typoMatch("servicetunnels", HAY), true); // 对整串 id 距离 1（漏连字符）
  // 完整拼错的复合 query（含连字符）对整串 token 命中
  assert.equal(typoMatch("servcie-tunnels", HAY), true);
});

test("typoMatch: 双错漏字——首字符锚定放宽（sevic→service 删 r+删尾 e）", () => {
  assert.equal(typoMatch("sevic", HAY), true);
  assert.equal(typoMatch("tunel", HAY), true); // tunnels 漏 n+漏 s
  assert.equal(typoMatch("zzvic", HAY), false); // 首字符不同不放宽（防误报）
  assert.equal(typoMatch("evics", HAY), false);
});

test("typoMatch: 中文错字", () => {
  assert.equal(typoMatch("服务随道", HAY), true); // 1 错
  assert.equal(typoMatch("服物隧道", HAY), true); // 1 错
});

test("typoMatch: 不该命中的（防噪音）", () => {
  assert.equal(typoMatch("zzzzzzz", HAY), false);
  assert.equal(typoMatch("npm", HAY), false); // ≤3 字符不启用模糊
  assert.equal(typoMatch("service tunnels", HAY), false); // 多词 query 不启用（includes 在调用方处理）
  // 精确子串命中由调用方 includes 层负责，typoMatch 本身不含 includes 语义
  assert.equal(typoMatch("aiti-service-tunnels", HAY), false);
  assert.equal(typoMatch("draft-keeper", HAY), false); // 别的扩展名不该命中
  // Query longer than the candidate token is not the dropped-character direction: no relaxation.
  assert.equal(typoMatch("服务端口", "系统状态（服务器 CPU/内存）"), false);
  assert.equal(typoMatch("servcee", "service"), false); // same length + 2 edits: relaxation needs a longer token
});

test("typoMatch: 边界（空/非字符串）", () => {
  assert.equal(typoMatch("", HAY), false);
  assert.equal(typoMatch("  sevice  ", HAY), true); // trim 后生效
  assert.equal(typoMatch("sevice", ""), false);
  assert.equal(typoMatch(null, HAY), false);
});
