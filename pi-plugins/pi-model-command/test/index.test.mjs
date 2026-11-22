import assert from "node:assert/strict";
import test from "node:test";

const { default: modelCommand, modelLabel, resolveModelChoice, formatCandidates, pickerModels } = await import(
  "../src/index.ts",
);

const MODELS = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" },
  { provider: "openai", id: "gpt-5", name: "GPT-5" },
  { provider: "zai-coding-cn", id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
];

test("labels are provider/id", () => {
  assert.equal(modelLabel(MODELS[0]), "anthropic/claude-sonnet-4-5");
});

test("an exact provider/id resolves", () => {
  const r = resolveModelChoice(MODELS, "openai/gpt-5");
  assert.equal(r.kind, "model");
  assert.equal(r.model.id, "gpt-5");
});

test("provider/id matching ignores case and surrounding space", () => {
  const r = resolveModelChoice(MODELS, "  OpenAI/GPT-5  ");
  assert.equal(r.kind, "model");
  assert.equal(r.model.id, "gpt-5");
});

test("a bare id resolves when it is unique", () => {
  const r = resolveModelChoice(MODELS, "glm-5.3-flash");
  assert.equal(r.kind, "model");
  assert.equal(r.model.provider, "zai-coding-cn");
});

test("a display name resolves when it is unique", () => {
  const r = resolveModelChoice(MODELS, "Claude Opus 4.1");
  assert.equal(r.kind, "model");
  assert.equal(r.model.id, "claude-opus-4-1");
});

test("a single substring match resolves", () => {
  const r = resolveModelChoice(MODELS, "opus");
  assert.equal(r.kind, "model");
  assert.equal(r.model.id, "claude-opus-4-1");
});

test("several substring matches are ambiguous, not a silent pick", () => {
  const r = resolveModelChoice(MODELS, "claude");
  assert.equal(r.kind, "ambiguous");
  assert.deepEqual(r.candidates.map((m) => m.id).sort(), ["claude-opus-4-1", "claude-sonnet-4-5"]);
});

test("an unknown reference resolves to none", () => {
  assert.equal(resolveModelChoice(MODELS, "nope-9000").kind, "none");
  assert.equal(resolveModelChoice(MODELS, "   ").kind, "none");
});

test("candidate formatting caps long lists", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ provider: "p", id: `m${i}` }));
  const text = formatCandidates(many, 5);
  assert.match(text, /^p\/m0, p\/m1, p\/m2, p\/m3, p\/m4 \(\+15 more\)$/);
  assert.equal(formatCandidates(many.slice(0, 2)), "p/m0, p/m1");
});

test("the session scope wins over the whole catalogue", () => {
  const scoped = { model: MODELS[2] };
  const ctx = {
    scopedModels: [scoped],
    modelRegistry: { getAvailable: () => MODELS },
  };
  assert.deepEqual(pickerModels(ctx), [MODELS[2]]);
});

test("an empty scope falls back to the available catalogue", () => {
  const ctx = {
    scopedModels: [],
    modelRegistry: { getAvailable: () => MODELS },
  };
  assert.deepEqual(pickerModels(ctx), MODELS);
});

function fakeHost({ ui = true, selectResult, notify = [] } = {}) {
  const commands = new Map();
  const calls = { setModel: [] };
  const pi = {
    registerCommand(name, options) {
      commands.set(name, options);
    },
    async setModel(model) {
      calls.setModel.push(model);
      return true;
    },
  };
  const ctx = {
    hasUI: ui,
    scopedModels: [],
    modelRegistry: {
      getAvailable: () => MODELS,
      find: (provider, id) => MODELS.find((m) => m.provider === provider && m.id === id),
    },
    ui: {
      notify: (message, level) => notify.push({ message, level }),
      select: async () => selectResult,
    },
  };
  return { pi, ctx, commands, calls, notify };
}

test("the command is registered as models", () => {
  const host = fakeHost();
  modelCommand(host.pi);
  assert.deepEqual([...host.commands.keys()], ["models"]);
});

test("with an argument the model is set without a dialog", async () => {
  const host = fakeHost();
  modelCommand(host.pi);
  await host.commands.get("models").handler("openai/gpt-5", host.ctx);
  assert.equal(host.calls.setModel.length, 1);
  assert.equal(host.calls.setModel[0].id, "gpt-5");
});

test("without an argument the picker is shown and the choice applied", async () => {
  const host = fakeHost({ selectResult: "anthropic/claude-opus-4-1" });
  modelCommand(host.pi);
  await host.commands.get("models").handler("", host.ctx);
  assert.equal(host.calls.setModel.length, 1);
  assert.equal(host.calls.setModel[0].id, "claude-opus-4-1");
});

test("cancelling the picker changes nothing", async () => {
  const host = fakeHost({ selectResult: undefined });
  modelCommand(host.pi);
  await host.commands.get("models").handler("", host.ctx);
  assert.equal(host.calls.setModel.length, 0);
});

test("a host without dialogs gets the list instead of a picker", async () => {
  const notify = [];
  const host = fakeHost({ ui: false, notify });
  modelCommand(host.pi);
  await host.commands.get("models").handler("", host.ctx);
  assert.equal(host.calls.setModel.length, 0);
  assert.match(notify[0].message, /anthropic\/claude-sonnet-4-5/);
});

test("an ambiguous reference lists candidates and sets nothing", async () => {
  const notify = [];
  const host = fakeHost({ notify });
  modelCommand(host.pi);
  await host.commands.get("models").handler("claude", host.ctx);
  assert.equal(host.calls.setModel.length, 0);
  assert.match(notify[0].message, /Ambiguous/);
  assert.match(notify[0].message, /claude-opus-4-1/);
});

test("an unknown reference reports an error and sets nothing", async () => {
  const notify = [];
  const host = fakeHost({ notify });
  modelCommand(host.pi);
  await host.commands.get("models").handler("nope", host.ctx);
  assert.equal(host.calls.setModel.length, 0);
  assert.equal(notify[0].level, "error");
});
