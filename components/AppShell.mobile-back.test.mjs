// 小屏系统返回关闭浮层——宿主接线 guard（方案 docs/pi-web-mobile-back-dismiss-plan.md §3.2）。
// 钉住：退栈 lib 被导入、pi-web.overlayBack 服务注册、全部宿主浮层状态都接了 useOverlayBack
// （仅 isMobile 门控）。实现重构时同步更新本文件，禁止删接线不删测试。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/useOverlayBack.ts", import.meta.url), "utf8");
const libSource = await readFile(new URL("../lib/overlay-back.ts", import.meta.url), "utf8");

test("exposes the overlay-back primitive to extension clients via pi-web.overlayBack", () => {
  assert.match(appShell, /registerExtClientService\("pi-web", "pi-web\.overlayBack", \{/);
  assert.match(appShell, /acquire: \(close: \(\) => void\) => acquireOverlayBack\(close\)/);
  assert.match(libSource, /export function acquireOverlayBack\(close: \(\) => void\): OverlayBackHandle/);
});

test("wires every host overlay to the back stack on small screens only", () => {
  assert.match(hookSource, /export function useOverlayBack\(active: boolean, close: \(\) => void\): void/);
  const expected = [
    /useOverlayBack\(isMobile && sidebarOpen, \(\) => setSidebarOpen\(false\)\);/,
    /useOverlayBack\(isMobile && rightPanelOpen, \(\) => setRightPanelOpen\(false\)\);/,
    /useOverlayBack\(isMobile && settingsSection !== null, \(\) => setSettingsSection\(null\)\);/,
    /useOverlayBack\(isMobile && projectTrustDialogOpen, \(\) => setProjectTrustDialogOpen\(false\)\);/,
    /useOverlayBack\(isMobile && exportDialogOpen, \(\) => setExportDialogOpen\(false\)\);/,
    /useOverlayBack\(isMobile && mobileToolbarMoreOpen, \(\) => setMobileToolbarMoreOpen\(false\)\);/,
    /useOverlayBack\(isMobile && \(moreOpen \|\| customizeOpen\), \(\) => \{/,
    /useOverlayBack\(isMobile && activeTopPanel !== null, \(\) => setActiveTopPanel\(null\)\);/,
    /useOverlayBack\(isMobile && bridgedNameDialog !== null, \(\) => setBridgedNameDialog\(null\)\);/,
  ];
  for (const re of expected) {
    assert.match(appShell, re);
  }
});

test("session info dropdown has a top-right close button wired to the panel state", () => {
  assert.match(appShell, /<div className="session-info-popover" style=\{\{/);
  // 右上角关闭：sticky 零高容器（滚动时保持可点）+ ✕ → setActiveTopPanel(null)
  assert.match(
    appShell,
    /position: "sticky", top: 0, height: 0, display: "flex", justifyContent: "flex-end", zIndex: 3[\s\S]{0,700}?title=\{translate\("i18n\.close"\)\}[\s\S]{0,300}?onClick=\{\(\) => setActiveTopPanel\(null\)\}/,
  );
});

test("the back stack keeps Next router state and pushes same-URL entries", () => {
  // 展开 history.state（保留 __NA/内部树）；URL 传空串不做地址变化
  assert.match(libSource, /\[KEY\]: token, \[POS_KEY\]: pos \}, ""\)/);
  assert.match(libSource, /\(window\.history\.state && typeof window\.history\.state === "object"/);
  // 自身清理回退推迟微任务（关旧开新竞态）；popstate 自身回退不关层
  assert.match(libSource, /queueMicrotask\(\(\) => \{/);
  assert.match(libSource, /if \(selfBacks > 0\) \{/);
});
