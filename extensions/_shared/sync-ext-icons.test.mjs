/**
 * sync-ext-icons.test.mjs — icon reference collection + copy semantics.
 *
 * Run: node --test extensions/_shared/sync-ext-icons.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectIconRefs, syncExtIcons } from "./sync-ext-icons.mjs";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sync-ext-icons-"));
  const root = join(base, "ext");
  const shared = join(base, "shared");
  const t1 = join(base, "deployed-prod", "ext");
  const t2 = join(base, "deployed-dev", "ext");
  mkdirSync(join(root, "icons"), { recursive: true });
  mkdirSync(join(root, "client", "src"), { recursive: true });
  mkdirSync(shared, { recursive: true });

  // extension-owned artwork (same relative path wins over the shared library)
  writeFileSync(join(root, "icons", "own.svg"), "<svg>own</svg>");
  writeFileSync(join(root, "icon.svg"), "<svg>ext</svg>");
  // manifest declarations: one own icon, one shared icon, one dangling reference
  writeFileSync(
    join(root, "index.ts"),
    'export default { icon: "icon.svg", ui: { toolbar: [{ id: "x", icon: "icons/own.svg" }], rightFileDock: [{ id: "y", icon: "icons/shared.svg" }], commands: [{ id: "z", icon: "icons/missing.svg" }] } };\n',
  );
  // client registration (evaluated string inside the built bundle)
  writeFileSync(join(root, "client", "src", "entry.tsx"), 'meta: { icon: "icons/from-client.svg" }\n');
  writeFileSync(join(shared, "shared.svg"), "<svg>shared</svg>");
  writeFileSync(join(shared, "from-client.svg"), "<svg>client</svg>");
  return { base, root, shared, t1, t2 };
}

test("collectIconRefs scans manifest declarations and client sources", () => {
  const f = fixture();
  try {
    const names = [...collectIconRefs(f.root)].sort();
    assert.deepEqual(names, ["from-client.svg", "missing.svg", "own.svg", "shared.svg"]);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("syncExtIcons copies resolved icons to every target and reports dangling refs", () => {
  const f = fixture();
  try {
    const logs = [];
    const r = syncExtIcons({
      root: f.root,
      extId: "demo",
      sharedIconDir: f.shared,
      targets: [f.t1, f.t2],
      log: (m) => logs.push(m),
    });
    for (const target of [f.t1, f.t2]) {
      assert.ok(readFileSync(join(target, "icons", "own.svg"), "utf8").includes("own"));
      assert.ok(readFileSync(join(target, "icons", "shared.svg"), "utf8").includes("shared"));
      assert.ok(readFileSync(join(target, "icons", "from-client.svg"), "utf8").includes("client"));
      // extension-level icon lands at the extension root (host resolves "icon.svg" there)
      assert.ok(existsSync(join(target, "icon.svg")));
      assert.ok(!existsSync(join(target, "icons", "icon.svg")));
    }
    assert.deepEqual(r.missing, ["missing.svg"]);
    assert.ok(logs.some((m) => m.includes("icons/missing.svg")));
    // own artwork wins over the shared library
    assert.ok(readFileSync(join(f.t1, "icons", "own.svg"), "utf8").includes("own"));
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("syncExtIcons is idempotent and tolerates missing roots", () => {
  const f = fixture();
  try {
    const args = { root: f.root, extId: "demo", sharedIconDir: f.shared, targets: [f.t1] };
    syncExtIcons(args);
    assert.doesNotThrow(() => syncExtIcons(args));
    assert.deepEqual(syncExtIcons({ root: join(f.base, "nope"), targets: [f.t1] }), { provenance: [], copied: [], missing: [] });
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
