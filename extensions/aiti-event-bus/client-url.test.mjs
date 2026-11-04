/**
 * aiti-event-bus · client 兜底 basePath 单测（node --test）
 *
 * 回归锚点：URL 拼接把 basePath 当主机的 bug——旧逻辑 `"/" + m[0]`（m[0] 已是 "/dev"）
 * 拼出 "//dev"，浏览器把协议相对 URL "//dev/..." 解析为 host="dev" → SSE 连不上。
 * 兜底必须产出 "/dev/api/..."（绝不以 "//" 开头）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fallbackBasePath } from "./dist/aiti-event-bus-client.mjs";

const EVENTS_PATH = "/api/extensions/aiti-event-bus/events";

test("子路径部署 /dev/：basePath=/dev，SSE URL 不以 // 开头", () => {
  const base = fallbackBasePath("/dev/", undefined);
  assert.equal(base, "/dev");
  assert.equal(base + EVENTS_PATH, "/dev/api/extensions/aiti-event-bus/events");
  assert.ok(!base.startsWith("//"), "不得产生 // 协议相对前缀（否则 basePath 被解析成主机）");
});

test("多段子路径只取第一段（/prod/x/y/ → /prod）", () => {
  assert.equal(fallbackBasePath("/prod/x/y/", undefined), "/prod");
});

test("根部署 / → 空 basePath", () => {
  assert.equal(fallbackBasePath("/", undefined), "");
});

test("无 pathname（非浏览器/undefined）→ 空 basePath", () => {
  assert.equal(fallbackBasePath(undefined, undefined), "");
});

test("__PIBASE__ 存在时优先（不论 pathname 是否含子路径）", () => {
  assert.equal(fallbackBasePath("/", "/dev"), "/dev");
  assert.equal(fallbackBasePath("/dev/", "/dev"), "/dev");
  assert.equal(fallbackBasePath("/prod/", "/dev"), "/dev");
});
