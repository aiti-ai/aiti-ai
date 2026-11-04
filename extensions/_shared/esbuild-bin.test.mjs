/**
 * esbuild-bin 共享层用例——钉死「派生形态按平台解析」这条契约。
 *
 * 回归背景：esbuild 的 `bin/esbuild` 在 Linux/macOS 被 postinstall 换成原生二进制（`node <bin>` 必炸），
 * 在 Windows 是带 shebang 的 JS 包装（CreateProcess 不认，直接 exec 报 ENOENT），
 * `.bin/esbuild` 在 Windows 又是 /bin/sh 垫片（spawn 必 ENOENT）。两侧各修一次的 ping-pong
 * 发生过两回（本仓 node 直跑 → 48 端改直接 exec 2026-09-19），收口到本层后由这里把关。
 *
 * Run: node scripts/test-web-ext.mjs --only _shared
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEsbuildSpawn, runEsbuild } from "./esbuild-bin.ts";

const here = dirname(fileURLToPath(import.meta.url));
const nm = join(here, "..", "aiti-float", "node_modules");
const pkgEntry = join(nm, "esbuild", "bin", "esbuild");
const shimEntry = join(nm, ".bin", "esbuild");
const expectedVersion = existsSync(join(nm, "esbuild", "package.json"))
  ? JSON.parse(readFileSync(join(nm, "esbuild", "package.json"), "utf8")).version
  : null;

const cases = [
  ["包内入口 esbuild/bin/esbuild", pkgEntry],
  [".bin 垫片（Windows 上是 sh 脚本）", shimEntry],
];

// 官方平台包在位时，两种入口都必须解析到它（曾经写死「上溯两级」，对三级深度的
// esbuild/bin/esbuild 恒不命中，平台分支形同虚设）。
const platformPkg = join(nm, "@esbuild", `${process.platform}-${process.arch}`);
const wantPlatformBin = existsSync(platformPkg);

for (const [label, bin] of cases) {
  if (!existsSync(bin)) continue; // 未装该扩展依赖的环境干净跳过
  test(`esbuild 派生可跑通：${label}`, async () => {
    const { cmd } = resolveEsbuildSpawn(bin);
    assert.ok(existsSync(cmd), `解析出的 cmd 必须真实存在：${cmd}`);
    if (wantPlatformBin) {
      assert.ok(cmd.startsWith(platformPkg), `平台包在位时必须走它，实际 ${cmd}`);
    }
    // 派生的本体不能是「要 shell 才认」的脚本（Windows CreateProcess 会 ENOENT）：
    // 要么原生二进制，要么走 node 直跑（prefix 非空）。
    if (process.platform === "win32") {
      const head = readFileSync(cmd).subarray(0, 2).toString("utf8");
      assert.notEqual(head, "#!", `win32 上直接 exec 的目标不能是 shebang 文本：${cmd}`);
    }
    const out = await runEsbuild(bin, ["--version"]);
    assert.equal(out.trim(), expectedVersion, "两种写法必须解析到同一个 esbuild");
  });
}
