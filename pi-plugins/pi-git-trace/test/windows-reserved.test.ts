/**
 * Windows 专属用例（各系统跑各的测试）：Windows 保留设备名 vs aiti-git-trace。
 *
 * 背景：bash 里误用 cmd 风格 `> nul` 重定向会创建名为 nul 的真实文件；
 * Windows 保留设备名（nul/con/prn/aux/com1-9/lpt1-9，含 <name>.<ext> 形态）
 * git 无法 stat/index，混入枚举会让整批 git add fatal（毒丸整个追踪提交）。
 * 对应修复：excludes.ts v2 保留名模式 + engine.ts isWindowsReservedPath 过滤 + add 批次降级。
 *
 * 非 Windows 平台整体跳过（保留名只在 win32 有行为差异）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SKIP_NOT_WIN = process.platform !== "win32" ? "Windows 保留设备名行为用例，仅 win32 跑" : false;

test("win 保留名：isWindowsReservedPath 判定表", { skip: SKIP_NOT_WIN }, async () => {
  const { isWindowsReservedPath } = await import("../src/engine.ts");
  for (const p of ["nul", "NUL", "a/nul", "a\\nul", "nul.txt", "NUL.TXT", "com1", "Com1.log", "lpt9", "aux", "con.prn"]) {
    assert.equal(isWindowsReservedPath(p), true, `${p} 应判为保留名`);
  }
  for (const p of ["null", "null.txt", ".gitignore", "conx", "com0", "lpt0", "a/nullb.txt", ""]) {
    assert.equal(isWindowsReservedPath(p), false, `${p} 不应判为保留名`);
  }
});

test("win 保留名：renderExcludesFile v2 含全部保留名模式", { skip: SKIP_NOT_WIN }, async () => {
  const { renderExcludesFile, EXCLUDES_VERSION } = await import("../src/excludes.ts");
  assert.ok(EXCLUDES_VERSION >= 2, "EXCLUDES_VERSION 应 >= 2");
  const text = renderExcludesFile({});
  const names = ["nul", "con", "prn", "aux", "com1", "com9", "lpt1", "lpt9"];
  for (const n of names) {
    assert.ok(text.split("\n").includes(n), `info/exclude 应含模式 ${n}`);
    assert.ok(text.split("\n").includes(`${n}.*`), `info/exclude 应含模式 ${n}.*`);
  }
});

test("win 保留名：真实 nul 文件被 info/exclude v2 排除，add -A 不再毒丸", { skip: SKIP_NOT_WIN }, async (t) => {
  const { ensureStore } = await import("../src/store.ts");
  const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), "aiti-gt-nul-"));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* nul 句柄释放时序，尽力删 */ } });
  const sh = (args: string[], env?: NodeJS.ProcessEnv) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  // hermetic 形态（与 engine/pi-web 枚举一致）：--git-dir 指向 store，--exclude-standard 读 store 的 info/exclude
  const traceSh = (args: string[]) =>
    sh(["--git-dir", path.join(root, ".aiti-trace"), "--work-tree", root, ...args], {
      GIT_INDEX_FILE: path.join(root, ".aiti-trace", "index-t-nul"),
    });

  sh(["init", "-q"]);
  fs.writeFileSync(path.join(root, "real.txt"), "hello\n");
  // 保留名文件只能经 \\?\ 前缀写入（常规 API 会被设备名劫持）
  fs.writeFileSync("\\\\?\\" + root + "\\nul", "poison\n");

  // ensureStore 幂等升级 info/exclude → 保留名模式生效
  await ensureStore({ repoRoot: root, sessionId: "t-nul" });
  const excl = fs.readFileSync(path.join(root, ".aiti-trace", "info", "exclude"), "utf8");
  assert.ok(excl.includes("\nnul\n"), "info/exclude 托管块应含 nul 模式");

  const others = traceSh(["ls-files", "--others", "--exclude-standard"]).trim().split("\n");
  assert.ok(!others.includes("nul"), `枚举不应列出 nul：${JSON.stringify(others)}`);

  // pi-web 扩展同款场景：add -A（遵守同一 info/exclude）直接成功，毒丸不再存在
  traceSh(["add", "-A"]);
  const staged = traceSh(["ls-files"]).trim().split("\n");
  assert.deepEqual(staged, ["real.txt"]);

  // 裸 git add -- nul 仍 fatal（git 自身行为不变，防御在枚举过滤与降级层）
  assert.throws(() => sh(["add", "--", "nul"]));
});