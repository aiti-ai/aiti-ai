import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression (2026-09-22): re-clicking the already-open session early-returns to
// avoid remounting the chat, but it must still reconcile the address bar. External
// agent sessions (qodercn/cursor/…) pin a transient `<agent>:new-<uuid>` placeholder
// into ?session= on takeover, and the later canonicalization only rewrites the URL
// while it still equals that placeholder — so once the URL drifts off the real id,
// every re-click of the open session used to leave it stale and a refresh reopened
// the previous session. The early-return branch now rewrites ?session= to the real
// (non-placeholder) id of the session actually being viewed.
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("handleSelectSession reconciles the URL on the already-open-session early return", () => {
  const start = appShell.indexOf("const handleSelectSession = useCallback");
  const end = appShell.indexOf("\n  const handleNewSession", start);
  assert.notEqual(start, -1, "handleSelectSession callback not found");
  assert.notEqual(end, -1, "handleNewSession callback not found after handleSelectSession");
  const body = appShell.slice(start, end);

  const branch = body.indexOf("selectedSession.id === session.id && sameProject");
  assert.notEqual(branch, -1, "already-open-session early return not found");
  const after = body.slice(branch);
  const firstReturn = after.indexOf("return;");
  assert.notEqual(firstReturn, -1);
  const reconcile = after.slice(0, firstReturn);

  // Rewrites the URL to the selected session id before returning…
  assert.match(reconcile, /replaceLocationIfChanged\(router, `\?session=\$\{encodeURIComponent\(session\.id\)\}`/);
  // …but never writes a non-restorable `:new-` placeholder back into the URL.
  assert.match(reconcile, /includes\(":new-"\)/);
});
