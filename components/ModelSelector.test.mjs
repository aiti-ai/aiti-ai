import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const {
  RECENT_MODELS_KEY,
  RECENT_MODELS_LIMIT,
  readRecentModels,
  rememberRecentModel,
  pickRecentOptions,
  excludeRecentOptions,
} = await jiti.import("./ModelSelector.tsx");

/** Per-test localStorage stub (Node has no window.localStorage) */
function installStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  globalThis.window = {
    localStorage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    },
  };
  return map;
}

const opt = (provider, modelId, name = modelId) => ({ provider, modelId, name });

test("rememberRecentModel records and reorders LRU (dedupe + move-to-front)", () => {
  installStorage();
  rememberRecentModel("a", "m1");
  rememberRecentModel("b", "m2");
  rememberRecentModel("a", "m1"); // repeat → move to front, no duplicate
  assert.deepEqual(
    readRecentModels().map((e) => `${e.provider}/${e.modelId}`),
    ["a/m1", "b/m2"],
  );
});

test("rememberRecentModel caps at RECENT_MODELS_LIMIT, evicting oldest", () => {
  installStorage();
  for (let i = 0; i < RECENT_MODELS_LIMIT + 2; i++) rememberRecentModel("p", `m${i}`);
  const stored = readRecentModels();
  assert.equal(stored.length, RECENT_MODELS_LIMIT);
  assert.equal(stored[0].modelId, `m${RECENT_MODELS_LIMIT + 1}`); // newest kept
  assert.equal(stored.at(-1).modelId, `m2`); // m0/m1 evicted
});

test("rememberRecentModel survives model ids containing '/'", () => {
  installStorage();
  rememberRecentModel("modelscope", "ZhipuAI/GLM-5.2");
  rememberRecentModel("modelscope", "Qwen/Qwen3.8-Flash-Next");
  assert.deepEqual(
    readRecentModels().map((e) => `${e.provider}/${e.modelId}`),
    ["modelscope/Qwen/Qwen3.8-Flash-Next", "modelscope/ZhipuAI/GLM-5.2"],
  );
});

test("readRecentModels returns [] on corrupted JSON / non-array / invalid entries", () => {
  installStorage({ [RECENT_MODELS_KEY]: "{broken json" });
  assert.deepEqual(readRecentModels(), []);

  installStorage({ [RECENT_MODELS_KEY]: JSON.stringify({ not: "an array" }) });
  assert.deepEqual(readRecentModels(), []);

  installStorage({
    [RECENT_MODELS_KEY]: JSON.stringify([
      { provider: "ok", modelId: "m1", at: 1 },
      null,
      "string",
      { provider: 42, modelId: "m2" }, // non-string provider → dropped
      { provider: "ok2" }, // missing modelId → dropped
    ]),
  });
  assert.deepEqual(readRecentModels(), [{ provider: "ok", modelId: "m1", at: 1 }]);
});

test("readRecentModels tolerates missing key and unavailable storage", () => {
  installStorage();
  assert.deepEqual(readRecentModels(), []);

  const savedWindow = globalThis.window;
  try {
    delete globalThis.window; // privacy mode etc. → silent degrade
    assert.deepEqual(readRecentModels(), []);
    assert.doesNotThrow(() => rememberRecentModel("a", "m1"));
  } finally {
    globalThis.window = savedWindow; // don't pollute subsequent tests (fixes order coupling)
  }
});

const CATALOG = [
  opt("zai", "glm-flash", "GLM-5.3-Flash"),
  opt("deepseek", "v4-flash", "DeepSeek V4 Flash"),
  opt("modelscope", "ZhipuAI/GLM-5.2", "GLM-5.2"),
];

test("pickRecentOptions maps stored entries to options in recency order", () => {
  const recent = [
    { provider: "deepseek", modelId: "v4-flash", at: 300 },
    { provider: "zai", modelId: "glm-flash", at: 200 },
  ];
  assert.deepEqual(
    pickRecentOptions(recent, CATALOG, { open: true, filter: "" }),
    [CATALOG[1], CATALOG[0]],
  );
});

test("pickRecentOptions drops unavailable models and dedupes repeats", () => {
  const recent = [
    { provider: "gone", modelId: "deleted", at: 900 }, // no longer available
    { provider: "zai", modelId: "glm-flash", at: 800 },
    { provider: "zai", modelId: "glm-flash", at: 100 }, // repeat entry
  ];
  assert.deepEqual(
    pickRecentOptions(recent, CATALOG, { open: true, filter: "" }),
    [CATALOG[0]],
  );
});

test("pickRecentOptions caps at RECENT_MODELS_LIMIT", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ provider: "zai", modelId: `m${i}`, at: i }));
  const catalog = many.map((e) => opt(e.provider, e.modelId));
  assert.equal(pickRecentOptions(many, catalog, { open: true, filter: "" }).length, RECENT_MODELS_LIMIT);
});

test("pickRecentOptions hidden while panel closed or filtering", () => {
  const recent = [{ provider: "zai", modelId: "glm-flash", at: 1 }];
  assert.deepEqual(pickRecentOptions(recent, CATALOG, { open: false, filter: "" }), []);
  assert.deepEqual(pickRecentOptions(recent, CATALOG, { open: true, filter: "glm" }), []);
  assert.deepEqual(pickRecentOptions(recent, CATALOG, { open: true, filter: "  " }).length, 1); // whitespace-only filter = no filter
});

test("excludeRecentOptions drops entries already shown in the recent section from the main list (each model appears once)", () => {
  const recent = [CATALOG[0], CATALOG[2]];
  assert.deepEqual(excludeRecentOptions(CATALOG, recent), [CATALOG[1]]);
  assert.deepEqual(excludeRecentOptions(CATALOG, []), CATALOG, "main list untouched when no recent section");
  assert.deepEqual(excludeRecentOptions(CATALOG, [opt("gone", "x")]), CATALOG, "list untouched when no overlap");
  // same display name but different provider must not be dropped by mistake (key = provider/modelId)
  const twin = [...CATALOG, opt("other", "glm-flash", "GLM-5.3-Flash")];
  assert.deepEqual(
    excludeRecentOptions(twin, [CATALOG[0]]).map((o) => `${o.provider}/${o.modelId}`),
    ["deepseek/v4-flash", "modelscope/ZhipuAI/GLM-5.2", "other/glm-flash"],
  );
});

test("filterModelOptions matches provider name as well as display name and id", async () => {
  const { filterModelOptions } = await jiti.import("./ModelSelector.tsx");
  assert.deepEqual(filterModelOptions(CATALOG, "modelscope"), [CATALOG[2]]); // provider hit
  assert.deepEqual(filterModelOptions(CATALOG, "GLM-5.3-Flash"), [CATALOG[0]]); // display name hit (unchanged)
  assert.equal(filterModelOptions(CATALOG, "nomatch").length, 0);
  assert.deepEqual(filterModelOptions(CATALOG, "  "), CATALOG); // no filter
});

test("computePanelGeometry: desktop (no keyboard) keeps legacy anchored-above layout", async () => {
  const { computePanelGeometry } = await jiti.import("./ModelSelector.tsx");
  // no keyboard: visible area == layout viewport
  const vp = { layoutHeight: 800, visibleTop: 0, visibleBottom: 800 };
  const g = computePanelGeometry({ top: 300, bottom: 332 }, vp, "up");
  assert.equal(g.openAbove, true);
  assert.equal(g.bottom, 800 - (300 - 6)); // bottom edge sits 6px above the anchor
  assert.equal(g.maxHeight, Math.min(300 - 12, 800 * 0.6)); // min of visible space and the 0.6 cap
});

test("computePanelGeometry: keyboard open pins panel above keyboard when anchor obscured", async () => {
  const { computePanelGeometry } = await jiti.import("./ModelSelector.tsx");
  // keyboard open: visible area compressed to 0..400, anchor (composer) still reports the old position top=760 (obscured by the keyboard)
  const g = computePanelGeometry(
    { top: 760, bottom: 792 },
    { layoutHeight: 800, visibleTop: 0, visibleBottom: 400 },
    "up",
  );
  assert.equal(g.openAbove, true);
  assert.equal(g.bottom, 800 - (400 - 6)); // bottom clamped above the keyboard so the panel no longer extends behind it
  assert.equal(g.maxHeight, Math.max(120, Math.min(394 - 6, 400 * 0.6))); // space/cap computed from the visible height
});

test("computePanelGeometry: anchor scrolled above visible top → panel pinned to visible bottom", async () => {
  const { computePanelGeometry } = await jiti.import("./ModelSelector.tsx");
  const g = computePanelGeometry(
    { top: 10, bottom: 42 },
    { layoutHeight: 800, visibleTop: 100, visibleBottom: 500 },
    "up",
  );
  assert.equal(g.bottom, 800 - (500 - 6));
  assert.equal(g.maxHeight, Math.max(120, Math.min(494 - 100 - 6, 400 * 0.6)));
});

test("computePanelGeometry: placement auto opens below when more space below", async () => {
  const { computePanelGeometry } = await jiti.import("./ModelSelector.tsx");
  const vp = { layoutHeight: 800, visibleTop: 0, visibleBottom: 800 };
  const g = computePanelGeometry({ top: 100, bottom: 132 }, vp, "auto");
  assert.equal(g.openAbove, false);
  assert.equal(g.top, 132 + 6);
  assert.equal(g.maxHeight, Math.max(120, Math.min(800 - 6 - 138, 800 * 0.6)));
});

test("ModelRefreshRow: idle is clickable; refreshing shows a spinner and is disabled (data-model-refresh state marker)", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ModelRefreshRow } = await jiti.import("./ModelSelector.tsx");
  const idle = renderToStaticMarkup(React.createElement(ModelRefreshRow, {
    refreshing: false, label: "刷新模型列表", refreshingLabel: "刷新中…", onClick: () => {},
  }));
  assert.match(idle, /data-model-refresh="idle"/);
  assert.match(idle, /刷新模型列表/);
  assert.doesNotMatch(idle, /disabled/);
  const busy = renderToStaticMarkup(React.createElement(ModelRefreshRow, {
    refreshing: true, label: "刷新模型列表", refreshingLabel: "刷新中…", onClick: () => {},
  }));
  assert.match(busy, /data-model-refresh="busy"/);
  assert.match(busy, /disabled/);
  assert.match(busy, /刷新中…/);
  assert.match(busy, /pi-refresh-spin/, "refreshing label spins");
});

// ── Same info on small screens as on desktop (2026-09-13 decision: the small-screen model panel is no longer a stripped-down variant) ──
// The list body has been one and the same component since the v4 seventh review (92dfb4f); the only
// remaining info difference was the small screen hiding the provider suffix (2016da9, justified at
// the time by narrow-screen squeeze). The small-screen panel is now full-screen/full-height with ample
// width — restore the suffix, and let the recent section (no group header) tell same-named models
// across providers apart.
const modelSelectorSource = await readFile(new URL("./ModelSelector.tsx", import.meta.url), "utf8");

test("option rows show the provider suffix consistently on desktop and small screens (must not regress to mobile-hidden)", () => {
  assert.doesNotMatch(
    modelSelectorSource,
    /isMobile\s*\?\s*undefined\s*:\s*option\.provider/,
    "the mobile-hidden provider-suffix branch must stay removed",
  );
  const providerHints = modelSelectorSource.match(/hint=\{option\.provider\}/g) ?? [];
  assert.ok(
    providerHints.length >= 2,
    `recent + provider grouping must both pass the provider suffix (found ${providerHints.length})`,
  );
});

test("ModelOptionButton shows name + provider suffix + availability status together", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ModelOptionButton } = await jiti.import("./ModelSelector.tsx");
  const html = renderToStaticMarkup(React.createElement(ModelOptionButton, {
    active: true,
    label: "deepseek-v4-flash",
    hint: "qoder-local",
    status: "rl",
    onClick: () => {},
  }));
  assert.match(html, /deepseek-v4-flash/);
  assert.match(html, /qoder-local/, "provider suffix must render (same on mobile)");
  assert.match(html, /429/, "rate-limit badge must render");
});

// ── Small-screen bottom row overflow prevention (2026-09-14) ──
test("hideIcon: the trigger button's leading icon can be hidden (saves width in the narrow small-screen slot), kept by default (desktop unchanged)", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ModelSelector } = await jiti.import("./ModelSelector.tsx");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const props = { options: CATALOG, value: { provider: "zai", modelId: "glm-flash" }, onChange: () => {} };
  const render = (p) => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ModelSelector, p)));
  const withIcon = render(props);
  assert.match(withIcon, /rect x="4" y="4"/, "leading icon renders by default");
  assert.match(withIcon, /GLM-5\.3-Flash/);
  const hidden = render({ ...props, hideIcon: true });
  assert.doesNotMatch(hidden, /rect x="4" y="4"/, "no leading icon when hideIcon is set");
  assert.match(hidden, /GLM-5\.3-Flash/, "model name still shown (ellipsis truncation allowed)");
  // keep the spinner while busy (status feedback is not lost when hideIcon is set)
  const busy = render({ ...props, hideIcon: true, busy: true });
  assert.match(busy, /spin 0\.8s linear infinite/, "spinner still rendered while busy");
});

// ── Dropdown footer action area (2026-09-19): the "manage models" entry is registered by the model-wizard extension ──
// The slot row renders via ExtSlot (depends on the ext store; SSR static rendering yields nothing),
// so the wiring is asserted at source level here to keep it from being removed by accident.
test("dropdown footer action slot (modelSelectorFooter) must render inside the panel", () => {
  assert.match(
    modelSelectorSource,
    /name="modelSelectorFooter"/,
    "modelSelectorFooter slot renders at the bottom of the ModelSelector panel (same pattern as workspacePickerActions; nothing renders and nothing regresses when unregistered)",
  );
});
