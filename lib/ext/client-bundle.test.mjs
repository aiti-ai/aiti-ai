/**
 * client-bundle batch bundling tests (real esbuild bundling; fixtures are small temp-dir modules).
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
  // ext-d: thin shell + lazy chunk shape (stub → shared entry chunk → relative dynamic import) —
  // the real split-bundle artifact structure (same as aiti-git-trace / aiti-ai-speek).
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
    assert.deepEqual(built.chunked, [], "multi static files but not chunked (no lazy chunks) → inlined as usual");
    assert.match(built.code, /export\s*\{/);
    // sub-module (ext-b/dist/helper.mjs) is inlined: the artifact must no longer import it
    assert.ok(!built.code.includes("helper.mjs"), "relative sub-import must be inlined");
    // artifact is executable: both extensions' register entries are usable from the registry
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
    assert.equal(imports.length, 0, "self-contained: the artifact contains no static imports");
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
    assert.deepEqual(built.ids, ["ext-a"], "import.meta users are excluded");
    assert.deepEqual(built.offenders, ["ext-meta"]);
  } finally {
    fx.cleanup();
  }
});

test("chunked extensions stay in the bundle but their static relative imports are externalized", async () => {
  const fx = makeFixture();
  try {
    // ext-d = real chunked shape: stub (relative import of the shared entry) → relative dynamic import inside the entry.
    const built = await buildClientBundle([
      { id: "ext-d", dir: join(fx.root, "ext-d"), file: fx.dStub, rev: "dddddddddddd", order: 0 },
    ]);
    assert.deepEqual(built.ids, ["ext-d"], "chunked extension stays in the batch bundle");
    assert.deepEqual(built.chunked, ["ext-d"]);
    // shared entry chunk externalized as a file URL (lazy chunks load from the same URL → single runtime instance)
    assert.ok(
      built.code.includes("./ext-d/assets/dist/entry.mjs"),
      `the stub's static relative import must be externalized, got: ${built.code.slice(0, 240)}`,
    );
    assert.ok(!built.code.includes("boot(ctx)") && !built.code.includes("setCtx"), "shared chunk content stays out of the bundle");
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
    // chunked extension (ext-c has a relative dynamic import): static relative deps are externalized too — the
    // shared chunk must keep its file URL single instance (lazy chunks load from the same URL).
    assert.ok(
      built.code.includes("./ext-c/assets/dist/helper.mjs"),
      "chunked: static sub-import is externalized to the asset URL",
    );
    assert.ok(!built.code.includes("c-helper"), "chunked: static content must not be inlined");
    // dynamic sub-module externalized as a relative extension asset URL, content stays out of the bundle
    assert.ok(!built.code.includes("lazy-value"), "dynamic chunk content must not be inlined");
    assert.ok(
      built.code.includes('./ext-c/assets/dist/lazy.mjs'),
      `dynamic import must be externalized relative to the bundle URL, got: ${built.code.slice(0, 200)}`,
    );
    // registry still exports the extension entry (externalizing static deps does not affect the registration shape)
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
    assert.equal(usesImportMeta(join(fx.root, "missing.mjs")), true, "unreadable → conservatively excluded");
  } finally {
    fx.cleanup();
  }
});

// ---- chunk detection (usesLazyChunks): batch-bundle exclusion criterion ----
test("usesLazyChunks detects lazy chunks transitively but keeps static-only graphs", () => {
  const fx = makeFixture();
  try {
    assert.equal(usesLazyChunks(fx.aFile), false, "no imports → not sensitive");
    assert.equal(usesLazyChunks(fx.bFile), false, "static relative import (helper has no dynamic) → bundleable");
    assert.equal(usesLazyChunks(fx.cFile), true, "entry itself has a direct relative dynamic import → excluded");
    assert.equal(usesLazyChunks(fx.dStub), true, "stub → shared chunk → dynamic import: closure hit");
    assert.equal(usesLazyChunks(join(fx.root, "missing.mjs")), true, "unreadable → conservatively excluded");
  } finally {
    fx.cleanup();
  }
});
