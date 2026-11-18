// A real weak password may look exactly like our v2 placeholder token.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry } from "../src/mask.ts";
import { guardReason, unmountedInValue } from "../src/guard.ts";
import {
  assessPasswordStrength,
  extractStructuredSecrets,
  registerExtractedSecrets,
  registerWeakCandidates,
  weakPasswordCandidates,
} from "../src/extract.ts";

const WEAK = "rsec_" + "035c" + "2182";

test("placeholder-shaped weak password is still a candidate and registers", () => {
  const cands = weakPasswordCandidates("我的密码是" + WEAK);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].value, WEAK);
  assert.equal(cands[0].dictionary, true);
  const r = new Registry();
  const out = registerWeakCandidates("我的密码是" + WEAK, r, "salt");
  assert.equal(out[0].registered, true);
  assert.equal(r.hasValue(WEAK), true);
  const red = r.redact("use " + WEAK + " now");
  assert.ok(!red.text.includes(WEAK));
  assert.equal(r.restore(red.text).text, "use " + WEAK + " now");
  // a registered value that looks like a token is not an unresolved placeholder
  assert.deepEqual(unmountedInValue({ cmd: "use " + WEAK }, r), []);
});

test("structured extraction does not skip a placeholder-shaped password", () => {
  const r = new Registry();
  const hits = extractStructuredSecrets("DB_PASSWORD=" + WEAK);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].value, WEAK);
  assert.equal(registerExtractedSecrets("DB_PASSWORD=" + WEAK, r, "salt").count, 1);
});

test("mounted placeholders are skipped, real values are not", () => {
  const r = new Registry();
  const mounted = "rsec_" + "11111111";
  r.registerManual("value-123456", "k", { placeholder: mounted });
  assert.equal(registerExtractedSecrets("PASSWORD=" + mounted, r, "salt").count, 0);
  assert.equal(registerWeakCandidates("password=" + mounted, r, "salt")[0].registered, false);
});

test("strength assessment flags the dictionary entry", () => {
  const s = assessPasswordStrength(WEAK);
  assert.equal(s.weak, true);
  assert.deepEqual(s.reasons, ["dictionary"]);
});
