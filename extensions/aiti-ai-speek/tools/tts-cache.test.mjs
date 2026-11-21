// Real-module tests for server/tts-cache.ts (transpiled in memory, no build step needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transformSync } from "esbuild";

const src = readFileSync(new URL("../server/tts-cache.ts", import.meta.url), "utf8");
const js = transformSync(src, { loader: "ts", format: "esm", target: "node20" }).code;
const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tts-cache-"));
  return dir;
}
function put(dir, name, size, ageDays) {
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(size, "x"));
  if (ageDays) {
    const t = (NOW - ageDays * DAY) / 1000;
    utimesSync(p, t, t);
  }
  return p;
}

test("cleanExpired reclaims old and empty cache files of every format", () => {
  const dir = fixture();
  try {
    put(dir, "old.mp3", 2048, 31);
    put(dir, "old.wav", 4096, 40);
    put(dir, "empty.wav", 0, 0);
    put(dir, "keep.mp3", 1024, 2);
    put(dir, "keep.wav", 1024, 5);
    writeFileSync(join(dir, "notes.json"), "{}");
    const r = mod.cleanExpired(dir, NOW);
    assert.equal(r.cleaned, 3);
    assert.deepEqual(readdirSync(dir).sort(), ["keep.mp3", "keep.wav", "notes.json"]);
    assert.equal(mod.cleanExpired(join(dir, "missing"), NOW).cleaned, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lruEvict removes the oldest files across formats down to 80%", () => {
  const dir = fixture();
  try {
    put(dir, "a.wav", 400, 10);
    put(dir, "b.mp3", 400, 5);
    put(dir, "c.wav", 400, 1);
    const r = mod.lruEvict(dir, 1000);
    assert.equal(r.removed, 1);            // 1200 > 1000 -> delete oldest until <= 800
    assert.deepEqual(readdirSync(dir).sort(), ["b.mp3", "c.wav"]);
    assert.equal(mod.lruEvict(dir, 1000).removed, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("findCacheFile resolves either extension and ignores unknown ones", () => {
  const dir = fixture();
  try {
    put(dir, "abc.wav", 12, 0);
    put(dir, "def.mp3", 12, 0);
    assert.deepEqual(mod.findCacheFile(dir, "abc"), { file: join(dir, "abc.wav"), ext: ".wav" });
    assert.deepEqual(mod.findCacheFile(dir, "def"), { file: join(dir, "def.mp3"), ext: ".mp3" });
    assert.equal(mod.findCacheFile(dir, "zzz"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cacheStats counts files and bytes per extension", () => {
  const dir = fixture();
  try {
    put(dir, "a.wav", 100, 0);
    put(dir, "b.wav", 200, 0);
    put(dir, "c.mp3", 50, 0);
    put(dir, "ignore.txt", 999, 0);
    const s = mod.cacheStats(dir);
    assert.equal(s.count, 3);
    assert.equal(s.bytes, 350);
    assert.deepEqual(s.byExt, { ".wav": 2, ".mp3": 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("content types and cache dir layout", () => {
  assert.equal(mod.contentTypeOf("x.wav"), "audio/wav");
  assert.equal(mod.contentTypeOf("x.mp3"), "audio/mpeg");
  assert.equal(mod.ttsCacheDir("/data/config"), "/data/config/cache/tts-cache");
  assert.equal(mod.cacheRoot("/data/config"), "/data/cache");
  assert.ok(mod.isCacheFile("k.wav") && mod.isCacheFile("k.mp3") && !mod.isCacheFile("k.json"));
});
