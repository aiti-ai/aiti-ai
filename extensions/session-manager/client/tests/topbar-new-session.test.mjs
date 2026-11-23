/**
 * session-manager · small-screen top-bar new-session button (plan:
 * docs/pi-web-mobile-new-session-topbar-plan.md).
 *
 * Pure-function matrix plus source pins: the button renders only with a cwd, the click
 * goes through the host "pi-web.newSession" client service (nothing without a cwd), and
 * its labels come from this extension's i18n table.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { startNewSessionAt } from "../src/topbar-new-session.pure.ts";

// Reads happen before test() registration: when run directly with node --test, test()
// calls placed after a top-level await are dropped as "file already finished" (measured:
// only the synchronous pair ran).
const component = await readFile(new URL("../src/topbar-new-session.tsx", import.meta.url), "utf8");
const entry = await readFile(new URL("../src/entry.tsx", import.meta.url), "utf8");
const manifest = await readFile(new URL("../../index.ts", import.meta.url), "utf8");

test("有 cwd + 服务 → 调用 setCwd 一次并返回 true", () => {
  const calls = [];
  const ok = startNewSessionAt({ setCwd: (path) => calls.push(path) }, "/repo");
  assert.equal(ok, true);
  assert.deepEqual(calls, ["/repo"]);
});

test("无 cwd / 无服务 / 旧宿主 → 不动作", () => {
  const calls = [];
  const svc = { setCwd: (path) => calls.push(path) };
  assert.equal(startNewSessionAt(svc, null), false);
  assert.equal(startNewSessionAt(svc, ""), false);
  assert.equal(startNewSessionAt(undefined, "/repo"), false);
  assert.equal(startNewSessionAt(null, "/repo"), false);
  assert.deepEqual(calls, [], "no service call may happen without a cwd");
});

test("组件：无 cwd 不渲染、走宿主服务、带 E2E 标记", () => {
  assert.match(component, /if \(!cwd\) return null;/, "no workspace → no dead button");
  assert.match(component, /getExtService<NewSessionService>\("pi-web\.newSession"\)/);
  assert.match(component, /data-new-session="true"/);
});

test("注册：宿主 topbarMobileLeading 槽 + 静态声明 + 三语 i18n 都在", () => {
  assert.match(entry, /ctx\.registerItems\?\.\("topbarMobileLeading", \[[\s\S]*?id: "new-session"/);
  assert.match(manifest, /topbarMobileLeading: \[\{ id: "new-session"/);
  const keyHits = manifest.split('"sm.newSession"').length - 1;
  assert.equal(keyHits, 3, "en / zh-TW / zh-CN must all carry the label");
  assert.equal(manifest.split('"sm.newSessionIn"').length - 1, 3);
});
