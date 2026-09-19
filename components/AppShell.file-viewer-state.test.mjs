import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// tab-detach v0.6.0: right-panel content dispatch was extracted into TabBody
// (components/TabBody.tsx); the right panel and detached windows share the same dispatch
// (host differences are only the watchEnabled/onMentionLines/terminal-active props).
// This file originally pinned the invariants of AppShell's inline JSX and moved with it;
// the invariants themselves are unchanged:
//   1) single-point dispatch through TabBody (no inline FileViewer, no per-tab mounting);
//      under the keep-alive pool (docs/aiti-editor-right-dock-keepalive-plan.md) the
//      semantics are: the N most recent non-terminal tabs stay mounted (hidden when
//      inactive), tabs outside the pool only mount while active -- still single-point
//      dispatch, never per-tab mounting
//   2) closed loop of viewerState snapshot restore (key includes viewerRevision +
//      initialState + onStateChange saving back)
//   3) closing the panel pauses the watch (the panel host's watchEnabled reads ctx.panelOpen)
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const tabBody = await readFile(new URL("./TabBody.tsx", import.meta.url), "utf8");

function fileContentBlock() {
  const start = appShell.indexOf("{/* [tab-detach v0.6.0] content dispatch extracted into TabBody");
  const end = appShell.indexOf("</div>\n      </div>\n    </div>", start);
  assert.notEqual(start, -1, "TabBody content dispatch block not found in AppShell");
  assert.notEqual(end, -1, "end of file content block not found");
  return appShell.slice(start, end);
}

test("right panel mounts tabs through TabBody single dispatch (keep-alive pool)", () => {
  const block = fileContentBlock();
  // AppShell side: non-terminal tabs go through the keep-alive pool (the N most recent
  // stay mounted, hidden when inactive; tabs outside the pool only mount while active) --
  // still dispatched only through TabBody (no inline FileViewer, no per-tab mounting)
  assert.match(block, /\.map\(\(tab\) => \(\n\s*<div key=\{tab\.id\} hidden=\{tab\.id !== activeFileTabId\}/);
  assert.equal(block.match(/<FileViewer/g)?.length ?? 0, 0, "AppShell must not inline FileViewer anymore (dispatch belongs to TabBody)");
  // TabBody side: two mutually exclusive branches (folder kind | file path) -- exactly one viewer at runtime
  assert.equal(tabBody.match(/<FileViewer/g)?.length, 2);
  assert.doesNotMatch(tabBody, /\.map\(/);
});

test("the active viewer restores tab state and saves it with a revision", () => {
  assert.match(tabBody, /key=\{`\$\{tab\.id\}:\$\{tab\.viewerRevision \?\? 0\}`\}/);
  assert.match(tabBody, /initialState=\{tab\.viewerState\}/);
  assert.match(tabBody, /ctx\.onStateChange\(tab\.id, tab\.viewerRevision \?\? 0, viewerState\)/);
});

test("closing the file panel pauses the active viewer watcher", () => {
  // panel host: watchEnabled = ctx.panelOpen (the window host is always true -- visible means active)
  assert.match(tabBody, /watchEnabled=\{host === "window" \? true : ctx\.panelOpen\}/);
});
