/**
 * Inline ui icon resolution tests: extension-local icons win, the
 * @aiti-ai/ext-shared icon library is the fallback (resolved by walking up
 * node_modules from the extension dir), and missing-everywhere keeps the
 * original string. Covers the deploy-time icon copy removal contract.
 * Run: node --experimental-strip-types --test lib/ext/loader-icons.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ICON_ENTRY = `
export default {
  id: "iconprobe",
  name: "Icon probe",
  version: "1.0.0",
  ui: {
    sidebarExplorerDock: [
      { key: "a", title: "Local", icon: "icons/local.svg" },
      { key: "b", title: "Shared", icon: "icons/mic.svg" },
      { key: "c", title: "Missing", icon: "icons/does-not-exist.svg" },
    ],
  },
};
`;

const SVG = (label) => `<svg viewBox="0 0 24 24"><title>${label}</title></svg>`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "aiti-loader-icons-"));
  const extDir = join(root, "extensions", "iconprobe");
  mkdirSync(join(extDir, "icons"), { recursive: true });
  writeFileSync(join(extDir, "index.ts"), ICON_ENTRY);
  // extension-local icon (must win over the library copy)
  writeFileSync(join(extDir, "icons", "local.svg"), SVG("local"));
  // shared icon library, installed one level up (webRoot layout)
  const sharedIcons = join(root, "node_modules", "@aiti-ai", "ext-shared", "icons");
  mkdirSync(sharedIcons, { recursive: true });
  writeFileSync(join(sharedIcons, "mic.svg"), SVG("shared-mic"));
  return { root, extDir };
}

test("local icon wins, shared library resolves, missing keeps string", async () => {
  const { root, extDir } = setup();
  try {
    const { loadExtensionFromDir } = await import("./loader.ts");
    const ext = await loadExtensionFromDir(extDir);
    assert.ok(ext, "extension loads");
    const items = ext.ui.sidebarExplorerDock;
    assert.equal(items[0].icon.svg, "<title>local</title>", "extension-local icon is embedded");
    assert.equal(items[1].icon.svg, "<title>shared-mic</title>", "shared library icon is embedded");
    assert.equal(items[2].icon, "icons/does-not-exist.svg", "missing icon keeps the string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readExtIconFile walks up through nested node_modules", async () => {
  const { root, extDir } = setup();
  try {
    const { readExtIconFile } = await import("./loader.ts");
    assert.match(readExtIconFile(extDir, "icons/mic.svg"), /shared-mic/);
    assert.match(readExtIconFile(extDir, "icons/local.svg"), /local/);
    assert.equal(readExtIconFile(extDir, "icons/none.svg"), null);
    assert.equal(readExtIconFile(extDir, "icons/not-svg.txt"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
