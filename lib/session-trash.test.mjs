import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { trashFileSync, trashRootDir } = await import("./session-trash.ts");

/** 每个用例一个独立 Trash 根：PI_WEB_TRASH_DIR 覆盖，结束后恢复环境变量并清理。 */
function createTrashRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-trash-"));
  const previous = process.env.PI_WEB_TRASH_DIR;
  process.env.PI_WEB_TRASH_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEB_TRASH_DIR;
    else process.env.PI_WEB_TRASH_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** 造一个待删的“会话文件”（独立临时目录，避免同 basename 冲突用例互相影响）。 */
function createSource(t, name = "2026-09-12T13-28-33-464Z_abc.jsonl", contents = "{}\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-session-src-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

test("moves the session file into the trash with a .trashinfo record", (t) => {
  const root = createTrashRoot(t);
  const source = createSource(t, "s.jsonl", "session-body");

  const target = trashFileSync(source);

  assert.ok(target);
  assert.equal(fs.existsSync(source), false, "source path must be gone");
  assert.equal(target, path.join(root, "files", "s.jsonl"));
  assert.equal(fs.readFileSync(target, "utf8"), "session-body");
  const info = fs.readFileSync(path.join(root, "info", "s.jsonl.trashinfo"), "utf8");
  assert.match(info, /^\[Trash Info\]\nPath=/);
  assert.ok(info.includes(`Path=${encodeURI(source)}`), `trashinfo must record the original path: ${info}`);
  assert.match(info, /DeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test("does not clobber an existing trashed file with the same name", (t) => {
  const root = createTrashRoot(t);
  const first = createSource(t, "same.jsonl");
  const second = createSource(t, "same.jsonl");

  const firstTarget = trashFileSync(first);
  const secondTarget = trashFileSync(second);

  assert.equal(path.basename(firstTarget), "same.jsonl");
  assert.equal(path.basename(secondTarget), "same.jsonl.1");
  assert.ok(fs.existsSync(path.join(root, "files", "same.jsonl.1")));
  assert.ok(fs.existsSync(path.join(root, "info", "same.jsonl.1.trashinfo")));
});

test("returns null for a missing file instead of throwing", (t) => {
  const root = createTrashRoot(t);
  assert.equal(trashFileSync(path.join(root, "does-not-exist.jsonl")), null);
});

test("trashRootDir honours PI_WEB_TRASH_DIR, then XDG_DATA_HOME", (t) => {
  const root = createTrashRoot(t);
  assert.equal(trashRootDir(), root);

  delete process.env.PI_WEB_TRASH_DIR;
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = "/tmp/pi-web-xdg-data-test";
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
  });
  assert.equal(trashRootDir(), path.join("/tmp/pi-web-xdg-data-test", "Trash"));
});
