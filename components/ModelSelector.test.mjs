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

/** 每个 case 独立的 localStorage stub（Node 无 window.localStorage） */
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
    globalThis.window = savedWindow; // 不污染后续用例（顺序耦合瑕疵修复）
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

test("excludeRecentOptions：最近使用段已展示的条目从主列表剔除（每模型只出现一次）", () => {
  const recent = [CATALOG[0], CATALOG[2]];
  assert.deepEqual(excludeRecentOptions(CATALOG, recent), [CATALOG[1]]);
  assert.deepEqual(excludeRecentOptions(CATALOG, []), CATALOG, "无最近段时主列表原样");
  assert.deepEqual(excludeRecentOptions(CATALOG, [opt("gone", "x")]), CATALOG, "无交集时原样");
  // 同名不同 provider 不得误删（key = provider/modelId）
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
  // 无键盘：可视区 == layout viewport
  const vp = { layoutHeight: 800, visibleTop: 0, visibleBottom: 800 };
  const g = computePanelGeometry({ top: 300, bottom: 332 }, vp, "up");
  assert.equal(g.openAbove, true);
  assert.equal(g.bottom, 800 - (300 - 6)); // 底边贴锚点上方 6px
  assert.equal(g.maxHeight, Math.min(300 - 12, 800 * 0.6)); // 可视空间与 0.6 上限取小
});

test("computePanelGeometry: keyboard open pins panel above keyboard when anchor obscured", async () => {
  const { computePanelGeometry } = await jiti.import("./ModelSelector.tsx");
  // 键盘弹出：可视区压缩到 0..400，锚点（composer）仍报旧位置 top=760（被键盘遮住）
  const g = computePanelGeometry(
    { top: 760, bottom: 792 },
    { layoutHeight: 800, visibleTop: 0, visibleBottom: 400 },
    "up",
  );
  assert.equal(g.openAbove, true);
  assert.equal(g.bottom, 800 - (400 - 6)); // 底边钳到键盘上方，面板不再伸进键盘后面
  assert.equal(g.maxHeight, Math.max(120, Math.min(394 - 6, 400 * 0.6))); // 空间/上限按可视高度
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

test("ModelRefreshRow：idle 可点；refreshing 转圈禁用（data-model-refresh 态标记）", async () => {
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
  assert.match(busy, /pi-refresh-spin/, "刷新中带旋转动画");
});

// ── 小屏与桌面同款信息（2026-09-13 用户拍板：小屏模型面板不再"乞丐版"）──
// 列表主体自 v4 七审（92dfb4f）起已是同一组件；此前残留的唯一信息差异 = 小屏隐藏
// provider 后缀（2016da9，当时的理由是窄屏挤压）。小屏面板现为全屏全高，宽度充足——
// 恢复后缀，并让「最近使用」段（无分组头）能区分跨 provider 同名模型。
const modelSelectorSource = await readFile(new URL("./ModelSelector.tsx", import.meta.url), "utf8");

test("选项行在桌面/小屏一致展示 provider 后缀（不得回退移动端隐藏）", () => {
  assert.doesNotMatch(
    modelSelectorSource,
    /isMobile\s*\?\s*undefined\s*:\s*option\.provider/,
    "小屏隐藏 provider 后缀的分支必须保持删除",
  );
  const providerHints = modelSelectorSource.match(/hint=\{option\.provider\}/g) ?? [];
  assert.ok(
    providerHints.length >= 2,
    `最近使用 + provider 分组两处都要传 provider 后缀（实际 ${providerHints.length} 处）`,
  );
});

test("ModelOptionButton：名称 + provider 后缀 + 可用性状态三者同显", async () => {
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
  assert.match(html, /qoder-local/, "provider 后缀要显示（小屏同款）");
  assert.match(html, /429/, "限流状态徽标要显示");
});

// ── 小屏底排防溢出（2026-09-14）──
test("hideIcon：触发钮前导图标可隐藏（小屏窄位省宽），默认保留（桌面不变）", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ModelSelector } = await jiti.import("./ModelSelector.tsx");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const props = { options: CATALOG, value: { provider: "zai", modelId: "glm-flash" }, onChange: () => {} };
  const render = (p) => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ModelSelector, p)));
  const withIcon = render(props);
  assert.match(withIcon, /rect x="4" y="4"/, "默认要渲染前导图标");
  assert.match(withIcon, /GLM-5\.3-Flash/);
  const hidden = render({ ...props, hideIcon: true });
  assert.doesNotMatch(hidden, /rect x="4" y="4"/, "hideIcon 后不得渲染前导图标");
  assert.match(hidden, /GLM-5\.3-Flash/, "模型名照常显示（仍可 ellipsis 截断）");
  // busy 切换中仍保留旋转指示（状态反馈不随 hideIcon 丢失）
  const busy = render({ ...props, hideIcon: true, busy: true });
  assert.match(busy, /spin 0\.8s linear infinite/, "busy 时仍渲染旋转指示");
});

// ── 下拉底部动作区（2026-09-19）：「管理模型」入口由扩展注册（aiti-model-wizard）──
// 插槽行经 ExtSlot 渲染（依赖 ext store，SSR 静态渲染为空），故此处源级断言接线不被误删。
test("下拉底部动作区插槽（modelSelectorFooter）必须在面板内渲染", () => {
  assert.match(
    modelSelectorSource,
    /name="modelSelectorFooter"/,
    "ModelSelector 面板底部要渲染 modelSelectorFooter 插槽（workspacePickerActions 同款范式；未注册零渲染零回归）",
  );
});
