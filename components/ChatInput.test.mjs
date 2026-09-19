import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput, ModelErrorBanner, ModelScopeWarningBanner, adjacentQueueTarget, buildExtContextSnapshot, canClearBuiltinCommandInput, canRestoreUserMessage, canRunBuiltinSlashCommandWhileStreaming, compressImageFile, cycleListIndex, filterModelOptions, getUpwardMenuMaxHeight, getUserMessageText, getUserMessageDraftImages, isExactSlashCommand, mergeText, mergeSubmission, modelSupportsImageInput, replaceLinksWithMarkdown, shouldCompressImageFile } = await jiti.import("./ChatInput.tsx");
const { ModelSelector } = await jiti.import("./ModelSelector.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

test("preserves pasted HTML links as Markdown without changing plain text layout", () => {
  const link = (label, href, occurrence = 0) => ({ label, href, occurrence });

  assert.equal(
    replaceLinksWithMarkdown(
      "Jobs:\nEngineer\nEngineer\nDone",
      [link("Engineer", "https://example.com/1"), link("Engineer", "https://example.com/2", 1)],
    ),
    "Jobs:\n[Engineer](https://example.com/1)\n[Engineer](https://example.com/2)\nDone",
  );
  assert.equal(
    replaceLinksWithMarkdown("Read [this]", [link("[this]", "https://example.com/a_(b)")]),
    "Read [\\[this\\]](https://example.com/a_\\(b\\))",
  );
  assert.equal(
    replaceLinksWithMarkdown("Engineer and Engineer", [link("Engineer", "https://example.com/job", 1)]),
    "Engineer and [Engineer](https://example.com/job)",
  );
  assert.equal(replaceLinksWithMarkdown("plain text", [link("missing", "https://example.com")]), null);
});

test("streaming Enter queues a follow-up; Alt+Enter is the exact inverse (steer now); empty-input Enter promotes to steer (fork semantics)", () => {
  const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findHandler(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleKeyDown") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findHandler);
  }
  // Execute the component's actual callback without mounting the rest of the UI.
  const script = new Script(ts.transpileModule(findHandler(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  const cases = [
    ["typed Enter queues as follow-up", { }, {}, "followup"],
    ["typed Alt+Enter is the inverse: steers immediately", { altKey: true }, {}, "steer"],
    ["typed Alt+Enter falls back to follow-up when steer is unavailable", { altKey: true }, { onSteer: undefined }, "followup"],
    ["empty-input Alt+Enter promotes the queue to steer (no queueable text to invert)", { altKey: true }, { value: "" }, "steer"],
    ["empty-input Enter promotes the queue to steer", { }, { value: "" }, "steer"],
    ["no follow-up capability falls back to steer", { }, { onFollowUp: undefined }, "steer"],
    ["Shift+Enter inserts a newline", { shiftKey: true }, {}, "native"],
    ["Alt+Shift+Enter keeps native behavior (newline wins over Alt)", { altKey: true, shiftKey: true }, {}, "native"],
    ["composition ref blocks sending", {}, { isComposingRef: { current: true } }, "native"],
    ["native composition blocks sending", { nativeEvent: { isComposing: true } }, {}, "native"],
    ["IME keyCode blocks sending", { nativeEvent: { keyCode: 229 } }, {}, "native"],
    ["composition grace blocks sending", {}, { lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["Alt+composition grace blocks sending", { altKey: true }, { lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["Enter falls back to follow-up when steer is unavailable", { }, { onSteer: undefined }, "followup"],
    ["Alt+Enter with both capabilities missing falls through to normal send", { altKey: true }, { onSteer: undefined, onFollowUp: undefined }, "send"],
    ["mobile Alt+Enter steers the same as desktop (no platform branch)", { altKey: true }, { isMobile: true }, "steer"],
    ["slash completion takes priority", {}, { slashMenuOpen: true, slashQuery: "help" }, "slash"],
    ["available built-in commands take priority", {}, { slashMenuOpen: true, slashQuery: "copy", value: "/copy", displayedSlashCommands: [{ name: "copy", source: "builtin", availableWhileStreaming: true }] }, "send"],
    ["file completion takes priority", {}, { atMenuOpen: true, atQuery: {} }, "file"],
    ["history selection takes priority", {}, { historyMenuOpen: true }, "history"],
  ];
  for (const [name, keys, state, expected] of cases) {
    let action = "native";
    const handler = script.runInNewContext({
      Date: { now: () => 1000 },
      COMPOSITION_END_ENTER_GRACE_MS: 100,
      isMobile: false, isStreaming: true,
      isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 },
      recalledRef: { current: false }, historyNavIndexRef: { current: 0 },
      valueRef: { current: "" }, isExactSlashCommand: (v) => false,
      historyNavTextRef: { current: null },
      historyMenuOpen: false, inputHistory: ["previous"], historyActiveIndex: 0,
      slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [{}], slashActiveIndex: 0,
      atMenuOpen: false, atQuery: null, atMatches: [{}], atActiveIndex: 0,
      onSteer() {}, onFollowUp() {},
      sendQueued(mode) { action = mode; }, handleSend() { action = "send"; },
      applySlashCommand() { action = "slash"; },
      isExactSlashCommand, value: "typed text", setSlashMenuOpen() {},
      applyAtCompletion() { action = "file"; },
      applyHistoryInput() { action = "history"; },
      ...state,
    });
    handler({
      key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault() { action = "prevented"; },
      ...keys,
    });
    assert.equal(action, expected, name);
  }
});

test("file mention arrows wrap around the match list", () => {
  const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findHandler(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleKeyDown") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findHandler);
  }
  const script = new Script(ts.transpileModule(findHandler(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);

  function move(key, atActiveIndex, length) {
    let next = null;
    const handler = script.runInNewContext({
      Date: { now: () => 1000 },
      COMPOSITION_END_ENTER_GRACE_MS: 100,
      isMobile: false, isStreaming: false,
      isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 },
      historyMenuOpen: false, inputHistory: [], historyActiveIndex: 0,
      slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [], slashActiveIndex: 0,
      atMenuOpen: true, atQuery: {}, atMatches: Array.from({ length }, () => ({})), atActiveIndex,
      onSteer() {}, onFollowUp() {},
      sendQueued() {}, handleSend() {},
      applySlashCommand() {},
      isExactSlashCommand() { return false; }, value: "@file",
      setSlashMenuOpen() {}, setAtMenuOpen() {},
      applyAtCompletion() {},
      applyHistoryInput() {},
      cycleListIndex,
      setAtActiveIndex(update) {
        next = typeof update === "function" ? update(atActiveIndex) : update;
      },
    });
    handler({
      key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 0 },
      preventDefault() {},
    });
    return next;
  }

  assert.equal(move("ArrowDown", 0, 3), 1);
  assert.equal(move("ArrowDown", 2, 3), 0);
  assert.equal(move("ArrowUp", 0, 3), 2);
  assert.equal(move("ArrowUp", 1, 3), 0);
  assert.equal(move("ArrowDown", 0, 1), 0);
  assert.equal(move("ArrowDown", 0, 0), 0);
});

test("cycleListIndex wraps in both directions", () => {
  assert.equal(cycleListIndex(0, 3, 1), 1);
  assert.equal(cycleListIndex(2, 3, 1), 0);
  assert.equal(cycleListIndex(0, 3, -1), 2);
  assert.equal(cycleListIndex(1, 3, -1), 0);
  assert.equal(cycleListIndex(0, 1, 1), 0);
  assert.equal(cycleListIndex(4, 0, 1), 0);
  assert.equal(cycleListIndex(-1, 4, 1), 0);
});

test("follow-up button renders with the fork hover-tooltip wrapper", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, onFollowUp() {}, isStreaming: true,
    })),
  );

  // Our follow-up button uses StreamingActionButton (bg/border/fg wrapper + hover popup hint);
  // the shortcut semantics are "Enter queues, pressing again upgrades to steer" rather than the
  // upstream Alt+Enter, hence no keyboard-shortcut title.
  assert.doesNotMatch(html, /aria-keyshortcuts/);
  assert.match(html, /follow-up/i);
});

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelErrorBanner, {
        error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Model error/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(
    renderToStaticMarkup(
      React.createElement(I18nProvider, null, React.createElement(ModelErrorBanner, { error: null })),
    ),
    "",
  );
});

test("renders enabledModels scope warnings", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelScopeWarningBanner, {
        warnings: ['No models match pattern "ghost-gateway/*"'],
      }),
    ),
  );

  assert.match(html, /Model scope warning/);
  assert.match(html, /ghost-gateway/);
  assert.equal(
    renderToStaticMarkup(
      React.createElement(I18nProvider, null, React.createElement(ModelScopeWarningBanner, { warnings: [] })),
    ),
    "",
  );
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        modelError: "Invalid models.json schema",
        modelList: [],
        modelNames: {},
      }),
    ),
  );

  assert.match(html, />No models</);
  assert.match(html, /title="No available models"/);
});

test("renders the read-only tool preset as the active selection", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onToolPresetChange() {},
        isStreaming: false,
        toolPreset: "read-only",
      }),
    ),
  );

  assert.match(html, /title="Change tool preset: read-only"/);
  assert.match(html, />read-only<\/span>/);
});

test("renders the empty tool preset as Chat only", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onToolPresetChange() {},
        isStreaming: false,
        toolPreset: "none",
      }),
    ),
  );

  assert.match(html, /title="Change tool preset: Chat only"/);
  assert.match(html, />Chat only<\/span>/);
});

test("renders the compact composer with the standard Send button and no session controls", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        compact: true,
      }),
    ),
  );

  assert.match(html, /<textarea/);
  assert.match(html, />Send<\/button>/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.doesNotMatch(html, /type="file"|Attach image|Change tool preset/);
});

test("shows and locks the optimistic model while a switch is pending", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
        modelList: [{ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
        modelSwitching: true,
      }),
    ),
  );

  // Upstream ModelSelector: shows busy copy while switching (i18n consolidation to follow)
  assert.match(html, /title="Switching model"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, />DeepSeek V4 Flash</);
  assert.match(html, /animation:spin 0\.8s linear infinite/);
});

test("filters model options by name and id", () => {
  const options = [
    { provider: "ollama", modelId: "qwen3:latest", name: "Qwen 3" },
    { provider: "anthropic", modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { provider: "openai", modelId: "gpt-5.4", name: "GPT-5.4" },
  ];

  assert.deepEqual(filterModelOptions(options, "QWEN"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "claude-sonnet"), [options[1]]);
  assert.equal(filterModelOptions(options, "OpenAI").length, 1); // provider participates in matching: searching a provider name hits its models
  assert.equal(filterModelOptions(options, "anthropic/claude").length, 0); // a slash-joined compound string is not a substring, so no match
  assert.equal(filterModelOptions(options, "anthropic/claude").length, 0);
  assert.equal(filterModelOptions(options, "missing").length, 0);
  assert.equal(filterModelOptions(options, "  "), options);
});

test("renders the shared field model selector as a disabled gray control", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelSelector, {
        options: [{ provider: "openai", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
        value: null,
        onChange() {},
        onClear() {},
        emptyLabel: "Parent default",
        ariaLabel: "Model override",
        disabled: true,
        variant: "field",
      }),
    ),
  );

  assert.match(html, /aria-label="Model override"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /background:var\(--bg-panel\)/);
  assert.match(html, />Parent default</);
});

test("caps an upward menu to the visible space above its anchor", () => {
  assert.equal(getUpwardMenuMaxHeight(343, 36), 299);
  assert.equal(getUpwardMenuMaxHeight(40, 36), 0);
  // Composer sitting under a 36px top bar with only ~160px of air: a 400px
  // file list would paint through the bar and hide the leading matches.
  assert.equal(getUpwardMenuMaxHeight(200, 36), 156);
  assert.ok(getUpwardMenuMaxHeight(200, 36) < 400);
});

test("file mention menu applies the measured upward height cap", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const start = source.indexOf("{atMenuOpen && atQuery !== null && (() => {");
  assert.notEqual(start, -1);
  const block = source.slice(start, start + 4000);
  assert.match(block, /ref=\{atMenuRef\}/);
  assert.match(block, /min\(48vh, 400px, \$\{atMenuMaxHeight\}px\)/);
  assert.match(block, /flexDirection: "column"/);
  assert.match(block, /minHeight: 0/);
  assert.equal(block.includes("maxHeight: \"min(48vh, 400px)\""), false);
});

test("file mention menu remeasures when its layout container shifts the anchor", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const start = source.indexOf("function subscribeUpwardMenuMaxHeight");
  assert.notEqual(start, -1);
  const block = source.slice(start, start + 1800);
  assert.match(block, /const layoutContainer = parent\?\.parentElement;/);
  assert.match(block, /anchorObserver\?\.observe\(layoutContainer\)/);
});

test("compresses large images while preserving small images and GIFs", async () => {
  assert.equal(shouldCompressImageFile({ size: 1024 * 1024, type: "image/png" }), false);
  assert.equal(shouldCompressImageFile({ size: 1024 * 1024 + 1, type: "image/png" }), true);
  assert.equal(shouldCompressImageFile({ size: 2 * 1024 * 1024, type: "image/gif" }), false);

  const originals = {
    FileReader: globalThis.FileReader,
    createImageBitmap: globalThis.createImageBitmap,
    document: globalThis.document,
  };
  let bitmapCalls = 0;
  let closed = false;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }),
    toDataURL: () => "data:image/jpeg;base64,COMPRESSED",
  };

  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,ORIGINAL";
      this.onload();
    }
  };
  globalThis.createImageBitmap = async () => {
    bitmapCalls += 1;
    return { width: 2048, height: 1024, close() { closed = true; } };
  };
  globalThis.document = { createElement: () => canvas };

  try {
    assert.deepEqual(await compressImageFile({ size: 1024, type: "image/png" }), {
      data: "ORIGINAL",
      mimeType: "image/png",
    });
    assert.deepEqual(await compressImageFile({ size: 2 * 1024 * 1024, type: "image/png" }), {
      data: "COMPRESSED",
      mimeType: "image/jpeg",
    });
    assert.equal(bitmapCalls, 1);
    assert.equal(canvas.width, 1024);
    assert.equal(canvas.height, 512);
    assert.equal(closed, true);
  } finally {
    globalThis.FileReader = originals.FileReader;
    globalThis.createImageBitmap = originals.createImageBitmap;
    globalThis.document = originals.document;
  }
});

test("recognizes exact slash commands for one-Enter submission", () => {
  const builtin = { name: "copy", description: "", source: "builtin" };
  assert.equal(isExactSlashCommand("/copy", builtin), true);
  assert.equal(isExactSlashCommand("  /copy  ", builtin), true);
  assert.equal(isExactSlashCommand("/co", builtin), false);
  assert.equal(isExactSlashCommand("/copy extra", builtin), false);
  assert.equal(isExactSlashCommand("/copy", { ...builtin, source: "extension" }), false);
});

test("clears a completed built-in only while its submitted input is unchanged", () => {
  assert.equal(canClearBuiltinCommandInput("/copy", 0, "/copy"), true);
  assert.equal(canClearBuiltinCommandInput("new follow-up", 0, "/copy"), false);
  assert.equal(canClearBuiltinCommandInput("/copy", 1, "/copy"), false);
});

test("locks built-in command submission until it settles", async () => {
  const sourceText = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("ChatInput.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findCallback(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "runBuiltinCommand") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findCallback);
  }
  const callback = new Script(ts.transpileModule(findCallback(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext({
    attachedImages: [],
    attachedImagesRef: { current: [] },
    builtinCommandPendingRef: { current: false },
    canClearBuiltinCommandInput,
    clearInput() {},
    onBuiltinCommand: async () => new Promise((resolve) => { callback.resolve = resolve; }),
    setBuiltinCommandPending(value) { callback.pendingStates.push(value); },
    valueRef: { current: "/reload" },
  });
  callback.pendingStates = [];

  const first = callback("/reload");
  assert.deepEqual(callback.pendingStates, [true]);
  assert.equal(await callback("/reload"), true);
  assert.deepEqual(callback.pendingStates, [true]);
  callback.resolve({ handled: true });
  assert.equal(await first, true);
  assert.deepEqual(callback.pendingStates, [true, false]);
  assert.match(sourceText, /<fieldset\s+disabled=\{builtinCommandPending\}\s+aria-busy=\{builtinCommandPending\}/);
});

test("keeps only read-only built-ins available while a run is active", () => {
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/copy"), true);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/session"), true);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/compact"), false);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/reload"), false);
});

test("restores text and base64 images when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "text", text: "Review this image @src/example.ts " },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ],
  };

  assert.equal(getUserMessageText(message), "Review this image @src/example.ts ");
  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/png" },
  ]);
});

test("restores legacy flat image entries when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "image", data: "AQID", mimeType: "image/jpeg" },
    ],
  };

  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/jpeg" },
  ]);
});

test("does not restore a historical message over a pending image attachment", () => {
  assert.equal(canRestoreUserMessage("", 0, 0), true);
  assert.equal(canRestoreUserMessage("", 1, 0), false);
  assert.equal(canRestoreUserMessage("", 0, 1), false);
  assert.equal(canRestoreUserMessage("draft", 0, 0), false);
});

test("restores a cleared submission using the queued React state", () => {
  let value = "failed submission";
  const updates = [
    () => "",
    (current) => mergeText("failed submission", current),
  ];

  for (const update of updates) value = update(value);

  assert.equal(value, "failed submission");
  assert.equal(
    mergeText("failed submission", "new draft"),
    "failed submission\n\nnew draft",
  );
  assert.equal(
    mergeText("failed submission", "failed submission"),
    "failed submission\n\nfailed submission",
  );
});

test("keeps a failed first submission recoverable across a composer remount", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeSubmission(
    "failed submission",
    [image],
    "",
    [],
  );

  assert.deepEqual(restored, {
    value: "failed submission",
    images: [image],
  });
  assert.deepEqual(
    mergeSubmission("failed submission", [image], "new draft", []),
    {
      value: "failed submission\n\nnew draft",
      images: [image],
    },
  );
});

test("preserves duplicate image attachments when restoring a submission", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeSubmission("", [image, image], "", [image]);

  assert.deepEqual(restored.images, [image, image, image]);
});

// ── ↑/↓ queue navigation targets (flattened [steering…, followUp…], same order as the panel display) ──

test("queue nav: empty-input Up picks the last followUp entry", () => {
  // followUp first: take the last followUp entry
  assert.deepEqual(
    adjacentQueueTarget("followUp", 0, 0, 0, -1), null,
  );
  assert.deepEqual(
    adjacentQueueTarget("followUp", 2, 0, 3, -1),
    { kind: "followUp", index: 1 },
  );
});

test("queue nav: flattened order is steering first then followUp", () => {
  // steering=[S0], followUp=[F0,F1,F2] → flat [S0,F0,F1,F2]
  // from F0 (flat 1) Up → S0; from S0 (flat 0) Down → F0
  assert.deepEqual(
    adjacentQueueTarget("followUp", 0, 1, 3, -1),
    { kind: "steer", index: 0 },
  );
  assert.deepEqual(
    adjacentQueueTarget("steer", 0, 1, 3, 1),
    { kind: "followUp", index: 0 },
  );
});

test("queue nav: boundaries keep the current edit in place", () => {
  // at the top (first entry ↑) / bottom (last entry ↓) → null (no move)
  assert.deepEqual(adjacentQueueTarget("steer", 0, 2, 1, -1), null);
  assert.deepEqual(adjacentQueueTarget("followUp", 2, 1, 3, 1), null);
  assert.deepEqual(adjacentQueueTarget("followUp", 0, 0, 0, 1), null);
});

test("renders compact errors above the input as a wrapping alert", () => {
  const error = "Compaction failed: OpenAI API error (403): <html>request forbidden</html>";
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onCompact() {},
        isStreaming: false,
        compactError: error,
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Compaction failed: OpenAI API error/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
  assert.match(html, /white-space:pre-wrap/);
  assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
});

test("modelSupportsImageInput warns only when modality info is known and lacks image", () => {
  const modelList = [
    { id: "text-only", name: "Text Only", provider: "ollama", input: ["text"] },
    { id: "vision", name: "Vision", provider: "anthropic", input: ["text", "image"] },
    { id: "unknown", name: "Unknown", provider: "custom", input: undefined },
  ];

  assert.equal(modelSupportsImageInput({ provider: "ollama", modelId: "text-only" }, modelList), false);
  assert.equal(modelSupportsImageInput({ provider: "anthropic", modelId: "vision" }, modelList), true);
  // Unknown modality info never blocks the user.
  assert.equal(modelSupportsImageInput({ provider: "custom", modelId: "unknown" }, modelList), true);
  // Model missing from the list is treated as unknown.
  assert.equal(modelSupportsImageInput({ provider: "x", modelId: "missing" }, modelList), true);
  assert.equal(modelSupportsImageInput(null, modelList), true);
  assert.equal(modelSupportsImageInput({ provider: "ollama", modelId: "text-only" }, undefined), true);
});

test("renders image warnings for known text-only defaults without an explicit model selection", { skip: "depends on lib/draft-store.ts — this fork moved it out to the draft-keeper extension (composer contract P2); until contract injection is restored there is no way to drive the draft image-attach path. The intent is pinned jointly by the [fork] render-condition test below and the modelSupportsImageInput pure-function test above" }, () => {
  const draftKey = "new:/tmp/image-warning-default";
  const modelList = [
    { id: "text-only", name: "Text Only", provider: "custom", input: ["text"] },
    { id: "vision", name: "Vision", provider: "custom", input: ["text", "image"] },
    { id: "unknown", name: "Unknown", provider: "custom" },
  ];
  setDraft(draftKey, {
    value: "Describe this image",
    images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
  });

  try {
    for (const [modelId, warningExpected] of [["text-only", true], ["vision", false], ["unknown", false], [null, false]]) {
      const html = renderToStaticMarkup(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(ChatInput, {
            onSend() {},
            onAbort() {},
            isStreaming: false,
            isAutoModelSelection: true,
            model: modelId ? { provider: "custom", modelId } : null,
            modelList,
            draftKey,
          }),
        ),
      );

      assert.match(html, /<img/);
      assert.equal(html.includes("Images may not be sent"), warningExpected, `default model: ${modelId}`);
      if (warningExpected) {
        assert.match(html, /The selected model \(Text Only\) does not support image input/);
        assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
      }
    }
  } finally {
    clearDraft(draftKey);
  }
});

test("[fork] image-warning render-condition pin: attachedImages>0 and the model is confirmed to lack image support and not manually dismissed (equivalent coverage after the draft pipeline was moved out)", () => {
  // The upstream case drives end-to-end rendering via draft-store; in this fork the image source
  // is contract injection from the draft-keeper extension (attachedImages props), so this pins
  // the render decision itself to guard against render-logic regressions until the contract is
  // restored.
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(source, /const showImageUnsupportedWarning = \(\n[\s\S]{0,160}?attachedImages\.length > 0[\s\S]{0,160}?!modelSupportsImageInput\(model, modelList\)[\s\S]{0,160}?!imageWarningDismissed/);
  // Reset when images are re-attached in the same session after a manual dismiss (don't swallow later warnings)
  assert.match(source, /if \(attachedImages\.length === 0\) setImageWarningDismissed\(false\);/);
});

// ── context-meter extension seam (see its extension plan doc, §4) ──

test("context-meter extension seam: buildExtContextSnapshot maps contextUsage and passes null through", () => {
  const urgency = { level: "warn", color: "rgba(234,179,8,0.95)", bg: "rgba(234,179,8,0.1)", border: "rgba(234,179,8,0.4)" };
  assert.deepEqual(
    buildExtContextSnapshot({ percent: 72.4, contextWindow: 200000, tokens: 144800 }, urgency),
    { percent: 72.4, contextWindow: 200000, tokens: 144800, urgency },
  );
  // null/undefined pass through as null (extension gray state); missing fields fall back to null without throwing
  assert.equal(buildExtContextSnapshot(null, urgency), null);
  assert.equal(buildExtContextSnapshot(undefined, urgency), null);
  assert.deepEqual(
    buildExtContextSnapshot({ percent: null, contextWindow: 200000, tokens: null }, urgency),
    { percent: null, contextWindow: 200000, tokens: null, urgency },
  );
});

test("context-meter extension seam: composerTools extra carries data-only context/compact; callbacks go through the composer service (slot-extra callback decoupling, 2026-09-16)", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  // The mobile model-info lead slot has exactly 2 render points (expanded input row + InfoSheet
  // model row), sharing the same memo extra
  assert.equal((source.match(/name="modelInfoLead"/g) || []).length, 2, "modelInfoLead should have exactly 2 render points");
  assert.equal((source.match(/extra=\{modelInfoLeadExtra\}/g) || []).length, 2, "both modelInfoLead points should share modelInfoLeadExtra (spelling drift has converged)");
  // The desktop compact-button lead slot has exactly 1 render point (moved here from the composerTools row end in v0.1.2)
  assert.equal((source.match(/name="compactLead"/g) || []).length, 1, "compactLead should have exactly 1 render point");
  // Callbacks are service-backed: the composer service registration + openSessionInfo (close the sheet first, then open the panel) must be in the service set
  assert.match(source, /registerExtClientService\(HOST_COMPOSER_SERVICE\.provider, HOST_COMPOSER_SERVICE\.name/);
  assert.match(source, /openSessionInfo: \(\) => \{ setInfoSheetOpen\(false\); onSessionStatsPanelOpen\?\.\(\); \}/);
  // composerTools (desktop) extra carries the three seam fields
  const composerIdx = source.indexOf('name="composerTools"');
  assert.ok(composerIdx > 0, "the composerTools slot exists");
  const extraStart = source.indexOf("extra={{", composerIdx);
  const extraEnd = source.indexOf("}} />", extraStart);
  const extraBlock = source.slice(extraStart, extraEnd);
  for (const key of ["context: extSeamContext", "compact: extSeamCompact"]) {
    assert.ok(extraBlock.includes(key), `composerTools extra is missing ${key}`);
  }
  assert.ok(!extraBlock.includes("openSessionInfo"), "composerTools extra must no longer contain openSessionInfo (moved to the service)");
  assert.ok(!extraBlock.includes("queueActions"), "composerTools extra must no longer contain queueActions (moved to the service)");
});

// ── Mobile new-session composer is never collapsed (2026-09 user decision: the welcome page has enough space, no need to collapse the input) ──
test("mobile new-session collapse fully disabled: foldDisabled derivation + initialization falls back to full + handle/gesture/cycle all guarded", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  // derivation: mobile with no session id (welcome page) → collapsing disabled; the render layer consistently uses effectiveBottomMode (always full)
  assert.match(source, /const foldDisabled = isMobile && sessionId == null;/);
  assert.match(source, /const effectiveBottomMode: BottomMode = foldDisabled \? "full" : bottomMode;/);
  // initialization: ignore persisted minimal/queueHidden; the welcome page mounts as full
  assert.match(source, /if \(isMobile && sessionId == null\) return "full";/);
  // all three entries (cycle/gesture/handle) are guarded so minimal is unreachable while foldDisabled
  assert.match(source, /const cycleBottomMode = useCallback\(\(dir: 1 \| -1 = 1, wrap = true\) => \{\n    if \(foldDisabled\) return;/);
  assert.match(source, /if \(foldDisabled\) \{\n      \/\/ Mobile new-session \(welcome page\): collapsing fully disabled, swipe gestures not registered/);
  assert.match(source, /isMobile && !foldDisabled && \(effectiveBottomMode !== "full"/);
  // All three bottomMode checks in the render layer go through effectiveBottomMode (minimal branch / queue panel / quote bar / desktop collapse bar)
  assert.doesNotMatch(source, /\{[a-zA-Z ]*bottomMode === "full" && <ExtSlot name="queuePanel"/);
  assert.match(source, /effectiveBottomMode === "minimal" \? \(/);
  assert.ok((source.match(/effectiveBottomMode/g) || []).length >= 7, "render and derivation should all go through effectiveBottomMode");
});

// ── Mobile collapse hint (2026-09 user decision: after collapsing, show a toast guiding a swipe-up to pull out + low-frequency handle pulsing) ──
test("mobile minimal collapse guidance: entering shows a swipe-up-to-pull-out toast (clickable to expand) + floating handle low-frequency pulse", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  // Every entry into minimal (on mobile) triggers the toast, auto-dismissed after 4s; cleanup cancels the timer
  assert.match(source, /if \(!isMobile \|\| effectiveBottomMode !== "minimal" \|\| prev === "minimal"\) return;/);
  assert.match(source, /setCollapseHintVisible\(true\);/);
  assert.match(source, /window\.setTimeout\(\(\) => setCollapseHintVisible\(false\), 4000\);/);
  // toast copy i18n key + click to expand
  assert.match(source, /chat\.collapsedPullUpHint/);
  assert.match(source, /onClick=\{\(\) => cycleBottomMode\(\)\}\n\s+title=\{t\("chat\.restoreBottom"\)\}/);
  // The pulse class only goes on the minimal floating handle itself (the toast doesn't pulse), with a reduced-motion fallback
  assert.match(source, /<div className="chat-collapse-handle-breathe">/);
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /@keyframes collapse-handle-breathe/);
  assert.match(css, /chat-collapse-handle-breathe \{\n\s+animation: collapse-handle-breathe 2\.4s ease-in-out infinite;/);
  assert.match(css, /\.chat-collapse-handle-breathe \{\n\s+animation: none !important;/);
});

// ── Mobile bottom-row overflow prevention (2026-09-14 user feedback: too many buttons to fit) ──
test("mobile bottom row pinned to both ends: the model fills the middle space (flex 1 1 0) and the right-side buttons are unaffected by model name length", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  // The model wrapper is the only flexible item: it takes all the middle space; name length only affects its own ellipsis truncation
  assert.match(source, /flex: "1 1 0", minWidth: 0, display: "flex"/);
  assert.doesNotMatch(source, /maxWidth: 150/, "the 150px cap would hand the middle space back to flexible gaps (the model no longer fills it)");
  assert.doesNotMatch(source, /isMobile && mobileExpanded && !compact && <span aria-hidden="true" style=\{\{ flex: 1 \}\} \/>/, "the flexible-gap span is retired (competing with the model flex would split the space in half)");
  // Ultra-narrow-screen fallback: the whole group can shrink; both mobile ModelSelectors hide the leading icon
  assert.match(source, /minWidth: 0, flexShrink: 1, flexGrow: \(isMobile && mobileExpanded\)/);
  const hideIconCount = (source.match(/\bhideIcon\b/g) || []).length;
  assert.ok(hideIconCount >= 2, `both mobile ModelSelectors need hideIcon (found ${hideIconCount})`);
});
