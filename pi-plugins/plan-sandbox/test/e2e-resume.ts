/**
 * 跨会话 resume E2E：start → bash 产出 → persist → （模拟新会话）acceptResumed / discardResumed
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LinuxProvider } from "../providers.ts";
import { computeBaseHashes } from "../accept-core.ts";
import { acceptResumed, discardResumed, findResumable, persistManifest, persistMeta } from "../resume.ts";

function expect(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`RESUME-E2E FAIL: ${msg}`);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "psb-resume-"));
const proj = path.join(base, "proj");
fs.mkdirSync(proj, { recursive: true });
const projReal = fs.realpathSync(proj);
fs.writeFileSync(path.join(proj, "a.txt"), "hello\n");

// 会话 1：产出增量并落盘 manifest
const p = new LinuxProvider();
const h = await p.start(projReal);
await p.bashExec(h, "echo 'delivered' > keep.txt && echo dropped > drop.txt", proj, { timeoutSec: 60 });
const delta = await p.delta(h);
expect(delta.added.includes("keep.txt") && delta.added.includes("drop.txt"), `delta: ${JSON.stringify(delta)}`);

// 模拟用户拒绝 drop.txt：manifest 只含 keep.txt
const manifest = {
	files: ["keep.txt"], deletions: [], summary: "only keep", ts: Date.now(),
	baseHashes: computeBaseHashes(projReal, ["keep.txt"]), baseTs: Date.now(),
};
persistMeta(h, p);
persistManifest(h, manifest);
const sandboxDir = h.sandboxDir;

// 会话 2（新实例）：findResumable → acceptResumed
const res = findResumable(projReal);
expect(!!res, "resumable found");
expect(res!.manifest.files.includes("keep.txt"), "manifest persisted");
expect(fs.existsSync(path.join(res!.sandboxDir, "upper", "keep.txt")), "upper persisted");

const out = await acceptResumed(projReal);
expect(out.includes("1 文件写入"), `acceptResumed output: ${out}`);
expect(fs.readFileSync(path.join(projReal, "keep.txt"), "utf8").includes("delivered"), "keep.txt landed");
expect(!fs.existsSync(path.join(projReal, "drop.txt")), "undeclared drop.txt destroyed");
expect(!fs.existsSync(sandboxDir), "sandbox destroyed after resume accept");
expect(findResumable(projReal) === null, "no resumable left");

// discard 路径
const h2 = await p.start(projReal);
await p.bashExec(h2, "echo x > x.txt", proj, { timeoutSec: 60 });
persistMeta(h2, p);
persistManifest(h2, { files: ["x.txt"], deletions: [], summary: "", ts: Date.now(), baseHashes: computeBaseHashes(projReal, ["x.txt"]), baseTs: Date.now() });
const out2 = await discardResumed(projReal);
expect(out2.includes("已丢弃"), `discardResumed: ${out2}`);
expect(!fs.existsSync(path.join(projReal, "x.txt")), "discard landed nothing");
expect(findResumable(projReal) === null, "resumable cleared");

// 异项目隔离：别的 projectDir 看不到
fs.mkdirSync(path.join(base, "other"), { recursive: true });
const other = fs.realpathSync(path.join(base, "other"));
expect(findResumable(other) === null, "project isolation");

fs.rmSync(base, { recursive: true, force: true });
console.log("RESUME-E2E PASS ✓");
