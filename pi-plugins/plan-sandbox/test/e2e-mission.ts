/**
 * Mission 接线 E2E：PI_CODING_AGENT_DIR 隔离 → planned → needs_decision(open decision) → completed/cancelled
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { LinuxProvider } from "../providers.ts";
import { computeBaseHashes } from "../accept-core.ts";
import { missionStart, missionDeclare, missionResolve, persistMissionId } from "../mission.ts";
import { acceptResumed, persistMeta } from "../resume.ts";

function expect(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`MISSION-E2E FAIL: ${msg}`);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "psb-mission-"));
const agentDir = path.join(base, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // mission.ts 读调用时 env ✓
const proj = path.join(base, "proj");
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, "a.txt"), "hello\n");

const p = new LinuxProvider();
const h = await p.start(proj);
const missionId = missionStart(proj, h.tier);
expect(!!missionId, "missionStart returned id");
persistMissionId(h.sandboxDir, missionId);

const key = createHash("sha256").update(proj).digest("hex");
const recPath = path.join(agentDir, "missions", "projects", key, `${missionId}.json`);
expect(fs.existsSync(recPath), `record file exists: ${recPath}`);
let rec = JSON.parse(fs.readFileSync(recPath, "utf8"));
expect(rec.status === "planned", `initial status: ${rec.status}`);
expect(rec.labels.includes("plan-sandbox"), "labels");
const idxPath = path.join(agentDir, "missions", "index", `${createHash("sha256").update(`${proj}\0${missionId}`).digest("hex")}.json`);
expect(fs.existsSync(idxPath), "global index entry exists");
expect(JSON.parse(fs.readFileSync(idxPath, "utf8")).status === "planned", "index status planned");

// declare → needs_decision + open decision + artifact
const manifest = {
	files: ["delivered.txt"], deletions: [], summary: "mission e2e", gate: undefined as string | undefined, ts: Date.now(),
	baseHashes: computeBaseHashes(proj, ["delivered.txt"]), baseTs: Date.now(),
};
await p.bashExec(h, "echo delivered > delivered.txt", proj, { timeoutSec: 60 });
missionDeclare(h.sandboxDir, proj, manifest);
rec = JSON.parse(fs.readFileSync(recPath, "utf8"));
expect(rec.status === "needs_decision", `status needs_decision: ${rec.status}`);
expect(rec.decisions.length === 1 && rec.decisions[0].status === "open", "open decision");
expect(rec.artifacts.some((a: any) => a.kind === "manifest"), "manifest artifact");

// 跨会话采认（走 acceptResumed → missionResolve）
persistMeta(h, p);
fs.writeFileSync(path.join(h.sandboxDir, "manifest.json"), JSON.stringify(manifest));
fs.writeFileSync(path.join(h.sandboxDir, "review.json"), JSON.stringify({
	projectDir: proj, sandboxDir: h.sandboxDir, tier: h.tier, provider: "linux", status: "pending",
	delta: { added: ["delivered.txt"], modified: [], deleted: [] },
	declared: { files: ["delivered.txt"], deletions: [] }, summary: "mission e2e", updatedAt: Date.now(),
}));
const out = await acceptResumed(proj);
expect(out.includes("采认完成"), `acceptResumed: ${out}`);
rec = JSON.parse(fs.readFileSync(recPath, "utf8"));
expect(rec.status === "completed", `final status completed: ${rec.status}`);
expect(rec.decisions[0].status === "resolved" && rec.decisions[0].resolution.includes("采认"), "decision resolved");
expect(fs.existsSync(path.join(proj, "delivered.txt")), "delivered landed");

// discard 路径 → cancelled
const h2 = await p.start(proj);
const id2 = missionStart(proj, h2.tier);
persistMissionId(h2.sandboxDir, id2);
missionDeclare(h2.sandboxDir, proj, { files: [], deletions: [], summary: "s2", ts: Date.now() });
missionResolve(h2.sandboxDir, proj, "discarded");
rec = JSON.parse(fs.readFileSync(path.join(agentDir, "missions", "projects", key, `${id2}.json`), "utf8"));
expect(rec.status === "cancelled", `cancelled: ${rec.status}`);

// 禁用开关
process.env.PI_PLAN_SANDBOX_MISSIONS = "0";
expect(missionStart(proj, h2.tier) === null, "disabled switch");
delete process.env.PI_PLAN_SANDBOX_MISSIONS;

fs.rmSync(base, { recursive: true, force: true });
console.log("MISSION-E2E PASS ✓");
