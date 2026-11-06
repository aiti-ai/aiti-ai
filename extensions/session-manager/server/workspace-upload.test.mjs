/**
 * workspace-upload tests（方案 docs/session-manager-workspace-upload-plan.md §9）。
 * Run: node --experimental-strip-types --test <ext>/server/workspace-upload.test.mjs
 * 覆盖：格式识别 / 路径清洗 / 垃圾过滤 / FS 单根检测 / 冲突顺延 / handler 端到端
 * （真 fixture zip：带根、散文件、mac 垃圾干扰、恶意路径；tar 系现场打包，无 tar 跳过）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync, readdirSync, statSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir as osTmpdir } from "os";
// macOS /var → /private/var 符号链接：服务端落位路径走 realpath，断言基准须同口径
// （Linux 上 realpathSync 恒等，零影响；否则 e2e 路径断言逐字比较必挂）
const tmpdir = () => realpathSync(osTmpdir());
import { join } from "path";
import { rmRf } from "../../_shared/test-rm-rf.mjs";

const {
  classifyArchive, sanitizeArchivePath, isJunkPath, detectSingleRootFromDir,
  pickFinalName, handleWorkspaceUpload, handleCapabilities,
} = await import("./workspace-upload.ts");

const FIXTURES = join(import.meta.dirname, "fixtures");

function makeCtx(params) {
  return { searchParams: new URLSearchParams(params) };
}

function uploadReq(name, dir, buffer) {
  return new Request(`http://x/api/extensions/session-manager/workspace/upload?name=${encodeURIComponent(name)}&dir=${encodeURIComponent(dir)}`, {
    method: "POST",
    body: buffer,
  });
}

async function upload(name, dir, buffer) {
  const res = await handleWorkspaceUpload(uploadReq(name, dir, buffer), makeCtx({ name, dir }));
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}

// ───────── 纯函数 ─────────

test("classifyArchive 识别全部支持格式并剥离扩展名", () => {
  assert.deepEqual(classifyArchive("photos.zip"), { kind: "zip", base: "photos" });
  assert.deepEqual(classifyArchive("proj.tar.gz"), { kind: "tar.gz", base: "proj" });
  assert.deepEqual(classifyArchive("proj.tgz"), { kind: "tar.gz", base: "proj" });
  assert.deepEqual(classifyArchive("proj.tar.bz2"), { kind: "tar.bz2", base: "proj" });
  assert.deepEqual(classifyArchive("proj.tbz2"), { kind: "tar.bz2", base: "proj" });
  assert.deepEqual(classifyArchive("proj.tar.xz"), { kind: "tar.xz", base: "proj" });
  assert.deepEqual(classifyArchive("proj.txz"), { kind: "tar.xz", base: "proj" });
  assert.deepEqual(classifyArchive("proj.tar"), { kind: "tar", base: "proj" });
  assert.deepEqual(classifyArchive("backup.rar"), { kind: "rar", base: "backup" });
  assert.deepEqual(classifyArchive("pack.7z"), { kind: "7z", base: "pack" });
  assert.equal(classifyArchive("file.txt"), null);
  assert.equal(classifyArchive("no-ext"), null);
});

test("sanitizeArchivePath 拒绝 .. / 绝对路径 / 盘符，统一反斜杠", () => {
  assert.deepEqual(sanitizeArchivePath("a/b/c.txt"), ["a", "b", "c.txt"]);
  assert.deepEqual(sanitizeArchivePath("a\\b\\c.txt"), ["a", "b", "c.txt"]); // Windows zip 反斜杠
  assert.equal(sanitizeArchivePath("../evil.txt"), null);
  assert.equal(sanitizeArchivePath("a/../../b"), null);
  assert.equal(sanitizeArchivePath("/abs/path"), null);
  assert.equal(sanitizeArchivePath("C:/win/evil"), null);
  assert.equal(sanitizeArchivePath("a/C:/b"), null);
  assert.equal(sanitizeArchivePath(""), null);
  assert.equal(sanitizeArchivePath("a/./b"), null);
});

test("isJunkPath：__MACOSX 前缀树 / .DS_Store / AppleDouble", () => {
  assert.equal(isJunkPath(["__MACOSX", "myproj", "._x"]), true);
  assert.equal(isJunkPath(["myproj", ".DS_Store"]), true);
  assert.equal(isJunkPath(["myproj", "._resource"]), true);
  assert.equal(isJunkPath(["myproj", "src", "main.py"]), false);
  assert.equal(isJunkPath(["myproj"]), false);
});

test("detectSingleRootFromDir：单根 / 多顶层 / 顶层散文件 / 垃圾干扰 / 空", () => {
  const root = mkdtempSync(join(tmpdir(), "wsu-detect-"));
  try {
    // 单根
    mkdirSync(join(root, "one", "src"), { recursive: true });
    writeFileSync(join(root, "one", "README.md"), "x");
    writeFileSync(join(root, "one", "src", "a.py"), "x");
    assert.equal(detectSingleRootFromDir(root), "one");
    // 多顶层
    rmSync(join(root, "one"), { recursive: true });
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "b.txt"), "x");
    assert.equal(detectSingleRootFromDir(root), null);
    // 顶层单散文件
    rmSync(join(root, "a"), { recursive: true });
    assert.equal(detectSingleRootFromDir(root), null);
    // 垃圾干扰后单根
    rmSync(join(root, "b.txt"));
    mkdirSync(join(root, "proj"), { recursive: true });
    writeFileSync(join(root, "proj", "a.txt"), "x");
    writeFileSync(join(root, ".DS_Store"), "x");
    writeFileSync(join(root, "._meta"), "x");
    mkdirSync(join(root, "__MACOSX"), { recursive: true });
    assert.equal(detectSingleRootFromDir(root), "proj");
    // 空
    rmSync(join(root, "proj"), { recursive: true });
    rmSync(join(root, ".DS_Store"));
    rmSync(join(root, "._meta"));
    rmSync(join(root, "__MACOSX"), { recursive: true });
    assert.equal(detectSingleRootFromDir(root), null);
  } finally {
    rmRf(root);
  }
});

test("pickFinalName 冲突顺延 -2/-3", () => {
  const exists = new Set();
  assert.equal(pickFinalName("myproj", (n) => exists.has(n)), "myproj");
  exists.add("myproj");
  assert.equal(pickFinalName("myproj", (n) => exists.has(n)), "myproj-2");
  exists.add("myproj-2");
  assert.equal(pickFinalName("myproj", (n) => exists.has(n)), "myproj-3");
});

// ───────── handler 端到端（真 fixture） ─────────

test("上传带单根 zip：直接解压落位根目录，不新建文件夹", async () => {
  const target = mkdtempSync(join(tmpdir(), "wsu-e2e-"));
  try {
    const buf = readZip("single-root.zip");
    const { status, body } = await upload("myproj.zip", target, buf);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.singleRoot, true);
    assert.equal(body.renamed, false);
    assert.equal(body.root, join(target, "myproj"));
    assert.ok(existsSync(join(body.root, "src", "main.py")));
    // staging 已清理
    assert.deepEqual(readdirSync(target).filter((n) => n.startsWith(".sm-upload-")), []);
  } finally {
    rmRf(target);
  }
});

test("上传散文件 zip：按包名建目录再解压", async () => {
  const target = mkdtempSync(join(tmpdir(), "wsu-e2e-"));
  try {
    const { status, body } = await upload("flat-files.zip", target, readZip("flat-files.zip"));
    assert.equal(status, 200);
    assert.equal(body.singleRoot, false);
    assert.equal(body.root, join(target, "flat-files"));
    assert.ok(existsSync(join(body.root, "readme.txt")));
    assert.ok(existsSync(join(body.root, "notes", "idea.md")));
  } finally {
    rmRf(target);
  }
});

test("重复上传同一包：自动顺延 -2 永不覆盖", async () => {
  const target = mkdtempSync(join(tmpdir(), "wsu-e2e-"));
  try {
    const first = await upload("myproj.zip", target, readZip("single-root.zip"));
    assert.equal(first.status, 200);
    assert.equal(first.body.root, join(target, "myproj"));
    const second = await upload("myproj.zip", target, readZip("single-root.zip"));
    assert.equal(second.status, 200);
    assert.equal(second.body.renamed, true);
    assert.equal(second.body.root, join(target, "myproj-2"));
    assert.ok(existsSync(join(target, "myproj", "README.md")), "第一次的目录原样保留");
    assert.ok(existsSync(join(second.body.root, "README.md")));
  } finally {
    rmRf(target);
  }
});

test("mac 垃圾干扰 zip：__MACOSX/.DS_Store 不落盘且单根判定不受影响", async () => {
  const target = mkdtempSync(join(tmpdir(), "wsu-e2e-"));
  try {
    const { status, body } = await upload("myproj.zip", target, readZip("macos-junk.zip"));
    assert.equal(status, 200);
    assert.equal(body.singleRoot, true);
    assert.equal(body.root, join(target, "myproj"));
    assert.ok(existsSync(join(body.root, "a.txt")));
    assert.equal(existsSync(join(body.root, ".DS_Store")), false);
    assert.equal(existsSync(join(target, "__MACOSX")), false);
  } finally {
    rmRf(target);
  }
});

test("恶意路径 zip（../）：拒绝解压且不落任何文件", async () => {
  const target = mkdtempSync(join(tmpdir(), "wsu-e2e-"));
  try {
    const { status, body } = await upload("evil.zip", target, readZip("evil-paths.zip"));
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /非法路径/);
    assert.equal(existsSync(join(target, "normal.txt")), false, "包内正常文件也不应落位（整包拒绝）");
    assert.equal(existsSync(join(target, "evil.txt")), false);
    assert.deepEqual(readdirSync(target).filter((n) => n.startsWith(".sm-upload-")), [], "staging 已清理");
  } finally {
    rmRf(target);
  }
});

test("不支持的格式 415；缺参数 400；目标目录不存在 400", async () => {
  const target = mkdtempSync(join(tmpdir(), "wsu-e2e-"));
  try {
    const bad = await upload("movie.mp4", target, Buffer.from([1]));
    assert.equal(bad.status, 415);
    const noName = await upload("", target, Buffer.from([1]));
    assert.equal(noName.status, 400);
    const noDir = await upload("a.zip", "/nonexistent-dir-xyz", Buffer.from([1]));
    assert.equal(noDir.status, 400);
    assert.deepEqual(readdirSync(target), [], "全程零落盘");
  } finally {
    rmRf(target);
  }
});

test("GET capabilities：zip/tar 恒可用，rar/7z 字段存在（值随机器）", async () => {
  const res = await handleCapabilities();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.zip, true);
  assert.equal(body.tar, true);
  assert.ok("rar" in body && "sevenz" in body);
});

test("无尾斜杠目录条目（unix/MS-DOS 目录位）：不落盘为文件，子路径正常解压（git-pullkeep 回归）", async () => {
  const target = mkdtempSync(join(tmpdir(), "wsu-noslash-"));
  try {
    const { status, body } = await upload("git-pullkeep.zip", target, readZip("no-slash-dirs.zip"));
    assert.equal(status, 200, `解压失败: ${JSON.stringify(body)}`);
    assert.equal(body.singleRoot, true);
    assert.equal(body.root, join(target, "git-pullkeep"));
    assert.ok(existsSync(join(body.root, "run.sh")));
    assert.ok(existsSync(join(body.root, "sub", "a.txt")));
    assert.ok(statSync(join(body.root)).isDirectory());
    assert.ok(statSync(join(body.root, "sub")).isDirectory());
  } finally {
    rmRf(target);
  }
});

test("病态包（同路径既文件又目录）：400 明确报错而非 500 EEXIST", async () => {
  const target = mkdtempSync(join(tmpdir(), "wsu-conflict-"));
  try {
    const { status, body } = await upload("conflict.zip", target, readZip("path-conflict.zip"));
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /路径冲突/);
    assert.deepEqual(readdirSync(target).filter((n) => n.startsWith(".sm-upload-")), [], "staging 已清理");
  } finally {
    rmRf(target);
  }
});

// ───────── tar 系端到端（系统 tar 现场打包；无 tar 环境跳过） ─────────

function hasTar() {
  try {
    const r = spawnSync("tar", ["--version"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0;
  } catch { return false; }
}

test("上传 tar.gz（带单根）：tar 通道解压落位", { skip: !hasTar() ? "系统无 tar" : false }, async () => {
  const target = mkdtempSync(join(tmpdir(), "wsu-tar-"));
  const src = mkdtempSync(join(tmpdir(), "wsu-tarsrc-"));
  try {
    // 现场打包：<src>/tarproj/{a.txt,b/c.txt}
    mkdirSync(join(src, "tarproj", "b"), { recursive: true });
    writeFileSync(join(src, "tarproj", "a.txt"), "tar\n");
    writeFileSync(join(src, "tarproj", "b", "c.txt"), "tar2\n");
    const tgz = join(src, "tarproj.tar.gz");
    const r = spawnSync("tar", ["-czf", tgz, "-C", src, "tarproj"], { encoding: "utf8", timeout: 15000 });
    assert.equal(r.status, 0, `tar 打包失败: ${r.stderr}`);
    const buf = readFileSync(tgz);

    const { status, body } = await upload("tarproj.tar.gz", target, buf);
    assert.equal(status, 200, `解压失败: ${JSON.stringify(body)}`);
    assert.equal(body.singleRoot, true);
    assert.equal(body.root, join(target, "tarproj"));
    assert.ok(existsSync(join(body.root, "b", "c.txt")));
    assert.deepEqual(readdirSync(target).filter((n) => n.startsWith(".sm-upload-")), []);
  } finally {
    rmRf(target);
    rmRf(src);
  }
});

test("上传 tar.gz（散文件）：按包名建目录", { skip: !hasTar() ? "系统无 tar" : false }, async () => {
  const target = mkdtempSync(join(tmpdir(), "wsu-tar-"));
  const src = mkdtempSync(join(tmpdir(), "wsu-tarsrc-"));
  try {
    writeFileSync(join(src, "loose.txt"), "x");
    writeFileSync(join(src, "loose2.txt"), "y");
    const tgz = join(src, "loose-bundle.tar.gz");
    const r = spawnSync("tar", ["-czf", tgz, "-C", src, "loose.txt", "loose2.txt"], { encoding: "utf8", timeout: 15000 });
    assert.equal(r.status, 0, `tar 打包失败: ${r.stderr}`);
    const buf = readFileSync(tgz);

    const { status, body } = await upload("loose-bundle.tar.gz", target, buf);
    assert.equal(status, 200, `解压失败: ${JSON.stringify(body)}`);
    assert.equal(body.singleRoot, false);
    assert.equal(body.root, join(target, "loose-bundle"));
    assert.ok(existsSync(join(body.root, "loose.txt")));
  } finally {
    rmRf(target);
    rmRf(src);
  }
});

// ───────── 工具 ─────────

import { readFileSync } from "fs";
function readZip(name) {
  return readFileSync(join(FIXTURES, name));
}
