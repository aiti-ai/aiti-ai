/**
 * 采认编排 E2E（accept-core，自 gate.ts 演进）：门禁通过 / 失败回滚 / 拷贝失败跳过门禁 /
 * 漂移分流（sidecar 落盘不覆盖，绝不静默丢新版）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LinuxProvider } from "../providers.ts";
import { acceptWithSplit, computeBaseHashes, handleViewRoot } from "../accept-core.ts";

function expect(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`GATE-E2E FAIL: ${msg}`);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "psb-gate-"));
const proj = path.join(base, "proj");
fs.mkdirSync(proj, { recursive: true });
const projReal = fs.realpathSync(proj);
fs.writeFileSync(path.join(proj, "a.txt"), "original\n");
fs.writeFileSync(path.join(proj, "del.txt"), "to delete\n");
const p = new LinuxProvider();

// ---- 场景 1：门禁通过 → 交付落盘 ----
{
	const h = await p.start(projReal);
	await p.bashExec(h, "echo delivered > keep.txt && rm del.txt", proj, { timeoutSec: 60 });
	const bh = computeBaseHashes(projReal, ["keep.txt", "del.txt"]);
	const { report, gate, reverted, conflicts } = await acceptWithSplit(p, h, ["keep.txt"], ["del.txt"], {
		gate: "test -f keep.txt && grep -q delivered keep.txt",
		base: { baseHashes: bh, baseTs: Date.now() },
		viewRoot: handleViewRoot(h),
	});
	expect(reverted === false, "s1 not reverted");
	expect(gate?.passed === true, `s1 gate passed: ${JSON.stringify(gate)}`);
	expect(conflicts.length === 0, `s1 no conflicts: ${JSON.stringify(conflicts)}`);
	expect(report.failed.length === 0, `s1 no failures: ${JSON.stringify(report.failed)}`);
	expect(fs.readFileSync(path.join(proj, "keep.txt"), "utf8").includes("delivered"), "s1 keep.txt landed");
	expect(!fs.existsSync(path.join(proj, "del.txt")), "s1 del.txt deleted");
	await p.destroy(h);
	console.log("s1 gate-pass ✓");
}

// ---- 场景 2：门禁失败 → 整单回滚（新增被删、修改还原、删除还原） ----
{
	fs.writeFileSync(path.join(proj, "del.txt"), "to delete\n"); // 场景1已删，重建夹具
	const h = await p.start(projReal);
	await p.bashExec(h, "echo changed >> a.txt && echo brandnew > brand.txt && rm del.txt", proj, { timeoutSec: 60 });
	const bh = computeBaseHashes(projReal, ["a.txt", "brand.txt", "del.txt"]);
	const { report, gate, reverted } = await acceptWithSplit(p, h, ["a.txt", "brand.txt"], ["del.txt"], {
		gate: "exit 3",
		base: { baseHashes: bh, baseTs: Date.now() },
		viewRoot: handleViewRoot(h),
	});
	expect(reverted === true, "s2 reverted");
	expect(gate?.passed === false, "s2 gate failed");
	// 回滚验证
	expect(fs.readFileSync(path.join(proj, "a.txt"), "utf8") === "original\n", "s2 a.txt restored");
	expect(!fs.existsSync(path.join(proj, "brand.txt")), "s2 brand.txt removed");
	expect(fs.readFileSync(path.join(proj, "del.txt"), "utf8") === "to delete\n", "s2 del.txt restored");
	expect(report.failed.length === 0, `s2 no rollback errors: ${JSON.stringify(report.failed)}`);
	await p.destroy(h);
	console.log("s2 gate-fail-rollback ✓");
}

// ---- 场景 3：无门禁 → 不回滚 ----
{
	const h = await p.start(projReal);
	await p.bashExec(h, "echo v2 > a.txt", proj, { timeoutSec: 60 });
	const bh = computeBaseHashes(projReal, ["a.txt"]);
	const { reverted, gate } = await acceptWithSplit(p, h, ["a.txt"], [], {
		base: { baseHashes: bh, baseTs: Date.now() },
		viewRoot: handleViewRoot(h),
	});
	expect(reverted === false && gate === undefined, "s3 no gate");
	expect(fs.readFileSync(path.join(proj, "a.txt"), "utf8").includes("v2"), "s3 landed");
	await p.destroy(h);
	console.log("s3 no-gate ✓");
}

// ---- 场景 4：拷贝失败（声明了不存在的文件）→ 跳过门禁直接回滚 ----
{
	const h = await p.start(projReal);
	await p.bashExec(h, "echo changed >> a.txt", proj, { timeoutSec: 60 });
	const bh = computeBaseHashes(projReal, ["a.txt", "ghost.txt"]);
	const { report, gate, reverted } = await acceptWithSplit(p, h, ["a.txt", "ghost.txt"], [], {
		gate: "echo SHOULD-NOT-RUN",
		base: { baseHashes: bh, baseTs: Date.now() },
		viewRoot: handleViewRoot(h),
	});
	expect(reverted === true, "s4 reverted on copy failure");
	expect(gate === undefined, "s4 gate skipped");
	expect(report.failed.some((f) => f.path === "ghost.txt"), "s4 ghost reported");
	// 注意：此场景 a.txt 此前已是 v2（场景3已采认），本轮修改被回滚 → 应仍为 v2
	expect(!fs.readFileSync(path.join(proj, "a.txt"), "utf8").endsWith("changed"), "s4 a.txt rolled back");
	await p.destroy(h);
	console.log("s4 copy-fail-rollback ✓");
}

// ---- 场景 5：漂移分流（陈旧恢复核心）：封存后工作区被改动 → 不覆盖 + sidecar 保住沙箱版 ----
{
	const h = await p.start(projReal);
	await p.bashExec(h, "echo sandbox-version > a.txt && echo newfile > nf.txt", proj, { timeoutSec: 60 });
	// 基线 = 声明/封存时刻的工作区（a.txt=v2、nf.txt 不存在）——沙箱内改动不进基线
	const bh = computeBaseHashes(projReal, ["a.txt", "nf.txt"]);
	expect(bh["a.txt"] !== null && bh["nf.txt"] === null, `s5 baseline: ${JSON.stringify(bh)}`);
	// 封存之后、采认之前：工作区被后续改动（长期挂起恢复的实测 bug 场景）
	fs.writeFileSync(path.join(proj, "a.txt"), "workspace-changed-later\n");
	const before = fs.readFileSync(path.join(proj, "a.txt"), "utf8");
	const { report, reverted, conflicts } = await acceptWithSplit(p, h, ["a.txt", "nf.txt"], [], {
		base: { baseHashes: bh, baseTs: Date.now() - 3 * 86_400_000 },
		viewRoot: handleViewRoot(h),
	});
	expect(reverted === false, "s5 not reverted");
	expect(conflicts.length === 1 && conflicts[0].rel === "a.txt", `s5 conflict: ${JSON.stringify(conflicts)}`);
	expect(conflicts[0].kind === "drifted", `s5 kind: ${conflicts[0].kind}`);
	expect(report.copied.join(",") === "nf.txt", `s5 only clean copied: ${JSON.stringify(report.copied)}`);
	// 工作区新版原样保留
	expect(fs.readFileSync(path.join(proj, "a.txt"), "utf8") === before, "s5 workspace version kept");
	// sidecar = 沙箱版（.planmerge-<ts>）
	const sidecar = conflicts[0].sidecar!;
	expect(!!sidecar && sidecar.startsWith("a.txt.planmerge-"), `s5 sidecar name: ${sidecar}`);
	expect(fs.readFileSync(path.join(proj, sidecar), "utf8").includes("sandbox-version"), "s5 sidecar holds sandbox version");
	await p.destroy(h);
	console.log("s5 drift-split-sidecar ✓");
}

// ---- 场景 6：appeared 分流（added 文件后来工作区也出现了同名）→ 不覆盖 ----
{
	const h = await p.start(projReal);
	await p.bashExec(h, "echo sandbox-v > appeared.txt", proj, { timeoutSec: 60 });
	const bh = computeBaseHashes(projReal, ["appeared.txt"]); // 封存时不存在 → null
	fs.writeFileSync(path.join(proj, "appeared.txt"), "workspace-v\n"); // 之后工作区自己冒出同名
	const { report, conflicts } = await acceptWithSplit(p, h, ["appeared.txt"], [], {
		base: { baseHashes: bh, baseTs: Date.now() },
		viewRoot: handleViewRoot(h),
	});
	expect(conflicts.length === 1 && conflicts[0].kind === "appeared", `s6 conflict: ${JSON.stringify(conflicts)}`);
	expect(report.copied.length === 0, `s6 nothing copied: ${JSON.stringify(report.copied)}`);
	expect(fs.readFileSync(path.join(proj, "appeared.txt"), "utf8") === "workspace-v\n", "s6 workspace kept");
	expect(fs.readFileSync(path.join(proj, conflicts[0].sidecar!), "utf8").includes("sandbox-v"), "s6 sidecar sandbox version");
	await p.destroy(h);
	console.log("s6 appeared-split ✓");
}

// ---- 场景 7：缺键 fail-safe（基线缺指纹的文件按漂移处理，绝不覆盖未知） ----
{
	const h = await p.start(projReal);
	await p.bashExec(h, "echo sandbox-v > unk.txt", proj, { timeoutSec: 60 });
	const { report, conflicts } = await acceptWithSplit(p, h, ["unk.txt"], [], {
		base: { baseHashes: {}, baseTs: Date.now() }, // 空指纹 = 全部缺键
		viewRoot: handleViewRoot(h),
	});
	expect(conflicts.length === 1 && conflicts[0].kind === "drifted", `s7 conflict: ${JSON.stringify(conflicts)}`);
	expect(report.copied.length === 0, "s7 nothing copied");
	expect(!!conflicts[0].sidecar, "s7 sidecar written");
	await p.destroy(h);
	console.log("s7 missing-key-failsafe ✓");
}

fs.rmSync(base, { recursive: true, force: true });
console.log("GATE-E2E PASS ✓");
