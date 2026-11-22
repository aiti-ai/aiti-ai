// Placeholder token boundaries: package names / identifiers are not placeholders.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry } from "../src/mask.ts";
import { PLACEHOLDER_RE, V2_PLACEHOLDER_RE, findV2Placeholders, isPlaceholderToken } from "../src/placeholder.ts";

// Built from pieces so this test file does not itself contain a literal token
// that a loaded session could guard/restore.
const TOKEN = "rsec_" + "11111111";
const PKG = "@" + "rsec_" + "dba0" + "b8fb";

test("standalone tokens match; package names and identifiers do not", () => {
  const re = () => new RegExp(PLACEHOLDER_RE.source, "g");
  assert.ok(("x " + TOKEN + " y").match(re()));
  assert.equal((PKG + " token").match(re()), null, "the npm package name is not a placeholder");
  assert.equal(("prefix" + TOKEN).match(re()), null, "embedded identifier is not a placeholder");
  assert.equal(("path/" + TOKEN).match(re())?.[0], TOKEN, "a path segment still matches");
  assert.equal(isPlaceholderToken(PKG), false);
  assert.equal(isPlaceholderToken(TOKEN), true);
  assert.deepEqual(findV2Placeholders(PKG + " " + TOKEN), [TOKEN]);
  assert.equal((PKG + " x").match(new RegExp(V2_PLACEHOLDER_RE.source, "g")), null);
});

test("restore must not rewrite a placeholder-shaped substring of a package name", () => {
  const registry = new Registry();
  registry.registerManual("value-123456", "k", { placeholder: TOKEN });
  const text = `install ${PKG} then use ${TOKEN} verbatim`;
  const out = registry.restore(text);
  assert.equal(out.count, 1);
  assert.equal(out.text, `install ${PKG} then use value-123456 verbatim`);
});
