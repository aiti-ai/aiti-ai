/**
 * protocol-screen 占位契约测试——空函数当前必须返回 skipped 且不抛；
 * 后续上线后发生 API 不兼容时实现真筛查（方案 §7），届时本测试同步升级为真用例。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { screenAndMigrateOnInstall } from "./protocol-screen.mjs";

test("安装筛查占位：skipped 契约", async () => {
  assert.deepEqual(await screenAndMigrateOnInstall({}), { ok: true, skipped: true, reason: "not_implemented" });
});

test("安装筛查占位：忽略入参、不抛", async () => {
  const r = await screenAndMigrateOnInstall({ id: "demo", dir: "/tmp/x", kind: "npm", fromProtocol: "0.9", toProtocol: "1.0" });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "not_implemented");
});
