/**
 * topicMatches · 总线客户端通配分发回归测试（2026-09-16 修复钉死）。
 *
 * 背景：dispatch 本地过滤曾用精确 includes，服务端已按前缀通配转发的帧
 * （aiti-git-ops:changed:* / sched:*）在客户端被全部丢弃——消费方订阅静默失效。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { topicMatches } from "./client/src/aiti-event-bus-client.mjs";

test("通配：尾 * 前缀匹配", () => {
  assert.equal(topicMatches("aiti-git-ops:changed:794e04222121", ["aiti-git-ops:changed:*"]), true);
  assert.equal(topicMatches("sched:run-abc", ["sched:*"]), true);
  assert.equal(topicMatches("sched:run-abc", ["sched:run-*"]), true);
});

test("通配：不匹配的前缀拒绝", () => {
  assert.equal(topicMatches("sm:session-created", ["aiti-git-ops:changed:*"]), false);
  assert.equal(topicMatches("cmd-other-id", ["cmd-mine:*"]), false);
});

test("精确：无通配时要求全等", () => {
  assert.equal(topicMatches("running", ["running"]), true);
  assert.equal(topicMatches("running", ["running-x"]), false);
});

test("混合列表：任一命中即 true", () => {
  assert.equal(topicMatches("aiti-git-ops:changed:abc", ["running", "aiti-git-ops:changed:*"]), true);
  assert.equal(topicMatches("running", ["aiti-git-ops:changed:*", "running"]), true);
});
