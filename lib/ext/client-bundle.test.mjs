/**
 * client-bundle 批量打包测试（esbuild 真实打包，fixture 为临时目录小模块）。
 * Run: node --experimental-strip-types --test lib/ext/client-bundle.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClientBundle, emptyClientBundleCode, usesImportMeta, usesLazyChunks } from "./client-bundle.ts";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-web-bundle-"));
  const write = (rel, content) => {
    const file = join(root, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content, "utf8");
    return file;
  };
  const aFile = write("ext-a/dist/a.mjs", "export default function register(ctx) { return ctx.id; }\n");
  const bHelper = write("ext-b/dist/helper.mjs", "export const tag = 'b-helper';\n");
  const bFile = write(
    "ext-b/dist/b.mjs",
    "import { tag } from './helper.mjs';\nexport function register() { return tag; }\nexport const extra = 1;\n",
  );
  const metaFile = write(
    "ext-meta/dist/meta.mjs",
    "const base = import.meta.url.match(/^(.*\\/assets\\/)/);\nexport default function register() { return base; }\n",
  );
  const cFile = write(
    "ext-c/dist/c.mjs",
    "import { tag } from './helper.mjs';\nexport default function register() { return import('./lazy.mjs').then((m) => tag + m.value); }\n",
  );
  write("ext-c/dist/helper.mjs", "export const tag = 'c-helper';\n");
  const cLazy = write("ext-c/dist/lazy.mjs", "export const value = 'lazy-value';\n");
  // ext-d：薄壳+懒 chunk 形态（stub → 共享 entry chunk → 相对动态 import）——
  // 真实拆包产物结构（aiti-git-trace / aiti-ai-speek 同款）。
  const dEntry = write(
    "ext-d/dist/entry.mjs",
    "export function boot(ctx) { return import('./lazy-chunk.mjs'); }\n",
  );
  const dStub = write(
    "ext-d/dist/d.mjs",
    "import { boot } from './entry.mjs';\nexport { boot as register };\n",
  );
  write("ext-d/dist/lazy-chunk.mjs", "export const x = 1;\n");
  return { root, aFile, bFile, bHelper, metaFile, cFile, cLazy, dEntry, dStub, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("bundles multiple entries into one self-contained ESM with a registry export", async () => {
  const fx = makeFixture();
  try {
    const built = await buildClientBundle([
      { id: "ext-a", dir: join(fx.root, "ext-a"), file: fx.aFile, rev: "aaaaaaaaaaaa", order: 0 },
      { id: "ext-b", dir: join(fx.root, "ext-b"), file: fx.bFile, rev: "bbbbbbbbbbbb", order: 1 },
    ]);
    assert.deepEqual(built.ids, ["ext-a", "ext-b"]);
    assert.deepEqual(built.offenders, []);
    assert.deepEqual(built.chunked, [], "静态多文件但不是拆包（无懒 chunk）→ 照常内联");
    assert.match(built.code, /export\s*\{/);
    // 子模块（ext-b/dist/helper.mjs）被内联：产物里不应再有对它的 import
    assert.ok(!built.code.includes("helper.mjs"), "relative sub-import must be inlined");
    // 产物可执行：registry 里两个扩展的 register 入口可用
    const mod = await import(`data:text/javascript;base64,${Buffer.from(built.code).toString("base64")}`);
    assert.equal(typeof mod.registry["ext-a"], "function");
    assert.equal(typeof mod.registry["ext-b"], "function");
    assert.equal(mod.registry["ext-b"](), "b-helper");
  } finally {
    fx.cleanup();
  }
});

test("splitting:false keeps everything in one output (no extra chunk requests)", async () => {
  const fx = makeFixture();
  try {
    const built = await buildClientBundle([
      { id: "ext-a", dir: join(fx.root, "ext-a"), file: fx.aFile, rev: "aaaaaaaaaaaa", order: 0 },
      { id: "ext-b", dir: join(fx.root, "ext-b"), file: fx.bFile, rev: "bbbbbbbbbbbb", order: 1 },
    ]);
    const imports = built.code.match(/^\s*import\s/gm) ?? [];
    assert.equal(imports.length, 0, "自包含：产物不含任何静态 import");
  } finally {
    fx.cleanup();
  }
});

test("import.meta users detected at build time are excluded and reported", async () => {
  const fx = makeFixture();
  try {
    const built = await buildClientBundle([
      { id: "ext-a", dir: join(fx.root, "ext-a"), file: fx.aFile, rev: "aaaaaaaaaaaa", order: 0 },
      { id: "ext-meta", dir: join(fx.root, "ext-meta"), file: fx.metaFile, rev: "mmmmmmmmmmmm", order: 1 },
    ]);
    assert.deepEqual(built.ids, ["ext-a"], "import.meta 使用者被剔除");
    assert.deepEqual(built.offenders, ["ext-meta"]);
  } finally {
    fx.cleanup();
  }
});

test("chunked extensions stay in the bundle but their static relative imports are externalized", async () => {
  const fx = makeFixture();
  try {
    // ext-d = 真实拆包形态：stub（相对 import 共享 entry）→ entry 内相对动态 import。
    const built = await buildClientBundle([
      { id: "ext-d", dir: join(fx.root, "ext-d"), file: fx.dStub, rev: "dddddddddddd", order: 0 },
    ]);
    assert.deepEqual(built.ids, ["ext-d"], "拆包拡展仍留在批量包");
    assert.deepEqual(built.chunked, ["ext-d"]);
    // 共享 entry chunk 外置为文件 URL（懒 chunk 会从同一 URL 加载 → 运行时单实例）
    assert.ok(
      built.code.includes("./ext-d/assets/dist/entry.mjs"),
      `stub 的静态相对 import 必须外置，got: ${built.code.slice(0, 240)}`,
    );
    assert.ok(!built.code.includes("boot(ctx)") && !built.code.includes("setCtx"), "共享 chunk 内容不进包");
  } finally {
    fx.cleanup();
  }
});

test("dynamic imports stay external (lazy chunks must not be pulled into the bundle)", async () => {
  const fx = makeFixture();
  try {
    const built = await buildClientBundle([
      { id: "ext-c", dir: join(fx.root, "ext-c"), file: fx.cFile, rev: "cccccccccccc", order: 0 },
    ]);
    // 拆包拡展（ext-c 含相对动态 import）：静态相对依赖同样外置——共享 chunk 必须
    // 保持文件 URL 单实例（懒 chunk 会从同一 URL 加载）。
    assert.ok(
      built.code.includes("./ext-c/assets/dist/helper.mjs"),
      "chunked: static sub-import is externalized to the asset URL",
    );
    assert.ok(!built.code.includes("c-helper"), "chunked: static content must not be inlined");
    // 动态子模块外置为相对扩展资产 URL，内容不进包
    assert.ok(!built.code.includes("lazy-value"), "dynamic chunk content must not be inlined");
    assert.ok(
      built.code.includes('./ext-c/assets/dist/lazy.mjs'),
      `dynamic import must be externalized relative to the bundle URL, got: ${built.code.slice(0, 200)}`,
    );
    // registry 仍导出该扩展入口（静态依赖外置不影响注册形态）
    assert.ok(built.code.includes("\"ext-c\""), "registry keeps the chunked extension entry");
  } finally {
    fx.cleanup();
  }
});

test("bundle rev is stable for identical members and changes with content", async () => {
  const fx = makeFixture();
  try {
    const rows = [{ id: "ext-a", dir: join(fx.root, "ext-a"), file: fx.aFile, rev: "aaaaaaaaaaaa", order: 0 }];
    const first = await buildClientBundle(rows);
    const second = await buildClientBundle(rows);
    assert.equal(first.rev, second.rev);
    const changed = await buildClientBundle([{ ...rows[0], rev: "aaaa9999aaaa" }]);
    assert.notEqual(first.rev, changed.rev);
  } finally {
    fx.cleanup();
  }
});

test("empty entry list yields a valid empty registry module", async () => {
  const built = await buildClientBundle([]);
  assert.equal(built.ids.length, 0);
  assert.equal(built.code, emptyClientBundleCode());
});

test("usesImportMeta flags import.meta users and caches by mtime", () => {
  const fx = makeFixture();
  try {
    assert.equal(usesImportMeta(fx.aFile), false);
    assert.equal(usesImportMeta(fx.metaFile), true);
    assert.equal(usesImportMeta(join(fx.root, "missing.mjs")), true, "不可读 → 保守排除");
  } finally {
    fx.cleanup();
  }
});

// ---- 拆包检测（usesLazyChunks）：批量包排除判据 ----
test("usesLazyChunks detects lazy chunks transitively but keeps static-only graphs", () => {
  const fx = makeFixture();
  try {
    assert.equal(usesLazyChunks(fx.aFile), false, "无 import → 不敏感");
    assert.equal(usesLazyChunks(fx.bFile), false, "静态相对 import（helper 无动态）→ 可打包");
    assert.equal(usesLazyChunks(fx.cFile), true, "入口自身直接相对动态 import → 排除");
    assert.equal(usesLazyChunks(fx.dStub), true, "stub → 共享 chunk → 动态 import：闭包命中");
    assert.equal(usesLazyChunks(join(fx.root, "missing.mjs")), true, "不可读 → 保守排除");
  } finally {
    fx.cleanup();
  }
});
