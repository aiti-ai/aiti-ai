// Custom rules (G6): parsing, merging, placeholder/fixed modes, hot reload.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/mask.ts";
import { redactTextSpans } from "../src/spans.ts";
import {
  RulesSource,
  applyFixedRules,
  parseRulesFile,
  registerRuleMatches,
  addRuleToFile,
  removeRuleFromFile,
  mergeRules,
} from "../src/rules.ts";

const CORP = "acme_0123456789abcdef";

test("parse: valid rules kept, invalid reported", () => {
  const { file, errors } = parseRulesFile(
    JSON.stringify({
      version: 1,
      rules: [
        { label: "corp", type: "regex", match: "acme_[0-9a-f]{16}" },
        { label: "broken", type: "regex", match: "([" },
        { label: "bad label!", match: "x" },
        { label: "fixed-one", match: "INTERNAL-[0-9]+", mode: "fixed", fixed: "<corp-id>" },
      ],
      projects: { "/p": [{ label: "local", type: "exact", match: "LOCALVALUE12345" }] },
    }),
  );
  assert.equal(errors.length, 2);
  assert.deepEqual(file.rules.map((r) => r.label), ["corp", "fixed-one"]);
  assert.equal(file.rules[1].fixed, "<corp-id>");
  assert.deepEqual(file.projects["/p"].map((r) => r.label), ["local"]);
});

test("merge: project rules override global labels", () => {
  const { file } = parseRulesFile(
    JSON.stringify({
      rules: [{ label: "x", match: "GLOBAL", type: "exact" }],
      projects: { "/p": [{ label: "x", match: "LOCAL", type: "exact" }] },
    }),
  );
  const merged = mergeRules(file, "/p");
  assert.equal(merged.length, 1);
  assert.equal(merged[0].match, "LOCAL");
});

test("placeholder-mode rule: value registered, redacted, restored", () => {
  const registry = new Registry();
  const added = registerRuleMatches(`token=${CORP}`, registry, [{ label: "corp", type: "regex", match: "acme_[0-9a-f]{16}" }], "salt");
  assert.equal(added, 1);
  const entry = registry.entries()[0];
  assert.equal(entry.label, "corp");
  const red = registry.redact(`x ${CORP} y`);
  assert.ok(!red.text.includes(CORP));
  assert.equal(registry.restore(red.text).text, `x ${CORP} y`);
});

test("fixed-mode rule: one-way replacement, never registered", () => {
  const registry = new Registry();
  const rules = [{ label: "ticket", type: "regex", match: "TICKET-[0-9]{4}", mode: "fixed", fixed: "<ticket>" }];
  assert.equal(registerRuleMatches("TICKET-1234", registry, rules, "salt"), 0);
  const fixed = applyFixedRules("id TICKET-1234 and TICKET-5678", rules);
  assert.equal(fixed.count, 2);
  assert.equal(fixed.text, "id <ticket> and <ticket>");
  assert.equal(registry.size, 0);
});

test("redactTextSpans applies custom rules (placeholder + fixed)", () => {
  const registry = new Registry();
  const rules = [
    { label: "corp", type: "regex", match: "acme_[0-9a-f]{16}" },
    { label: "ticket", type: "exact", match: "TICKET-1234", mode: "fixed", fixed: "<ticket>" },
  ];
  let text = `key ${CORP} ticket TICKET-1234`;
  const res = redactTextSpans([{ get: () => text, set: (t) => (text = t) }], registry, "salt", { rules });
  assert.ok(res.changed);
  assert.ok(!text.includes(CORP));
  assert.ok(!text.includes("TICKET-1234"));
  assert.ok(text.includes("<ticket>"));
});

test("exact rule works even when the built-in rules would miss it", () => {
  const registry = new Registry();
  registerRuleMatches("note: ZZZZ-0000-MMMM", registry, [{ label: "internal", type: "exact", match: "ZZZZ-0000-MMMM" }], "s");
  assert.equal(registry.size, 1);
});

test("RulesSource reloads on mtime change and merges scope", () => {
  const dir = mkdtempSync(join(tmpdir(), "secret-rules-"));
  const path = join(dir, "secret-mask-rules.json");
  try {
    writeFileSync(path, JSON.stringify({ version: 1, rules: [{ label: "a", type: "exact", match: "AAAAAA1" }] }));
    const source = new RulesSource(path, "/proj");
    assert.deepEqual(source.rules().map((r) => r.label), ["a"]);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        rules: [{ label: "a", type: "exact", match: "AAAAAA1" }],
        projects: { "/proj": [{ label: "b", type: "exact", match: "BBBBBB2" }] },
      }),
    );
    // force a distinguishable mtime
    const later = new Date(Date.now() + 5000);
    utimesSync(path, later, later);
    assert.deepEqual(source.rules().map((r) => r.label).sort(), ["a", "b"]);
    const reloaded = source.reload();
    assert.equal(reloaded.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("add/remove rule file helpers", () => {
  const dir = mkdtempSync(join(tmpdir(), "secret-rules-edit-"));
  const path = join(dir, "secret-mask-rules.json");
  try {
    assert.equal(addRuleToFile(path, "/p", { label: "g", type: "exact", match: "GLOBAL1" }, "global"), undefined);
    assert.equal(addRuleToFile(path, "/p", { label: "p", type: "exact", match: "PROJ0001" }, "project"), undefined);
    const source = new RulesSource(path, "/p");
    assert.deepEqual(source.rules().map((r) => r.label), ["p", "g"]);
    assert.equal(removeRuleFromFile(path, "/p", "p").removed, 1);
    assert.equal(removeRuleFromFile(path, "/p", "nope").removed, 0);
    assert.deepEqual(source.reload().map((r) => r.label), ["g"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
