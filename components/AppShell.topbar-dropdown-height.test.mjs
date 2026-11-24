import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

// Pins the phone regression where the top-bar "..." more menu (and the customize
// panel it opens) grew taller than the space below its anchor: the panel is
// fixed-positioned at the toolbar bottom, so a plain `100dvh` cap pushed the last
// rows — e.g. the customize ("Manage") entry — below the viewport with no way to
// scroll them into view.

test("anchors the ⋯ dropdown height to the space below the top bar", () => {
  // The height budget must subtract the fixed `top` offset from the viewport.
  assert.match(
    source,
    /const viewportH = window\.visualViewport\?\.height \?\? window\.innerHeight;/,
  );
  assert.match(source, /const maxHeight = Math\.max\(200, Math\.round\(viewportH - top - 8\)\);/);
  assert.match(source, /setMoreRect\(\{ top, right, topbarBottom, maxHeight \}\);/);
});

test("renders both top-bar dropdowns with the measured height", () => {
  // ⋯ more menu + customize panel: no static viewport cap left behind.
  assert.doesNotMatch(source, /maxHeight: "calc\(100dvh - 8px\)"/);
  const dropdownHeights = source.match(/maxHeight: moreRect\.maxHeight/g) ?? [];
  assert.equal(dropdownHeights.length, 2);
  const scrollers = source.match(/overflowY: "auto", overscrollBehavior: "contain"/g) ?? [];
  assert.equal(scrollers.length, 2);
});

test("re-measures when the visual viewport shrinks (mobile URL bar / keyboard)", () => {
  assert.match(source, /window\.visualViewport\?\.addEventListener\("resize", update\);/);
  assert.match(source, /window\.visualViewport\?\.removeEventListener\("resize", update\);/);
});
