/**
 * sync-dir 残留保留窗单测（node --test）。
 *
 * 钉死 2026-09-22 的部署打断事故：vite 懒 chunk 是点击时才 import，而部署把上一轮
 * `sessions-panel-<hash>.js` 直接 --delete 掉 → 部署前就打开的页面点 All Sessions 拉旧
 * chunk 名 404，面板「打不开」（用户报「全部会话无法打开了」）。
 * delGraceMs 窗内（mtime = 部署拷贝时刻）不删，超窗才清理。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { syncDir } from "./sync-dir.mjs";

const HOUR = 3600 * 1000;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sync-dir-test-"));
  const src = join(root, "src");
  const dst = join(root, "dst");
  mkdirSync(src, { recursive: true });
  mkdirSync(dst, { recursive: true });
  const put = (dir, rel, body = "x") => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    return p;
  };
  const age = (rel, ms) => {
    const t = new Date(Date.now() - ms);
    utimesSync(join(dst, rel), t, t);
  };
  return { root, src, dst, put, age };
}

test("窗内残留保留，超窗残留清理", () => {
  const { root, src, dst, put, age } = fixture();
  put(src, "entry-new12345.js", "new-build");
  put(dst, "entry-old12345.js"); age("entry-old12345.js", 60 * 1000);            // 上轮 chunk（1min）
  put(dst, "sessions-panel-abcdef12.js"); age("sessions-panel-abcdef12.js", 5 * HOUR); // 窗内懒 chunk
  put(dst, "kanban-99887766.js"); age("kanban-99887766.js", 7 * HOUR);            // 超窗
  put(dst, "stale-server-side.mjs"); age("stale-server-side.mjs", 10 * 1000);     // 非 chunk 名，同样保留
  const st = syncDir(src, dst, { del: true });
  assert.ok(existsSync(join(dst, "entry-new12345.js")), "本轮产物必须拷进来");
  assert.ok(existsSync(join(dst, "entry-old12345.js")), "窗内上轮 chunk 不得删（在网页面还指着它）");
  assert.ok(existsSync(join(dst, "sessions-panel-abcdef12.js")), "窗内懒 chunk 不得删");
  assert.ok(!existsSync(join(dst, "kanban-99887766.js")), "超窗 chunk 要删（磁盘不无限增长）");
  assert.equal(st.deleted, 1);
  assert.equal(st.kept, 3);
  rmSync(root, { recursive: true, force: true });
});

test("delGraceMs:0 恢复立即删（显式调用方语义）", () => {
  const { root, src, dst, put, age } = fixture();
  put(src, "entry-new12345.js", "new-build");
  put(dst, "entry-old12345.js"); age("entry-old12345.js", 1000);
  syncDir(src, dst, { del: true, delGraceMs: 0 });
  assert.ok(!existsSync(join(dst, "entry-old12345.js")));
  rmSync(root, { recursive: true, force: true });
});

test("del:false 时残留一律不动", () => {
  const { root, src, dst, put } = fixture();
  put(src, "index.mjs", "a");
  put(dst, "old-abcdefgh.js");
  const st = syncDir(src, dst);
  assert.ok(existsSync(join(dst, "old-abcdefgh.js")));
  assert.equal(st.deleted, 0);
  assert.equal(st.kept, 0);
  rmSync(root, { recursive: true, force: true });
});

test("exclude 条目优先于窗口：保护项永不删", () => {
  const { root, src, dst, put, age } = fixture();
  put(src, "index.mjs", "a");
  put(dst, "node_modules/keep.js", "dep");
  put(dst, "notes.txt"); age("notes.txt", 10 * 1000);
  syncDir(src, dst, {
    del: true,
    delGraceMs: 0,
    exclude: (rel) => rel.startsWith("node_modules"),
  });
  assert.ok(existsSync(join(dst, "node_modules/keep.js")), "exclude 项即使 del+超窗也不删");
  assert.ok(!existsSync(join(dst, "notes.txt")));
  rmSync(root, { recursive: true, force: true });
});

test("dst 独有目录按目录自身 mtime 判窗", () => {
  const { root, src, dst, put, age } = fixture();
  put(src, "sub/keep-me.js", "src");
  put(dst, "sub/gone-old.js"); age("sub/gone-old.js", 7 * HOUR); // src 也有 sub → 逐文件判
  put(dst, "oldassets/chunk-abcdefgh.js");
  age("oldassets", 7 * HOUR); // 整目录年龄超窗 → 递归删
  put(dst, "recentdir/chunk-12345678.js"); // 目录 mtime=now → 窗内整目录保留
  syncDir(src, dst, { del: true });
  assert.ok(!existsSync(join(dst, "sub/gone-old.js")), "src 同名目录下的超窗文件照删");
  assert.ok(!existsSync(join(dst, "oldassets")), "超窗整目录删");
  assert.ok(existsSync(join(dst, "recentdir/chunk-12345678.js")), "窗内新目录不得整目录删");
  rmSync(root, { recursive: true, force: true });
});
