import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("handleAgentEnd reads the session's final run state before branching notifications (no longer unconditionally reports completion)", () => {
  // fetch lastRun with a single lightweight /meta call
  assert.match(source, /handleAgentEnd[\s\S]*?\/api\/sessions\/\$\{encodeURIComponent\(targetSession\.id\)\}\/meta/);
  // aborted/interrupted deliver nothing (runOutcomeNotifies gate)
  assert.match(source, /if \(lastRun && !runOutcomeNotifies\(lastRun\.status\)\) return;/);
  // failed → failure copy (i18n taskFailed*) + error summary
  assert.match(source, /lastRun\?\.status === "failed"/);
  assert.match(source, /translate\("i18n\.taskFailedWithContextAndError", \{ project: projectLabel, error \}\)/);
  assert.match(source, /translate\("i18n\.taskFailedWithError", \{ error \}\)/);
  // success/unknown keeps the original completion notification
  assert.match(source, /const deliverCompleted = \(\) => deliverSessionNotification\(/);
  // when the final state can't be read, conservatively deliver as completed (notification never disappears)
  assert.match(source, /\.catch\(\(\) => \{[\s\S]*?if \(shouldShowBrowserNotification\(\)\) deliverCompleted\(\);/);
});
