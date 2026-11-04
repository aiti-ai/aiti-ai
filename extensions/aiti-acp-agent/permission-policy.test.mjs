/**
 * aiti-acp-agent — permission-policy 单测（ACP 授权策略纯逻辑）。
 *
 * 回归重点（2026-09-12 线上事故）：cbc 首个权限请求 id=**数字 0**；
 * 旧实现 `Number(id)||id` 把它退化成字符串 "0"，cbc 不认 → 会话永久挂起。
 * 本测试钉死「id 原样回写」。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-acp-agent/permission-policy.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
  pickPermissionOptions, chooseTrustMode, normalizePolicy, normalizeAskTimeoutSec,
  permissionSelectedLine, permissionCancelledLine, extractToolAskInfo, summarizeToolInput,
  TRUST_MODE_PREFERENCE,
} = await import("./permission-policy.ts");

test("pickPermissionOptions：allow_always 优先于 allow_once；deny 取 reject_once 优先", () => {
  const picked = pickPermissionOptions([
    { kind: "allow_once", optionId: "allow", name: "Allow" },
    { kind: "allow_always", optionId: "allow_always", name: "Always Allow" },
    { kind: "reject_once", optionId: "reject", name: "Reject" },
    { kind: "reject_always", optionId: "reject_always", name: "Always Reject" },
  ]);
  assert.equal(picked.allowOpt?.optionId, "allow_always");
  assert.equal(picked.allowAlways?.optionId, "allow_always");
  assert.equal(picked.allowOnce?.optionId, "allow");
  assert.equal(picked.denyOpt?.optionId, "reject");
  // 只有 allow_once 时 allowOpt=allow_once
  const only = pickPermissionOptions([{ kind: "allow_once", optionId: "allow" }]);
  assert.equal(only.allowOpt?.optionId, "allow");
  // 无 allow 选项 → allowOpt undefined（fail-safe 转人工）
  const none = pickPermissionOptions([{ kind: "reject_once", optionId: "reject" }]);
  assert.equal(none.allowOpt, undefined);
  assert.equal(none.denyOpt?.optionId, "reject");
  // 空/异常输入
  assert.equal(pickPermissionOptions([]).allowOpt, undefined);
  assert.equal(pickPermissionOptions(undefined).allowOpt, undefined);
});

test("permissionSelectedLine：id 原样回写（number 0 不退化！）", () => {
  const line0 = permissionSelectedLine(0, "allow");
  const parsed0 = JSON.parse(line0);
  assert.equal(parsed0.id, 0);
  assert.equal(typeof parsed0.id, "number"); // 回归：绝不能是 "0"
  assert.deepEqual(parsed0.result, { outcome: { outcome: "selected", optionId: "allow" } });

  const lineStr = permissionSelectedLine("0", "allow");
  assert.equal(typeof JSON.parse(lineStr).id, "string"); // 原始就是字符串则保字符串

  const lineN = permissionSelectedLine(7, "allow_always");
  const parsedN = JSON.parse(lineN);
  assert.equal(parsedN.id, 7);
  assert.equal(parsedN.result.outcome.optionId, "allow_always");
});

test("permissionCancelledLine：规范 MUST 的 cancelled 应答（id 保真）", () => {
  const parsed = JSON.parse(permissionCancelledLine(0));
  assert.equal(parsed.id, 0);
  assert.deepEqual(parsed.result, { outcome: { outcome: "cancelled" } });
});

test("normalizePolicy：未知/空一律 allow（信任优先）", () => {
  assert.equal(normalizePolicy("ask"), "ask");
  assert.equal(normalizePolicy(" ask "), "ask");
  assert.equal(normalizePolicy("allow"), "allow");
  assert.equal(normalizePolicy(""), "allow");
  assert.equal(normalizePolicy(undefined), "allow");
  assert.equal(normalizePolicy(123), "allow");
});

test("normalizeAskTimeoutSec：空/非法→300；0=无限；数值保真", () => {
  assert.equal(normalizeAskTimeoutSec(""), 300);
  assert.equal(normalizeAskTimeoutSec(undefined), 300);
  assert.equal(normalizeAskTimeoutSec("abc"), 300);
  assert.equal(normalizeAskTimeoutSec("-5"), 300);
  assert.equal(normalizeAskTimeoutSec("0"), 0); // 0 = 无限等待
  assert.equal(normalizeAskTimeoutSec("600"), 600);
  assert.equal(normalizeAskTimeoutSec(" 120 "), 120);
  assert.equal(normalizeAskTimeoutSec(90), 90);
});

test("chooseTrustMode：bypassPermissions > fullAccess > yolo；无匹配返回 undefined", () => {
  assert.equal(chooseTrustMode([{ id: "default" }, { id: "bypassPermissions" }]), "bypassPermissions");
  assert.equal(chooseTrustMode([{ id: "fullAccess" }, { id: "yolo" }]), "fullAccess");
  assert.equal(chooseTrustMode([{ id: "yolo" }]), "yolo");
  assert.equal(chooseTrustMode([{ id: "default" }, { id: "plan" }]), undefined);
  assert.equal(chooseTrustMode([]), undefined);
  assert.deepEqual([...TRUST_MODE_PREFERENCE], ["bypassPermissions", "fullAccess", "yolo"]);
});

test("extractToolAskInfo：cbc 元数据工具名 / title 兜底 / 入参提取", () => {
  const cbc = extractToolAskInfo({
    toolCallId: "tc-1",
    title: "Bash",
    rawInput: { command: "ls /tmp | head -3" },
    _meta: { "codebuddy.ai/toolName": "Bash" },
  });
  assert.equal(cbc.toolName, "Bash");
  assert.deepEqual(cbc.input, { command: "ls /tmp | head -3" });

  const titleOnly = extractToolAskInfo({ title: "Write", input: { file_path: "/tmp/a" } });
  assert.equal(titleOnly.toolName, "Write");
  assert.deepEqual(titleOnly.input, { file_path: "/tmp/a" });

  const empty = extractToolAskInfo(undefined);
  assert.equal(empty.toolName, "tool");
});

test("summarizeToolInput：单行摘要 + 超长截断", () => {
  assert.equal(summarizeToolInput(undefined), "");
  assert.equal(summarizeToolInput({ command: "ls" }), JSON.stringify({ command: "ls" }));
  const long = summarizeToolInput({ command: "x".repeat(300) }, 50);
  assert.equal(long.endsWith("…"), true);
  assert.equal(long.length, 51);
});
