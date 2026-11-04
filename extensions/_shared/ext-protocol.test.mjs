/**
 * ext-protocol 单测（纯函数）。
 * 运行：node scripts/test-web-ext.mjs --only _shared
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXT_PROTOCOL_VERSION,
  EXT_PROTOCOL_MIN_MAJOR,
  parseExtProtocol,
  extProtocolInfo,
  extProtocolUpgradeRefs,
} from "./ext-protocol.mjs";

test("常量：当前版本与最低支持 major", () => {
  assert.equal(EXT_PROTOCOL_VERSION, "1.0");
  assert.equal(EXT_PROTOCOL_MIN_MAJOR, 1);
});

test("parseExtProtocol：合法字符串", () => {
  assert.deepEqual(parseExtProtocol("1.0"), { major: 1, minor: 0, raw: "1.0" });
  assert.deepEqual(parseExtProtocol(" 2.13 "), { major: 2, minor: 13, raw: "2.13" });
  assert.deepEqual(parseExtProtocol("10.7"), { major: 10, minor: 7, raw: "10.7" });
});

test("parseExtProtocol：非法输入（含数字类型）", () => {
  assert.equal(parseExtProtocol(1.0), null);      // 数字必须拒绝（1.10 被吃成 1.1 的经典坑）
  assert.equal(parseExtProtocol(1), null);
  assert.equal(parseExtProtocol("1"), null);      // 必须 MAJOR.MINOR
  assert.equal(parseExtProtocol("1.0.0"), null);
  assert.equal(parseExtProtocol("v1.0"), null);
  assert.equal(parseExtProtocol(""), null);
  assert.equal(parseExtProtocol(null), null);
  assert.equal(parseExtProtocol(undefined), null);
  assert.equal(parseExtProtocol({}), null);
});

test("extProtocolInfo：ok / minorAhead", () => {
  const ok = extProtocolInfo("1.0");
  assert.equal(ok.state, "ok");
  assert.equal(ok.needsUpgrade, false);
  assert.deepEqual(ok.upgradeRefs, []);

  const ahead = extProtocolInfo("1.2", { current: "1.0" });
  assert.equal(ahead.state, "ok");
  assert.equal(ahead.minorAhead, true);
});

test("extProtocolInfo：stale / incompatible", () => {
  const stale = extProtocolInfo("1.0", { current: "2.1", minMajor: 1 });
  assert.equal(stale.state, "stale");
  assert.equal(stale.needsUpgrade, true);
  assert.deepEqual(stale.upgradeRefs, ["v1-to-v2"]);

  const incompat = extProtocolInfo("1.0", { current: "3.0", minMajor: 2 });
  assert.equal(incompat.state, "incompatible");
  assert.equal(incompat.needsUpgrade, true);
  assert.deepEqual(incompat.upgradeRefs, ["v1-to-v2", "v2-to-v3"]);
});

test("extProtocolInfo：too_new", () => {
  const info = extProtocolInfo("2.0", { current: "1.0" });
  assert.equal(info.state, "too_new");
  assert.equal(info.needsUpgrade, false);
});

test("extProtocolInfo：missing / invalid", () => {
  const missing = extProtocolInfo(undefined);
  assert.equal(missing.state, "missing");
  assert.equal(missing.needsUpgrade, true);
  assert.deepEqual(missing.upgradeRefs, ["legacy-to-v1"]);

  const invalid = extProtocolInfo(1.0);
  assert.equal(invalid.state, "invalid");
  assert.equal(invalid.needsUpgrade, true);
});

test("extProtocolUpgradeRefs：逐跳路由", () => {
  assert.deepEqual(extProtocolUpgradeRefs("1.0", { current: "1.0" }), []);
  assert.deepEqual(extProtocolUpgradeRefs("1.0", { current: "2.0" }), ["v1-to-v2"]);
  assert.deepEqual(extProtocolUpgradeRefs("1.0", { current: "3.2" }), ["v1-to-v2", "v2-to-v3"]);
  assert.deepEqual(extProtocolUpgradeRefs(undefined, { current: "1.0" }), ["legacy-to-v1"]);
  assert.deepEqual(extProtocolUpgradeRefs(undefined, { current: "2.0" }), ["legacy-to-v1", "v1-to-v2"]);
  // 0.x（版本化前谱系）与缺失同路由：先 legacy 手册
  assert.deepEqual(extProtocolUpgradeRefs("0.9", { current: "1.0" }), ["legacy-to-v1"]);
  assert.deepEqual(extProtocolUpgradeRefs("0.9", { current: "2.0" }), ["legacy-to-v1", "v1-to-v2"]);
  assert.equal(extProtocolInfo("0.9").state, "incompatible");
});
