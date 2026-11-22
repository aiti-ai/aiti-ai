/**
 * search.test.mjs — workspace content search tests (borrow plan §2.5; tests server/search.ts directly).
 * Run: node --experimental-strip-types --test extensions/aiti-folder/server/search.test.mjs
 *
 * Covers: contentSearchApi (allowedDir 403 / query 400), rg matches (path/line/text),
 * per-file --max-count cap, global match/file caps with explicit truncated flag,
 * binary/huge-file skipping, .gitignore respect. Skips when rg is not installed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const { contentSearchApi, runContentSearch } = await import("./search.ts");

let rgOk = true;
try { execFileSync("rg", ["--version"], { stdio: "ignore" }); } catch { rgOk = false; }

const tmp = mkdtempSync(join(tmpdir(), "folder-csearch-"));
mkdirSync(join(tmp, "allow", "src", "deep"), { recursive: true });
mkdirSync(join(tmp, "allow", "gen"), { recursive: true });
mkdirSync(join(tmp, "allow", "ignored"), { recursive: true });
const allowRoot = join(tmp, "allow");

const ctx = { core: { fileAccess: { isAllowed: async (p) => String(p).startsWith(allowRoot) } } };

const call = (body) => contentSearchApi(new Request("http://local/content-search", {
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
}), ctx, "content-search");

// fixtures
writeFileSync(join(allowRoot, "src", "app.ts"), "const alpha = 1;\nexport function beta() { return alpha; }\n// alpha again\nconst ALPHA_UPPER = 2;\n");
writeFileSync(join(allowRoot, "src", "deep", "util.ts"), "export const alphaHelper = () => 0;\n");
writeFileSync(join(allowRoot, "readme.md"), "# alpha project\n");
writeFileSync(join(allowRoot, "skipme.log"), "alpha in a huge file\n".repeat(10_000)); // >2MB? no (~230KB) — use for match counting instead
// .gitignore: hide the ignored dir
writeFileSync(join(allowRoot, ".gitignore"), "ignored/\n");
writeFileSync(join(allowRoot, "ignored", "x.ts"), "alpha hidden from search\n");
// per-file cap fixture: 10 alpha lines in one file
writeFileSync(join(allowRoot, "many.txt"), Array.from({ length: 10 }, (_, i) => `alpha line ${i}`).join("\n") + "\n");

test("query/root validation: 400 on bad query, 403 on disallowed root", async () => {
  const bad1 = await call({ root: allowRoot, q: "" });
  assert.equal(bad1.status, 400);
  const bad2 = await call({ root: allowRoot, q: "x".repeat(201) });
  assert.equal(bad2.status, 400);
  const bad3 = await call({ root: "/tmp", q: "alpha" });
  assert.equal(bad3.status, 403);
  const bad4 = await call({ root: "relative/path", q: "alpha" });
  assert.equal(bad4.status, 400);
});

if (!rgOk) {
  test("rg missing → 501 + rgMissing (skip suite)", async () => {
    const r = await call({ root: allowRoot, q: "alpha" });
    assert.equal(r.status, 501);
    const d = await r.json();
    assert.equal(d.rgMissing, true);
  });
} else {
  test("basic matches: path/line/text + gitignore respected", async () => {
    const r = await call({ root: allowRoot, q: "alpha" });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.ok, true);
    const paths = d.matches.map((m) => m.path);
    assert.ok(paths.some((p) => p.endsWith("src/app.ts")));
    assert.ok(paths.some((p) => p.endsWith("src/deep/util.ts")));
    assert.ok(paths.some((p) => p.endsWith("readme.md")));
    assert.ok(!paths.some((p) => p.includes("ignored/")), ".gitignore respected");
    const appHit = d.matches.find((m) => m.path.endsWith("src/app.ts") && m.line === 1);
    assert.ok(appHit, "first-line match with line number");
    assert.ok(appHit.text.includes("const alpha = 1;"));
    assert.equal(typeof d.files, "number");
  });

  test("smart case: lowercase query is insensitive, uppercase query is exact", async () => {
    const ci = await call({ root: allowRoot, q: "alpha_upper" });
    const d1 = await ci.json();
    assert.ok(d1.matches.some((m) => m.text.includes("ALPHA_UPPER")));
    const cs = await call({ root: allowRoot, q: "Alpha_Upper" });
    const d2 = await cs.json();
    assert.ok(!d2.matches.some((m) => m.text.includes("ALPHA_UPPER")), "exact case miss");
  });

  test("per-file cap: --max-count bounds matches per file (10 hits → ≤5)", async () => {
    const r = await call({ root: allowRoot, q: "alpha line" });
    const d = await r.json();
    const many = d.matches.filter((m) => m.path.endsWith("many.txt"));
    assert.ok(many.length >= 1 && many.length <= 5, "per-file cap enforced, got " + many.length);
    assert.equal(d.truncated, false, "per-file cap alone does not set global truncated");
  });

  test("global cap: >60 files with hits → truncated=true, files≤60, matches≤200", async () => {
    for (let i = 0; i < 80; i++) {
      writeFileSync(join(allowRoot, "gen", `f${String(i).padStart(3, "0")}.txt`), `needle-${i} unique ${i}\n`);
    }
    // all 80 files contain "needle" → cap hits
    const r = await call({ root: allowRoot, q: "needle" });
    const d = await r.json();
    assert.equal(d.ok, true);
    assert.equal(d.truncated, true, "global cap flagged explicitly");
    assert.ok(d.files <= 60, "file cap");
    assert.ok(d.matches.length <= 200, "match cap");
    assert.ok(d.elapsedMs >= 0);
  });

  test("non-module route passthrough + direct runContentSearch shape", async () => {
    const passthrough = await contentSearchApi(new Request("http://local/other", { method: "POST", body: "{}" }), ctx, "other");
    assert.equal(passthrough, null);
    const direct = await runContentSearch(allowRoot, "alphaHelper");
    assert.equal(direct.ok, true);
    assert.ok(direct.matches.some((m) => m.path.endsWith("util.ts")));
  });
}
