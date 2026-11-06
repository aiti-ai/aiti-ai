import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-route-")));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousRoots = globalThis.__piAllowedRootsCache;
process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
process.env.PI_WEB_FILE_SANDBOX = "1"; // 合并：上游安全测试假设文件沙箱强制执行（本地默认关，测试内显式开）
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  globalThis.__piAllowedRootsCache = previousRoots;
  fs.rmSync(base, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { POST } = await jiti.import("./[...path]/route.ts");
const { encodeFilePathForApi } = await jiti.import("../../../lib/file-paths.ts");
const { NextRequest } = await jiti.import("next/server");

function fixture() {
  const directory = fs.mkdtempSync(path.join(base, "files-"));
  globalThis.__piAllowedRootsCache = { roots: new Set([directory]), expiresAt: Date.now() + 60_000 };
  const destination = path.join(directory, "important.txt");
  fs.writeFileSync(destination, "original contents");
  return { directory, destination };
}

async function upload(directory, strategy = "overwrite", names = ["important.txt"], ensure = false) {
  // 合并契约（本地演化版）：POST /api/files/upload?conflict=…，directory 走 multipart 字段而非 URL 段
  const form = new FormData();
  form.append("directory", directory);
  for (const name of names) form.append("files", new File(["replacement"], name));
  return POST(new NextRequest(`http://localhost/api/files/upload?conflict=${strategy}${ensure ? "&ensure=1" : ""}`, {
    method: "POST", headers: { host: "localhost" }, body: form,
  }), { params: Promise.resolve({ path: ["upload"] }) });
}

// 上游 wire 形态：directory 编码进 URL 路径段（lib/file-upload-client uploadFiles/upload-check）。
// 回归：catch-all 段不含首斜杠，直接 join 会把 Unix 绝对路径变相对（"home/…" → "path must be absolute" 400），
// Windows 盘符路径侥幸存活——必须经 filePathFromApiSegments 还原。
async function uploadViaUrlPath(directory, type = "upload", names = ["important.txt"]) {
  const form = new FormData();
  for (const name of names) form.append("files", new File(["replacement"], name));
  const encoded = encodeFilePathForApi(directory);
  const segments = encoded.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  return POST(new NextRequest(
    `http://localhost/api/files/${encoded}?type=${type}&conflict=skip${type === "upload" ? "&ensure=1" : ""}`,
    { method: "POST", headers: { host: "localhost" }, body: form },
  ), { params: Promise.resolve({ path: segments }) });
}

test("url-path directory form restores the leading slash for unix absolute paths (upload)", async () => {
  const { directory } = fixture();
  const response = await uploadViaUrlPath(directory, "upload", ["important.txt", "fresh.txt"]);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { uploaded: ["fresh.txt"], skipped: ["important.txt"], errors: [] });
  assert.equal(fs.readFileSync(path.join(directory, "fresh.txt"), "utf8"), "replacement");
  assert.equal(fs.readFileSync(path.join(directory, "important.txt"), "utf8"), "original contents");
});

test("url-path directory form restores the leading slash for unix absolute paths (upload-check)", async () => {
  const { directory } = fixture();
  const form = new FormData(); // upload-check 无文件也不需要 body 文件，但 POST 需要 multipart 或 JSON
  const encoded = encodeFilePathForApi(directory);
  const segments = encoded.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  const response = await POST(new NextRequest(
    `http://localhost/api/files/${encoded}?type=upload-check&conflict=skip`,
    { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ fileNames: ["important.txt"] }) },
  ), { params: Promise.resolve({ path: segments }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.conflicts, ["important.txt"]);
});

test("windows drive-letter directory in url path stays absolute", async () => {
  const fixtureRoot = path.dirname(fixture().directory);
  globalThis.__piAllowedRootsCache = { roots: new Set(["D:/workspace/proj"]), expiresAt: Date.now() + 60_000 };
  const form = new FormData();
  form.append("files", new File(["replacement"], "important.txt"));
  const response = await POST(new NextRequest(
    "http://localhost/api/files/D:/workspace/proj?type=upload&conflict=skip&ensure=1",
    { method: "POST", headers: { host: "localhost" }, body: form },
  ), { params: Promise.resolve({ path: ["D:", "workspace", "proj"] }) });
  // Linux 测试机上该目录不存在 → 404/403，但绝不能再是 "path must be absolute"（回归锚点）
  const body = await response.json();
  assert.notEqual(body.error, "path must be absolute");
  void fixtureRoot;
});

for (const partial of [false, true]) {
  test(`failed overwrite preserves original and cleans staging (partial write: ${partial})`, async (t) => {
    const { directory, destination } = fixture();
    const write = fs.writeFileSync;
    let injected = false;
    t.mock.method(fs, "writeFileSync", (target, ...args) => {
      if (String(target).startsWith(directory + path.sep)) {
        injected = true;
        if (partial) write(target, "partial replacement", args[1]);
        throw Object.assign(new Error("simulated ENOSPC"), { code: "ENOSPC" });
      }
      return write(target, ...args);
    });
    const response = await upload(directory);
    assert.equal(injected, true);
    assert.equal(response.status, 207);
    assert.deepEqual(await response.json(), {
      uploaded: [], skipped: [], errors: [{ name: "important.txt", error: "simulated ENOSPC" }],
    });
    assert.equal(fs.readFileSync(destination, "utf8"), "original contents");
    assert.deepEqual(fs.readdirSync(directory), ["important.txt"]);
  });
}

test("failed replacement rename preserves original and cleans staging", async (t) => {
  const { directory, destination } = fixture();
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === destination) {
      assert.equal(fs.readFileSync(from, "utf8"), "replacement");
      assert.equal(fs.readFileSync(to, "utf8"), "original contents");
      throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
    }
    return rename(from, to);
  });
  const response = await upload(directory);
  assert.equal(response.status, 207);
  assert.equal((await response.json()).errors[0].error, "simulated EACCES");
  assert.equal(fs.readFileSync(destination, "utf8"), "original contents");
  assert.deepEqual(fs.readdirSync(directory), ["important.txt"]);
});

test("successful overwrite and fresh upload leave only complete destination files", async () => {
  const { directory, destination } = fixture();
  const response = await upload(directory, "overwrite", ["important.txt", "new.txt"]);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { uploaded: ["important.txt", "new.txt"], skipped: [], errors: [] });
  assert.equal(fs.readFileSync(destination, "utf8"), "replacement");
  assert.equal(fs.readFileSync(path.join(directory, "new.txt"), "utf8"), "replacement");
  assert.deepEqual(fs.readdirSync(directory).sort(), ["important.txt", "new.txt"]);
});

test("refuses a destination changed to a link while the replacement is staged", async (t) => {
  const { directory, destination } = fixture();
  const outside = fs.mkdtempSync(path.join(base, "changed-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "private contents");
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (target, ...args) => {
    const result = write(target, ...args);
    if (String(target).startsWith(directory + path.sep)) {
      fs.unlinkSync(destination);
      fs.symlinkSync(outside, destination, process.platform === "win32" ? "junction" : "dir");
    }
    return result;
  });
  const response = await upload(directory);
  assert.equal(response.status, 207);
  assert.equal((await response.json()).errors[0].error, "Cannot replace a directory or symbolic link");
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "private contents");
  assert.deepEqual(fs.readdirSync(directory), ["important.txt"]);
});

test("error and skip conflict strategies preserve the existing file", async () => {
  const { directory, destination } = fixture();
  assert.equal((await upload(directory, "error")).status, 409);
  const response = await upload(directory, "skip");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { uploaded: [], skipped: ["important.txt"], errors: [] });
  assert.equal(fs.readFileSync(destination, "utf8"), "original contents");
});

test("overwrite refuses directories and directory links without touching their targets", async () => {
  const { directory } = fixture();
  const outside = fs.mkdtempSync(path.join(base, "outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "private contents");
  fs.mkdirSync(path.join(directory, "folder"));
  fs.symlinkSync(outside, path.join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
  const response = await upload(directory, "overwrite", ["folder", "linked"]);
  assert.equal(response.status, 207);
  const body = await response.json();
  assert.deepEqual(body.uploaded, []);
  assert.deepEqual(body.errors.map((entry) => entry.name), ["folder", "linked"]);
  assert.equal(fs.lstatSync(path.join(directory, "linked")).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "private contents");
});

test("ensure=1 creates the attachments directory on demand with a self-hiding .gitignore", async () => {
  const { directory } = fixture();
  const attachments = path.join(directory, ".pi-attachments");
  assert.equal(fs.existsSync(attachments), false);
  const response = await upload(attachments, "skip", ["spec.pdf"], true);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { uploaded: ["spec.pdf"], skipped: [], errors: [] });
  // Directory auto-created; the inner .gitignore makes the whole directory —
  // itself included — invisible to git status without touching the repo's own ignore files.
  assert.equal(fs.readFileSync(path.join(attachments, "spec.pdf"), "utf8"), "replacement");
  assert.equal(fs.readFileSync(path.join(attachments, ".gitignore"), "utf8"), "*\n");
});

test("ensure=1 never overwrites an existing .gitignore and stays symlink-safe", async () => {
  const { directory } = fixture();
  const attachments = path.join(directory, ".pi-attachments");
  fs.mkdirSync(attachments);
  fs.writeFileSync(path.join(attachments, ".gitignore"), "*.log\n");
  const response = await upload(attachments, "skip", ["spec.pdf"], true);
  assert.equal(response.status, 200);
  // User-authored ignore rules are never touched (write flag wx).
  assert.equal(fs.readFileSync(path.join(attachments, ".gitignore"), "utf8"), "*.log\n");

  // A directory symlink pointing outside the allowed roots: rejected before
  // anything (upload or the auto-.gitignore) lands outside.
  fs.rmSync(attachments, { recursive: true });
  const outside = fs.mkdtempSync(path.join(base, "outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "private contents");
  fs.symlinkSync(outside, attachments, process.platform === "win32" ? "junction" : "dir");
  const escaped = await upload(attachments, "skip", ["spec.pdf"], true);
  assert.equal(escaped.status, 403);
  assert.deepEqual(fs.readdirSync(outside), ["secret.txt"]);
});
