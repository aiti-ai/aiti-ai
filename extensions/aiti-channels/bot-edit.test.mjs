/**
 * aiti-channels · bot-edit unit tests — surgical TOML text editing (pure).
 *
 * Run: node --test extensions/aiti-channels/bot-edit.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { readCardModes, setCardMode } = await import("./lib/bot-edit.ts");

const SAMPLE = `# top comment
[management]
enabled = true
port = 9820

[display]
mode = "full"

[[projects]]
name = "alpha"
agent = "piweb"
work_dir = "/tmp/a"

  [projects.display]
  mode = "compact"

  [[projects.platforms]]
  type = "feishu"
  app_id = "cli_x"

[[projects]]
name = "beta"
agent = "piweb"

  [[projects.platforms]]
  type = "telegram"
  token = "1:abc"
`;

test("readCardModes: absent card_mode = null / legacy defaults tolerated", () => {
  const r = readCardModes(SAMPLE);
  assert.equal(r.global, null); // [display] exists but no card_mode line
  assert.deepEqual(r.byProject, {});
});

test("readCardModes: picks up global + per-project values", () => {
  const r = readCardModes(SAMPLE.replace('mode = "full"', 'mode = "full"\ncard_mode = "legacy"').replace("[projects.display]\n  mode = \"compact\"", "[projects.display]\n  mode = \"compact\"\n  card_mode = \"rich\""));
  assert.equal(r.global, "legacy");
  assert.deepEqual(r.byProject, { alpha: "rich" });
});

test("setCardMode global: creates [display] when missing", () => {
  const minimal = `[management]\nport = 9820\n`;
  const r = setCardMode(minimal, "rich");
  assert.equal(r.scope, "global");
  assert.ok(r.raw.includes("[display]\ncard_mode = \"rich\""));
  assert.equal(readCardModes(r.raw).global, "rich");
});

test("setCardMode global: replaces existing line, keeps neighbors", () => {
  const r = setCardMode(SAMPLE.replace("[display]\nmode = \"full\"", "[display]\nmode = \"full\"\ncard_mode = \"legacy\""), "rich");
  assert.equal(r.scope, "global");
  assert.ok(r.raw.includes('card_mode = "rich"'));
  assert.ok(!r.raw.includes('card_mode = "legacy"'));
  assert.ok(r.raw.includes('mode = "full"'));
});

test("setCardMode project: adds [projects.display] before sub-tables", () => {
  const r = setCardMode(SAMPLE, "rich", "beta");
  assert.equal(r.scope, "project:beta");
  const modes = readCardModes(r.raw);
  assert.equal(modes.byProject.beta, "rich");
  // alpha untouched
  assert.equal(modes.byProject.alpha, undefined);
  // beta block: display sub-table inserted before its platforms table
  const betaIdx = r.raw.indexOf('name = "beta"');
  const dispIdx = r.raw.indexOf("[projects.display]", betaIdx);
  const platIdx = r.raw.indexOf("[[projects.platforms]]", betaIdx);
  assert.ok(dispIdx > 0 && dispIdx < platIdx);
});

test("setCardMode project: edits existing sub-table, survives sibling sub-tables", () => {
  const r = setCardMode(SAMPLE, "legacy", "alpha");
  assert.equal(r.scope, "project:alpha");
  assert.equal(readCardModes(r.raw).byProject.alpha, "legacy");
  // mode = "compact" sibling line preserved
  assert.ok(r.raw.includes('mode = "compact"'));
  // platforms sub-table preserved
  assert.ok(r.raw.includes('app_id = "cli_x"'));
});

test("setCardMode project: throws on unknown project", () => {
  assert.throws(() => setCardMode(SAMPLE, "rich", "nope"), /not found/);
});

test("setCardMode: idempotent (set same value twice = same text)", () => {
  const once = setCardMode(SAMPLE, "rich", "alpha").raw;
  const twice = setCardMode(once, "rich", "alpha").raw;
  assert.equal(once, twice);
});
