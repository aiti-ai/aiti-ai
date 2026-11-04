/**
 * aiti-cmd recognize.ts 测试（isCommandContext 等纯函数）。
 * recognize.ts 是 TS 且 import "./store.js"（映射 store.ts）——node 原生无法解析，
 * 用 esbuild（aiti-cmd 自身构建链）bundle 到内存再 import。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "recognize.ts");

/** esbuild bundle recognize.ts → 临时 mjs，import 后返回模块。 */
let modPromise = null;
function loadRecognize() {
  if (modPromise) return modPromise;
  modPromise = (async () => {
    // 产物放 aiti-cmd/tools/ 下：createRequire(import.meta.url) 向上解析 node_modules
    // （command-exists/shell-quote 保持运行时 require）
    const out = join(here, ".tmp-recognize.mjs");
    await build({
      entryPoints: [src],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: out,
      logLevel: "silent",
    });
    try {
      return await import(pathToFileURL(out).href + `?t=${Date.now()}`);
    } finally {
      if (existsSync(out)) rmSync(out, { force: true });
    }
  })();
  return modPromise;
}

test("isCommandContext: 文本开头 → true（命令语境）", async () => {
  const { isCommandContext } = await loadRecognize();
  assert.equal(isCommandContext("file", 0), true);
  assert.equal(isCommandContext("  file", 2), true); // 行首前有空白
});

test("isCommandContext: 行首（前换行）→ true", async () => {
  const { isCommandContext } = await loadRecognize();
  assert.equal(isCommandContext("npm install\nfile", 12), true);
  assert.equal(isCommandContext("a\nb\nfile", 4), true); // f 在 idx 4
});

test("isCommandContext: $ 提示符 → true；$ 变量引用 → false", async () => {
  const { isCommandContext } = await loadRecognize();
  assert.equal(isCommandContext("$ file", 2), true);
  assert.equal(isCommandContext("  $ file", 4), true);
  // "echo $file" 中 $ 前有命令词 → 变量引用，非命令语境
  assert.equal(isCommandContext("echo $file", 7), false);
});

test("isCommandContext: 命令链边界 ; & | → true", async () => {
  const { isCommandContext } = await loadRecognize();
  assert.equal(isCommandContext("a; file", 3), true);
  assert.equal(isCommandContext("a && file", 5), true);
  assert.equal(isCommandContext("a | file", 3), true);
  assert.equal(isCommandContext("a & file", 3), true);
});

test("isCommandContext: 叙述语境（中文/普通词后）→ false", async () => {
  const { isCommandContext } = await loadRecognize();
  assert.equal(isCommandContext("请先 file 一下", 3), false); // 中文叙述
  assert.equal(isCommandContext("then file", 5), false);      // 英文叙述
  assert.equal(isCommandContext("<button> ＋ file", 12), false); // 页面元素信息里的词
  assert.equal(isCommandContext("说 file 吧", 2), false);
});

test("splitCdPrefix: cd xxx && … → workdir/action", async () => {
  const { splitCdPrefix } = await loadRecognize();
  assert.deepEqual(splitCdPrefix("cd pi-web-ext/aiti-helper && node tools/deploy.mjs"), { workdir: "pi-web-ext/aiti-helper", action: "node tools/deploy.mjs" });
  assert.deepEqual(splitCdPrefix("cd /tmp; ls"), { workdir: "/tmp", action: "ls" });
  assert.deepEqual(splitCdPrefix("cd ~/proj | pwd"), { workdir: "~/proj", action: "pwd" });
  assert.deepEqual(splitCdPrefix("cd \"/my dir\" && ls"), { workdir: "/my dir", action: "ls" });
  // 纯 cd 无后续动作 → 不提取
  assert.deepEqual(splitCdPrefix("cd /tmp"), {});
  assert.deepEqual(splitCdPrefix("cd ."), {});
  // 非 cd 前缀 → 不提取
  assert.deepEqual(splitCdPrefix("npm install"), {});
});

test("resolveWorkdir: 结合会话 cwd 解析为绝对路径", async () => {
  const { resolveWorkdir } = await loadRecognize();
  // 相对路径 + cwd → 绝对
  assert.equal(pathResolve(resolveWorkdir("pi-web-ext/aiti-helper", "/home/pi/workspace/aiti-ai")), pathResolve("/home/pi/workspace/aiti-ai/pi-web-ext/aiti-helper"));
  // 含 ../ 规范化
  assert.equal(pathResolve(resolveWorkdir("../pi-web", "/home/pi/workspace/aiti-ai")), pathResolve("/home/pi/workspace/aiti-ai/../pi-web"));
  // 绝对路径原样
  assert.equal(pathResolve(resolveWorkdir("/tmp", "/home/pi/workspace/aiti-ai")), pathResolve("/tmp"));
  // ~ 展开
  assert.equal(pathResolve(resolveWorkdir("~/proj", "/home/pi/workspace/aiti-ai")), pathResolve(homedir() + "/proj"));
  assert.equal(pathResolve(resolveWorkdir("~", "/home/pi/workspace/aiti-ai")), pathResolve(homedir()));
  // 无 cwd（行内 code 场景）→ 保持相对，不臆造基准
  assert.equal(resolveWorkdir("pi-web-ext/aiti-helper", undefined), "pi-web-ext/aiti-helper");
  // 空/undefined
  assert.equal(resolveWorkdir(undefined, "/x"), undefined);
});

test("checkCommand: cd 相对路径 → workdir 结合 cwd 解析", async () => {
  const { checkCommand } = await loadRecognize();
  const r = await checkCommand("cd pi-web-ext/aiti-helper && node tools/deploy.mjs", "/home/pi/workspace/aiti-ai");
  assert.equal(pathResolve(r.workdir), pathResolve("/home/pi/workspace/aiti-ai/pi-web-ext/aiti-helper"));
  assert.equal(r.action, "node tools/deploy.mjs");
  // 绝对路径 cd 不受 cwd 影响
  const r2 = await checkCommand("cd /tmp && ls", "/home/pi/workspace/aiti-ai");
  assert.equal(pathResolve(r2.workdir), pathResolve("/tmp"));
});

test("chainCommandWords: 命令链各段首命令", async () => {
  const { chainCommandWords } = await loadRecognize();
  assert.deepEqual(chainCommandWords("cd x && npm i"), ["cd", "npm"]);
  assert.deepEqual(chainCommandWords("npm install && npm run build"), ["npm"]);
  assert.deepEqual(chainCommandWords("git add . | grep src"), ["git", "grep"]);
  assert.deepEqual(chainCommandWords("cd /tmp"), ["cd"]);
});

test("captureChain: && 连接符后继续吞（词库命令）", async () => {
  const { extractCommandsFromText } = await loadRecognize();
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiti-cmd-test-"));
  try {
    const r = await extractCommandsFromText(tmp, "cd pi-web-ext/aiti-helper && node tools/deploy.mjs");
    const chain = r.find((c) => c.cmd.includes("&&"));
    assert.ok(chain, "应识别出含 && 的完整命令链，实际：" + JSON.stringify(r.map((c) => c.cmd)));
    assert.equal(chain.cmd, "cd pi-web-ext/aiti-helper && node tools/deploy.mjs");
    assert.equal(chain.workdir, "pi-web-ext/aiti-helper");
    assert.equal(chain.action, "node tools/deploy.mjs");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("captureChain: 叙述语境不误吞（中文/英文功能词停）", async () => {
  const { extractCommandsFromText } = await loadRecognize();
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiti-cmd-test-"));
  try {
    // 中文叙述："pnpm install 然后运行" → 只认 pnpm install，不吞中文
    const r1 = await extractCommandsFromText(tmp, "先 pnpm install 然后运行测试");
    assert.equal(r1.length, 1);
    assert.equal(r1[0].cmd, "pnpm install");
    // 英文功能词后不吞："npm install and start" → and 非命令
    const r2 = await extractCommandsFromText(tmp, "npm install and start");
    assert.equal(r2.length, 1);
    assert.equal(r2[0].cmd, "npm install");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
