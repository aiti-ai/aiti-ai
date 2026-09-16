import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("handleAgentEnd 读会话终态后再分流通知（不再无条件报完成）", () => {
  // /meta 轻量单条拿 lastRun
  assert.match(source, /handleAgentEnd[\s\S]*?\/api\/sessions\/\$\{encodeURIComponent\(targetSession\.id\)\}\/meta/);
  // aborted/interrupted 不发（runOutcomeNotifies 门）
  assert.match(source, /if \(lastRun && !runOutcomeNotifies\(lastRun\.status\)\) return;/);
  // failed → 失败文案（i18n taskFailed*）+ 错误摘要
  assert.match(source, /lastRun\?\.status === "failed"/);
  assert.match(source, /translate\("i18n\.taskFailedWithContextAndError", \{ project: projectLabel, error \}\)/);
  assert.match(source, /translate\("i18n\.taskFailedWithError", \{ error \}\)/);
  // 成功/未知维持原完成通知
  assert.match(source, /const deliverCompleted = \(\) => deliverSessionNotification\(/);
  // 读不到终态时保守按完成发（通知不消失）
  assert.match(source, /\.catch\(\(\) => \{[\s\S]*?if \(shouldShowBrowserNotification\(\)\) deliverCompleted\(\);/);
});
