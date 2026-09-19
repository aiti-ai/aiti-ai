// Small-screen system back closes overlays — host wiring guard (docs/pi-web-mobile-back-dismiss-plan.md §3.2).
// Pinned: the back-stack lib is imported, the pi-web.overlayBack service is registered, and every
// host overlay state is wired to useOverlayBack (mobile-gated only). Update this file together with
// implementation refactors; removing wiring without removing these tests is forbidden.
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
    /useOverlayBack\(isMobile && mobileSidebarReady && sidebarOpen, \(\) => setSidebarOpen\(false\)\);/,
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

test("session info dropdown has a sticky top-right close button wired to the panel state", () => {
  assert.match(appShell, /<div className="session-info-popover" style=\{\{/);
  // Top bar row: sticky title + top-right ✕ → setActiveTopPanel(null)
  assert.match(
    appShell,
    /position: "sticky",\s*top: 0,\s*zIndex: 3,[\s\S]{0,900}?title=\{translate\("i18n\.close"\)\}[\s\S]{0,300}?onClick=\{\(\) => setActiveTopPanel\(null\)\}/,
  );
  // overflow: clip must not create a scroll container — otherwise the panel itself becomes the
  // sticky element's scroll container and the top bar can neither scroll away nor stick
  assert.match(appShell, /\.session-info-popover \{[\s\S]*?overflow: hidden;[\s\S]*?overflow: clip;/);
});

test("the back stack keeps Next router state and pushes same-URL entries", () => {
  // Expand history.state (preserve __NA/internal tree); an empty URL string makes no address change
  assert.match(libSource, /\[KEY\]: token, \[POS_KEY\]: pos \}, ""\)/);
  assert.match(libSource, /\(window\.history\.state && typeof window\.history\.state === "object"/);
  // Own-cleanup fallback deferred to a microtask (close-old/open-new race); a popstate self-back does not close the layer
  assert.match(libSource, /queueMicrotask\(\(\) => \{/);
  assert.match(libSource, /if \(selfBacks > 0\) \{/);
});
