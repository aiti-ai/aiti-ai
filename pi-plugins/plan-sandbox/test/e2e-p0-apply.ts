/**
 * P0-3 采认终态持久 E2E（docs/aiti-lineage-closure-plan.md GAP-4）：
 * start → 产出 → writeReview + mission 台账 → applyReviewSelection →
 *   ✓ 沙箱销毁后 mission 记录结算可查（durable answer）
 *   ✓ 采认/丢弃两种终态的 mission 状态归位
 *
 * 运行：PI_CODING_AGENT_DIR 指向临时目录（mission 台账隔离），node --experimental-strip-types
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LinuxProvider } from "../providers.ts";
import { computeBaseHashes } from "../accept-core.ts";
import { applyReviewSelection, persistMeta, writeReview } from "../resume.ts";
import { missionStart, missionDeclare, persistMissionId } from "../mission.ts";

function expect(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`P0-3 E2E FAIL: ${msg}`);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "psb-p0-3-"));
const agentDir = path.join(base, "agent");
fs.mkdirSync(path.join(agentDir, "missions"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir; // mission 台账隔离（missionDirs 运行时读取）
process.env.PI_PLAN_SANDBOX_MISSIONS = "1";

const proj = path.join(base, "proj");
fs.mkdirSync(proj, { recursive: true });
const projReal = fs.realpathSync(proj);
fs.writeFileSync(path.join(proj, "a.txt"), "hello\n");

/** 在 mission 台账目录里递归找 id 对应的记录 */
function findMissionRecord(id: string): any {
	const root = path.join(agentDir, "missions");
	const walk = (dir: string): any | null => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) {
				const hit = walk(p);
				if (hit) return hit;
			} else if (e.name === `${id}.json`) {
				try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
			}
		}
		return null;
	};
	return walk(root);
}

/** 造一个 pending 沙箱（keep.txt 产出 + review + mission 声明） */
async function makePendingSandbox(name: string): Promise<{ sandboxDir: string; provider: LinuxProvider }> {
	const p = new LinuxProvider();
	const h = await p.start(projReal);
	await p.bashExec(h, `echo 'delivered-${name}' > keep.txt`, proj, { timeoutSec: 60 });
	const delta = await p.delta(h);
	const manifest = {
		files: ["keep.txt"], deletions: [], summary: `P0-3 ${name}`, ts: Date.now(),
		baseHashes: computeBaseHashes(projReal, ["keep.txt"]), baseTs: Date.now(),
	};
	persistMeta(h, p);
	// applyReviewSelection 读 manifest 取基线指纹（生产链路经 findResumable 必有 manifest）
	fs.writeFileSync(path.join(h.sandboxDir, "manifest.json"), JSON.stringify(manifest));
	writeReview(h, p, manifest, delta);
	const id = missionStart(projReal, h.tier);
	persistMissionId(h.sandboxDir, id);
	missionDeclare(h.sandboxDir, projReal, manifest);
	return { sandboxDir: h.sandboxDir, provider: p };
}

// ── 场景 1：采认（keep.txt）→ mission completed + decisions resolved ──
{
	const { sandboxDir } = await makePendingSandbox("accept");
	const out = await applyReviewSelection(projReal, sandboxDir, ["keep.txt"], []);
	expect(out.includes("采认完成"), `apply output: ${out}`);
	expect(fs.readFileSync(path.join(projReal, "keep.txt"), "utf8").includes("delivered-accept"), "keep.txt landed");
	expect(!fs.existsSync(sandboxDir), "sandbox destroyed");
	const rec = findMissionRecord("m-"); // missionStart 生成的 id 非固定，改由目录扫描
	void rec;
}

// mission id 由 missionStart 随机生成——按 projectDir 分组目录扫最新记录校验
function latestRecord(): any {
	const root = path.join(agentDir, "missions", "projects");
	const all: any[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".json")) {
				try { all.push(JSON.parse(fs.readFileSync(p, "utf8"))); } catch { /* noop */ }
			}
		}
	};
	walk(root);
	return all.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))).at(-1);
}

{
	const rec = latestRecord();
	expect(!!rec, "mission 记录存在");
	expect(rec.status === "completed", `mission status: ${rec.status}`);
	expect((rec.decisions ?? []).some((d: any) => d.status === "resolved" && /采认/.test(d.resolution ?? "")), "decision resolved（采认）");
}

// ── 场景 2：空选择 → discarded → mission cancelled ──
{
	const { sandboxDir } = await makePendingSandbox("discard");
	const out = await applyReviewSelection(projReal, sandboxDir, [], []);
	expect(out.includes("未采认任何内容"), `empty output: ${out}`);
	expect(!fs.existsSync(sandboxDir), "sandbox destroyed");
	const rec = latestRecord();
	expect(rec.status === "cancelled", `mission status: ${rec.status}`);
	expect((rec.decisions ?? []).some((d: any) => d.status === "resolved" && /丢弃/.test(d.resolution ?? "")), "decision resolved（丢弃）");
}

fs.rmSync(base, { recursive: true, force: true });
console.log("P0-3 APPLY-E2E PASS ✓");
