/**
 * Trace 钩子接线 E2E（fusion 实施档 §2.3）：模拟 pi-git-trace 在 globalThis 挂
 * __aitiTracePlanRecord，验证——
 *   ✓ 漂移采认：begin/end 配对调用（end 带 conflicts）+ 工作区保新版 + sidecar 落盘
 *   ✓ 陈旧度提示（baseTs > 24h）
 *   ✓ 缺基线指纹 → 采认拒绝（fail-loud）且不触碰钩子
 * 运行：node --experimental-strip-types test/e2e-trace.ts
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LinuxProvider } from "../providers.ts";
import { computeBaseHashes } from "../accept-core.ts";
import { acceptResumed, persistManifest, persistMeta } from "../resume.ts";

function expect(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`TRACE-E2E FAIL: ${msg}`);
}

const calls: Array<[string, unknown?]> = [];
(globalThis as any).__aitiTracePlanRecord = {
	async begin(meta: unknown) {
		calls.push(["begin", meta]);
		return "plan-test-1";
	},
	async end(id: unknown, info: unknown) {
		calls.push(["end", id, info]);
	},
	async note(info: unknown) {
		calls.push(["note", info]);
	},
};

const base = fs.mkdtempSync(path.join(os.tmpdir(), "psb-trace-"));
const proj = path.join(base, "proj");
fs.mkdirSync(proj, { recursive: true });
const projReal = fs.realpathSync(proj);
fs.writeFileSync(path.join(proj, "a.txt"), "hello\n");
const p = new LinuxProvider();

// ---- 场景 1：漂移采认 → 分流 + 钩子配对 ----
{
	const h = await p.start(projReal);
	await p.bashExec(h, "echo sandbox-v > a.txt", proj, { timeoutSec: 60 });
	const manifest = {
		files: ["a.txt"], deletions: [], summary: "改 a.txt", ts: Date.now(),
		baseHashes: computeBaseHashes(projReal, ["a.txt"]),
		baseTs: Date.now() - 3 * 86_400_000, // 3 天前封存 → 陈旧度提示
	};
	persistMeta(h, p);
	persistManifest(h, manifest as any);
	fs.writeFileSync(path.join(proj, "a.txt"), "workspace-later\n"); // 封存后工作区漂移

	const out = await acceptResumed(projReal);
	expect(out.includes("未覆盖"), `conflict text: ${out}`);
	expect(out.includes("3 天前"), `staleness hint: ${out}`);
	expect(fs.readFileSync(path.join(proj, "a.txt"), "utf8") === "workspace-later\n", "workspace kept");
	const sidecar = fs.readdirSync(proj).find((f) => f.startsWith("a.txt.planmerge-"));
	expect(!!sidecar && fs.readFileSync(path.join(proj, sidecar!), "utf8").includes("sandbox-v"), `sidecar: ${sidecar}`);
	expect(!fs.existsSync(h.sandboxDir), "sandbox destroyed");

	expect(calls.length === 2, `calls: ${JSON.stringify(calls)}`);
	expect(calls[0]![0] === "begin" && (calls[0]![1] as any).files.join(",") === "a.txt", `begin meta: ${JSON.stringify(calls[0])}`);
	expect(calls[1]![0] === "end" && calls[1]![1] === "plan-test-1", `end recordId: ${JSON.stringify(calls[1])}`);
	const info = calls[1]![2] as any;
	expect(info.outcome === "accepted" && Array.isArray(info.conflicts) && info.conflicts.join(",") === "a.txt", `end info: ${JSON.stringify(calls[1])}`);
	console.log("s1 drift accept + trace hooks ✓");
}

// ---- 场景 2：缺基线指纹 → 拒绝，钩子不被触碰 ----
{
	const before = calls.length;
	const h2 = await p.start(projReal);
	await p.bashExec(h2, "echo x > b.txt", proj, { timeoutSec: 60 });
	persistMeta(h2, p);
	persistManifest(h2, { files: ["b.txt"], deletions: [], summary: "", ts: Date.now() } as any); // 无 baseHashes
	const out = await acceptResumed(projReal);
	expect(out.includes("baseHashes"), `refusal: ${out}`);
	expect(fs.existsSync(h2.sandboxDir), "sandbox kept on refusal");
	expect(calls.length === before, `no trace calls on refusal: ${JSON.stringify(calls.slice(before))}`);
	await p.destroy(h2);
	console.log("s2 missing-fingerprint refusal ✓");
}

delete (globalThis as any).__aitiTracePlanRecord;
fs.rmSync(base, { recursive: true, force: true });
console.log("TRACE-E2E PASS ✓");
