/**
 * aiti-extman shared-deps 区间合并单测。
 *
 * 钉死的 bug：共享根只有一份物理拷贝，同名依赖的多条区间旧实现直接 `a || b` 拼接——
 * npm 见「已装的 0.1.4 满足 `^0.1.3 || ^0.1.4 || ^0.1.5`」就不动手，于是声明 `^0.1.5`
 * 的扩展永远装不上它要的新 API（实测把 aiti-qoder-agent v0.4.0 卡在门外，reconcile 每轮
 * 报 ✓ 却把 node_modules 钉回旧版）。同族区间必须取交集（下界最高那条）。
 *
 * shared-deps.ts 走 `./installer.js` 兄弟引用（jiti 才做 .js→.ts 映射），且 installer 还拉
 * 部署态才有的 check-client.mjs → 照仓库范式 esbuild 打包，把 installer 这条边外部化 +
 * 桩替（本文件只用 mergeSpecs/collectDeps 两个纯函数，不碰 npm 调用）。
 *
 * Run: node scripts/test-web-ext.mjs --only aiti-extman
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runEsbuild } from "../_shared/esbuild-bin.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const dir = mkdtempSync(join(tmpdir(), "extman-shared-deps-"));
const bundle = join(dir, "shared-deps.mjs");
writeFileSync(join(dir, "installer.js"), "export const runNpm = async () => { throw new Error('not used in tests'); };\n");
await runEsbuild(join(repoRoot, "node_modules", "esbuild", "bin", "esbuild"), [
  join(here, "shared-deps.ts"), "--bundle", "--format=esm", "--platform=node",
  "--external:./installer.js", `--outfile=${bundle}`, "--log-level=error",
]);
const { mergeSpecs, collectDeps } = await import(pathToFileURL(bundle).href);

test.after(() => { rmSync(dir, { recursive: true, force: true }); });

test("mergeSpecs: 同族 caret 取交集（最高下界），不再拼 ||", () => {
  assert.equal(mergeSpecs(["^0.1.3", "^0.1.5", "^0.1.0"]), "^0.1.5");
});

test("mergeSpecs: 单条声明原样返回（幂等，不制造无谓的根 package.json 重写）", () => {
  assert.equal(mergeSpecs(["^0.1.5"]), "^0.1.5");
  assert.equal(mergeSpecs(["18.3.1"]), "18.3.1");
  assert.equal(mergeSpecs(["^3.4.0 || ^2.10.0"]), "^3.4.0 || ^2.10.0", "扩展自带的复杂 spec 不被改写");
});

test("mergeSpecs: 跨 major 互斥时退回 ||（单拷贝没有交集，交回 npm 自选）", () => {
  assert.equal(mergeSpecs(["^1.0.0", "^2.0.0"]), "^1.0.0 || ^2.0.0");
});

test("mergeSpecs: 0.x 的 caret 上界按 npm 语义判（^0.1 锁 minor / ^0.0 锁 patch）", () => {
  assert.equal(mergeSpecs(["^0.1.3", "^0.2.0"]), "^0.1.3 || ^0.2.0", "^0.1.x 装不下 0.2.0");
  assert.equal(mergeSpecs(["~1.2.3", "1.2.9"]), "1.2.9", "~ 锁 major.minor，1.2.9 同时在两区间内");
  assert.equal(mergeSpecs(["^1.2.3", "~1.9.0"]), "~1.9.0", "高下界 ~1.9.0 落在 ^1.2.3 窗口内");
  assert.equal(mergeSpecs(["^0.0.3", "^0.0.5"]), "^0.0.3 || ^0.0.5", "^0.0.x 精确锁 patch");
});

test("mergeSpecs: 精确版本与更高区间冲突时退回 ||", () => {
  assert.equal(mergeSpecs(["1.0.0", "^2.0.0"]), "1.0.0 || ^2.0.0");
});

test("collectDeps: 多扩展冲突声明合并成一条能升级的区间（真实根形态）", () => {
  const root = join(dir, "extensions");
  for (const [ext, deps] of [
    ["aiti-old", { "@aiti-ai/ext-shared": "^0.1.3", react: "18.3.1" }],
    ["aiti-mid", { "@aiti-ai/ext-shared": "^0.1.4" }],
    ["aiti-new", { "@aiti-ai/ext-shared": "^0.1.5", "some-pkg": ">=2.0.0" }],
  ]) {
    const one = join(root, ext);
    mkdirSync(one, { recursive: true });
    writeFileSync(join(one, "package.json"), JSON.stringify({ name: ext, dependencies: deps }));
  }
  const { deps } = collectDeps(root);
  assert.equal(deps["@aiti-ai/ext-shared"], "^0.1.5", "取交集 → npm 必须升到 0.1.5+");
  assert.equal(deps.react, "18.3.1");
  assert.equal(deps["some-pkg"], ">=2.0.0", "复杂 spec 原样保留");
});
