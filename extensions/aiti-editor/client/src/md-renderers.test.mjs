/**
 * 围栏渲染器注册表面试（`registry.ts` 的 registerMdRenderer / resolveMdRenderers /
 * mdFenceDescriptors）—— md-plugins M0 契约：内置 mermaid 经注册成为消费者，
 * 外部同 lang 声明不阻断、裁决 priority > 注册序，构建期描述符按主题求值 css。
 *
 * Run: node scripts/test-web-ext.mjs --only aiti-editor
 * （registry.ts 无扩展名 import → esbuild 打包 + 全局桩范式，同 ask-close.test.mjs）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runEsbuild } from "../../../_shared/esbuild-bin.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const esbuildBin = join(here, "..", "..", "node_modules", "esbuild", "bin", "esbuild");

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "aiti-editor-mdrender-"));
  const outfile = join(dir, "registry.bundle.mjs");
  await runEsbuild(esbuildBin, [join(here, "registry.ts"), "--bundle", "--format=esm", "--platform=node",
    `--outfile=${outfile}`]);

  const store = new Map();
  const orig = {
    localStorage: globalThis.localStorage, window: globalThis.window, location: globalThis.location,
    document: globalThis.document, fetch: globalThis.fetch, BroadcastChannel: globalThis.BroadcastChannel,
  };
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.window = globalThis;
  globalThis.location = { href: "http://127.0.0.1:3001/dev/", origin: "http://127.0.0.1:3001", pathname: "/dev/" };
  globalThis.document = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, classList: { add() {} } }),
    head: { appendChild() {} }, body: { appendChild() {} }, addEventListener() {},
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  globalThis.BroadcastChannel = class { constructor() { this.onmessage = null; } postMessage() {} close() {} };

  const mod = await import(pathToFileURL(outfile).href);
  mod.setupRegistry({});
  const A = globalThis.window.__aitiEditor;
  assert.ok(A, "setupRegistry 应注册 window.__aitiEditor");
  return {
    A,
    mdFenceDescriptors: mod.mdFenceDescriptors,
    cleanup() {
      delete globalThis.window.__aitiEditor; // 单例复位：每个测试各自 setupRegistry 干净实例
      Object.assign(globalThis, orig);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const noop = () => {};

test("内置 mermaid 已是「注册表里的一个消费者」（id/lang/render/css 就位）", async () => {
  const { A, cleanup } = await setup();
  try {
    const chain = A.resolveMdRenderers("mermaid");
    assert.equal(chain.length, 1);
    assert.equal(chain[0].id, "aiti-editor.mermaid");
    assert.equal(chain[0].lang, "mermaid");
    assert.equal(typeof chain[0].render, "function");
    assert.equal(chain[0].sourceExt, "aiti-editor");
    assert.match(chain[0].base, /\/api\/extensions\/aiti-editor$/);
    // 构建期描述符：css 已按主题求值成字符串（render 函数留在父页，不进 srcdoc）
    const light = A.mdFenceDescriptors(false);
    assert.deepEqual(light.map((d) => d.lang), ["mermaid"]);
    assert.equal(typeof light[0].css, "string");
    assert.match(light[0].css, /data-md-fence="mermaid"/);
    assert.notEqual(A.mdFenceDescriptors(true)[0].css, light[0].css); // 主题不同 → 样式不同
  } finally { cleanup(); }
});

test("同 lang 多声明不阻断：平局内置赢，preferred/override 才拿得走", async () => {
  const { A, cleanup } = await setup();
  try {
    const ext = { id: "ext.chart", lang: "mermaid", render: noop, css: ".ext{color:red}" };
    const off = A.registerMdRenderer(ext);
    assert.deepEqual(A.resolveMdRenderers("mermaid").map((r) => r.id), ["aiti-editor.mermaid", "ext.chart"]);
    assert.match(A.mdFenceDescriptors(false)[0].css, /data-md-fence/); // 生效者仍是内置

    const strong = { id: "ext.chart2", lang: "mermaid", priority: "preferred", render: noop, css: ".c2{color:blue}" };
    A.registerMdRenderer(strong);
    assert.deepEqual(A.resolveMdRenderers("mermaid").map((r) => r.id), ["ext.chart2", "aiti-editor.mermaid", "ext.chart"]);
    assert.deepEqual(A.mdFenceDescriptors(false), [{ lang: "mermaid", css: ".c2{color:blue}" }]); // 每语言只出一条

    off(); // 退订 ext.chart：不影响裁决
    assert.deepEqual(A.resolveMdRenderers("mermaid").map((r) => r.id), ["ext.chart2", "aiti-editor.mermaid"]);
  } finally { cleanup(); }
});

test("同 id 重复注册原地替换（热重载换新代码，不失注册序位）", async () => {
  const { A, cleanup } = await setup();
  try {
    A.registerMdRenderer({ id: "ext.chart", lang: "vega", priority: "override", render: noop, css: ".old" });
    A.registerMdRenderer({ id: "ext.chart", lang: "vega", priority: "override", render: noop, css: ".new" });
    assert.deepEqual(A.resolveMdRenderers("vega").map((r) => r.css), [".new"]);
    // 内置先注册 + 外部后注册：原地替换不改变相对序（外部 override 仍在前）
    A.registerMdRenderer({ id: "ext.l", lang: "mermaid", render: noop });
    A.registerMdRenderer({ id: "ext.l", lang: "mermaid", render: noop });
    assert.deepEqual(A.resolveMdRenderers("mermaid").map((r) => r.id), ["aiti-editor.mermaid", "ext.l"]);
  } finally { cleanup(); }
});

test("非法注册忽略（lang 非 [\\w-] 或 render 非函数），退订恒为 no-op", async () => {
  const { A, cleanup } = await setup();
  try {
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(" "));
    try {
      assert.equal(typeof A.registerMdRenderer({ id: "bad", lang: "bad lang", render: noop }), "function");
      assert.equal(typeof A.registerMdRenderer({ id: "bad2", lang: "ok", render: "not-a-fn" }), "function");
      assert.equal(typeof A.registerMdRenderer(null), "function");
    } finally { console.warn = origWarn; }
    assert.equal(warns.length, 3);
    assert.match(warns[0], /registerMdRenderer 已忽略/);
    assert.deepEqual(A.resolveMdRenderers("bad lang"), []);
    assert.deepEqual(A.resolveMdRenderers("ok"), []);
    assert.deepEqual(A.mdFenceDescriptors(false).map((d) => d.lang), ["mermaid"]); // 只有内置
    assert.equal(A.resolveMdRenderers("").length, 0);
  } finally { cleanup(); }
});

test("模块级 mdFenceDescriptors 走单例读取（无注册表 → 空表，不抛）", async () => {
  const { mdFenceDescriptors, cleanup } = await setup();
  try {
    assert.deepEqual(mdFenceDescriptors(false).map((d) => d.lang), ["mermaid"]);
    delete globalThis.window.__aitiEditor;
    assert.deepEqual(mdFenceDescriptors(false), []); // 单例缺席（扩展未加载）→ 零注入
  } finally { cleanup(); }
});
