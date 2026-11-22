// Pre-send preflight: candidates carry previews only; masking lands + rewrites.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultStore } from "../src/store.ts";
import { preflightMask, preflightScan } from "../src/preflight.ts";

const ARK = "ark-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d-9f8e";
const OPAQUE = "Zx8Kp2Lm9Qr4Tv7Wn3Yb6Cd1Fg7H";

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vault-preflight-"));
  try {
    return fn(new VaultStore({ dir, cwd: "/proj/pf" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("scan: previews never contain the value; short keyword-bound ids are medium", () => {
  withStore((store) => {
    const text = `这个还能用吗 ${ARK}，还有 token ab12cd`;
    const { candidates, locked } = preflightScan(store, text);
    assert.equal(locked, false);
    assert.ok(candidates.length >= 2, JSON.stringify(candidates));
    for (const c of candidates) {
      assert.ok(!c.preview.includes(ARK), "preview hides the value");
      assert.match(c.preview, /…|^\*+$/);
      assert.equal(c.stored, false);
    }
    const ark = candidates.find((c) => c.label === "ARK_KEY");
    assert.equal(ark?.confidence, "high");
    assert.ok(candidates.some((c) => c.confidence === "medium"));
  });
});

test("mask: accepted indices land in the vault and become stable placeholders", () => {
  withStore((store) => {
    const text = `密钥如下：${OPAQUE} 还有 ${ARK}`;
    const { candidates } = preflightScan(store, text);
    const indices = candidates.map((c) => c.index);
    const res = preflightMask(store, text, indices);
    assert.equal(res.aliases.length, candidates.length);
    assert.ok(!res.text.includes(OPAQUE));
    assert.ok(!res.text.includes(ARK));
    assert.match(res.text, /rsec_[0-9a-f]{8}/);

    // values are in the vault (encrypted), and re-scanning the masked text finds
    // nothing left to confirm
    assert.deepEqual(preflightScan(store, res.text).candidates, []);

    // masking the same text again reuses the existing aliases (no duplicates)
    const again = preflightMask(store, text, indices);
    assert.deepEqual(again.aliases.sort(), res.aliases.sort());
    assert.ok(store.list().length <= candidates.length);
  });
});

test("mask: unselected candidates stay in the text", () => {
  withStore((store) => {
    const text = `a ${ARK} b ${OPAQUE}`;
    const { candidates } = preflightScan(store, text);
    const only = candidates.findIndex((c) => c.label === "ARK_KEY");
    assert.ok(only >= 0);
    const res = preflightMask(store, text, [candidates[only].index]);
    assert.ok(!res.text.includes(ARK));
    assert.ok(res.text.includes(OPAQUE), "unselected value is untouched");
  });
});

test("mask: empty selection is a no-op", () => {
  withStore((store) => {
    const text = `token ${ARK}`;
    assert.deepEqual(preflightMask(store, text, []), { text, aliases: [] });
    assert.equal(store.list().length, 0);
  });
});
