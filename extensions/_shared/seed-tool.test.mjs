/**
 * _shared/seed-tool — unit tests for the shared convention of converting an indexed tool row into
 * pi-native tool entries (D18 normalization).
 *
 * Pins the unified behavior after the four families' (zcode/opencode/qoder/codebuddy) seedHistory
 * convergence: strict-shape coerce (moved over from zcode-core), empty-result placeholder vs absent
 * result creating no entry, the incrementing synthetic-paired-id semantics when callID is absent,
 * and model/provider's "absent omitted / empty string kept".
 *
 * Run: node --experimental-strip-types --test pi-web-ext/_shared/seed-tool.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { EMPTY_TOOL_ERROR, EMPTY_TOOL_OUTPUT, createSeedToolReplay, normalizeSeedTool, seedToolResultText } =
  await import("@aiti-ai/ext-shared/seed-tool");

test("normalizeSeedTool: strict-shape normalization + invalid falls back to null", () => {
  assert.deepEqual(
    normalizeSeedTool({ callID: "call_1", name: "Bash", input: { command: "pwd" }, output: "/home" }),
    { callID: "call_1", name: "Bash", input: { command: "pwd" }, output: "/home" },
  );
  assert.deepEqual(normalizeSeedTool({ name: "Read", input: null, isError: true }), { name: "Read", input: {}, isError: true });
  assert.equal(normalizeSeedTool({ input: {} }), null, "missing name");
  assert.equal(normalizeSeedTool("text"), null);
  assert.equal(normalizeSeedTool(null), null);
  assert.equal(normalizeSeedTool([{ name: "Bash" }]), null, "an array is not a tool row");
  assert.deepEqual(normalizeSeedTool({ name: "B", input: "raw" })?.input, {}, "non-object input -> empty-object fallback");
  assert.equal(normalizeSeedTool({ name: "B", output: 123 }).output, undefined, "non-string output dropped");
});

test("empty output and absent output are semantically distinct", () => {
  assert.equal(normalizeSeedTool({ name: "B" }).output, undefined);
  assert.equal(seedToolResultText({ name: "B", input: {}, output: "ok" }), "ok");
  assert.equal(seedToolResultText({ name: "B", input: {}, output: "" }), EMPTY_TOOL_OUTPUT);
  assert.equal(seedToolResultText({ name: "B", input: {}, output: "  \n", isError: true }), EMPTY_TOOL_ERROR);
});

test("replay: pairs a toolCall + toolResult by callID", () => {
  const replay = createSeedToolReplay("x-tool");
  const out = replay.entries({ callID: "call_1", name: "Bash", input: { command: "ls" }, output: "dist" });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "call_1", toolName: "Bash", input: { command: "ls" } }],
  });
  assert.deepEqual(out[1], {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "Bash",
    content: [{ type: "text", text: "dist" }],
  });
});

test("replay: isError passes through; empty results still pair (placeholder copy)", () => {
  const replay = createSeedToolReplay("x-tool");
  const err = replay.entries({ callID: "c1", name: "Read", output: "boom", isError: true });
  assert.equal(err[1].isError, true);
  const empty = replay.entries({ callID: "c2", name: "Touch", output: "" });
  assert.deepEqual(empty[1].content, [{ type: "text", text: EMPTY_TOOL_OUTPUT }]);
});

test("replay: absent result emits only the call card (never invents a toolResult)", () => {
  const replay = createSeedToolReplay("x-tool");
  const out = replay.entries({ callID: "c3", name: "Read", input: { path: "/y" } });
  assert.equal(out.length, 1);
  assert.equal(out[0].content[0].toolCallId, "c3");
});

test("replay: absent callID synthesizes from the prefix, incrementing across rows; a new replayer restarts the count", () => {
  const replay = createSeedToolReplay("qoder-tool");
  const a = replay.entries({ name: "Bash", output: "1" });
  const b = replay.entries({ name: "Bash", output: "2" });
  assert.equal(a[0].content[0].toolCallId, "qoder-tool-1");
  assert.equal(b[0].content[0].toolCallId, "qoder-tool-2");
  assert.equal(b[1].toolCallId, "qoder-tool-2", "the result entry pairs with the synthesized id");
  assert.equal(createSeedToolReplay("zcode-tool").entries({ name: "Bash" })[0].content[0].toolCallId, "zcode-tool-1");
});

test("replay: absent model/provider omitted, empty strings kept (each family's existing spelling)", () => {
  const replay = createSeedToolReplay("x-tool");
  assert.equal("model" in replay.entries({ name: "B" })[0], false);
  assert.equal("provider" in replay.entries({ name: "B" })[0], false);
  const withOpts = replay.entries({ name: "B" }, { model: "glm-4.7", provider: undefined })[0];
  assert.equal(withOpts.model, "glm-4.7");
  assert.equal("provider" in withOpts, false);
  const qoderish = replay.entries({ name: "B" }, { model: "", provider: "aiti-qoder-agent" })[0];
  assert.equal(qoderish.model, "", "same shape as the qoder live path: an empty model is written as-is");
  assert.equal(qoderish.provider, "aiti-qoder-agent");
});

test("replay: invalid/non-tool rows return null, leaving the text fallback to the caller", () => {
  const replay = createSeedToolReplay("x-tool");
  assert.equal(replay.entries(undefined), null);
  assert.equal(replay.entries('🛠 Bash {"command":"ls"}'), null);
  assert.equal(replay.entries({ name: "" }), null);
});
