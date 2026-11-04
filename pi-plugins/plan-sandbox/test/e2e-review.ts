/**
 * Review 契约 E2E：声明 + 未声明"其他" → review.json → 选择性采认
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LinuxProvider } from "../providers.ts";
import { computeBaseHashes } from "../accept-core.ts";
import { findResumable, othersOf, applyReviewSelection, reconstructHandle } from "../resume.ts";

function expect(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`REVIEW-E2E FAIL: ${msg}`);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "psb-review-"));
fs.mkdirSync(path.join(base, "proj"), { recursive: true });
const proj = fs.realpathSync(path.join(base, "proj"));
fs.writeFileSync(path.join(proj, "a.txt"), "hello\n");
fs.mkdirSync(path.join(proj, "logdir"), { recursive: true });
fs.writeFileSync(path.join(proj, "logdir", "old.log"), "old");

// 计划会话：声明 keep.txt；另有未声明的 note.txt、日志删除
const p = new LinuxProvider();
const h = await p.start(proj);
await p.bashExec(h, "echo delivered > keep.txt && echo 'scratch notes' > note.txt && rm -rf logdir && mkdir -p logdir", proj, { timeoutSec: 60 });
const delta = await p.delta(h);
expect(delta.added.includes("keep.txt") && delta.added.includes("note.txt"), `delta: ${JSON.stringify(delta)}`);

// 声明只含 keep.txt；落盘 meta/manifest/review（基线指纹在声明时冻结）
const manifest = {
	files: ["keep.txt"], deletions: [], summary: "只交付 keep", gate: "test -f keep.txt", ts: Date.now(),
	baseHashes: computeBaseHashes(proj, ["keep.txt", ...delta.added, ...delta.modified, ...delta.deleted]),
	baseTs: Date.now(),
};
fs.writeFileSync(path.join(h.sandboxDir, "meta.json"), JSON.stringify({ provider: "linux", tier: h.tier, projectDir: proj, sandboxDir: h.sandboxDir, createdAt: h.createdAt }));
fs.writeFileSync(path.join(h.sandboxDir, "manifest.json"), JSON.stringify(manifest));
const { writeReview } = await import("../resume.ts");
writeReview(h, p, manifest, delta);

// review.json 契约校验
const review = JSON.parse(fs.readFileSync(path.join(h.sandboxDir, "review.json"), "utf8"));
expect(review.status === "pending", "status pending");
expect(review.declared.files.includes("keep.txt"), "declared in review");
const others = othersOf(review.delta, manifest);
expect(others.added.includes("note.txt"), `others.added: ${JSON.stringify(others)}`);
expect(others.deleted.includes("logdir/old.log"), `others.deleted(dir): ${JSON.stringify(others)}`);
expect(!others.added.includes("keep.txt"), "declared not in others");

// 用户点选：声明 keep.txt + 回收一个"其他" note.txt（logdir 不回收）
const out = await applyReviewSelection(proj, h.sandboxDir, ["keep.txt", "note.txt"], []);
expect(out.includes("2 文件写入"), `apply output: ${out}`);
expect(fs.readFileSync(path.join(proj, "keep.txt"), "utf8").includes("delivered"), "declared landed");
expect(fs.readFileSync(path.join(proj, "note.txt"), "utf8").includes("scratch"), "other recovered by user pick");
expect(fs.readFileSync(path.join(proj, "logdir", "old.log"), "utf8") === "old", "unpicked other: host untouched (保持原状)");
expect(!fs.existsSync(path.join(h.sandboxDir, "review.json")), "review entry destroyed with sandbox (no longer pending)");
expect(findResumable(proj) === null, "resumable cleared");

// 空选择 → 全销毁
const h2 = await p.start(proj);
await p.bashExec(h2, "echo junk > junk.txt", proj, { timeoutSec: 60 });
fs.writeFileSync(path.join(h2.sandboxDir, "meta.json"), JSON.stringify({ provider: "linux", tier: h2.tier, projectDir: proj, sandboxDir: h2.sandboxDir, createdAt: h2.createdAt }));
fs.writeFileSync(path.join(h2.sandboxDir, "manifest.json"), JSON.stringify({ files: [], deletions: [], summary: "", ts: Date.now(), baseHashes: {}, baseTs: Date.now() }));
writeReview(h2, p, { files: [], deletions: [], summary: "", ts: Date.now(), baseHashes: {}, baseTs: Date.now() }, await p.delta(h2));
const out2 = await applyReviewSelection(proj, h2.sandboxDir, [], []);
expect(out2.includes("选择为空"), `empty select: ${out2}`);
expect(!fs.existsSync(path.join(proj, "junk.txt")), "junk destroyed");

// 非法选择集被拒
const h3 = await p.start(proj);
await p.bashExec(h3, "echo ok > ok.txt", proj, { timeoutSec: 60 });
fs.writeFileSync(path.join(h3.sandboxDir, "meta.json"), JSON.stringify({ provider: "linux", tier: h3.tier, projectDir: proj, sandboxDir: h3.sandboxDir, createdAt: h3.createdAt }));
fs.writeFileSync(path.join(h3.sandboxDir, "manifest.json"), JSON.stringify({ files: [], deletions: [], summary: "", ts: Date.now(), baseHashes: {}, baseTs: Date.now() }));
writeReview(h3, p, { files: [], deletions: [], summary: "", ts: Date.now(), baseHashes: {}, baseTs: Date.now() }, await p.delta(h3));
const out3 = await applyReviewSelection(proj, h3.sandboxDir, ["not-in-delta.txt"], []);
expect(out3.includes("不符"), `invalid selection rejected: ${out3}`);
await p.destroy(h3);

// 目录删除 + 门禁失败回滚（dir-aware stash）交叉验证放在 gate e2e，这里验证 review 通路即可
fs.rmSync(base, { recursive: true, force: true });
console.log("REVIEW-E2E PASS ✓");
