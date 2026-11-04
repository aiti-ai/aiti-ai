/**
 * Mission 接线：把 plan-sandbox 生命周期写入 pi-subagents 的 mission 台账。
 *
 * 耦合说明：pi-subagents 未导出 mission API，这里直接落其 store 格式
 * （schemaVersion 1，字段形状对齐 src/missions/types.ts）。格式漂移时本模块
 * 全程静默降级（try/catch），PI_PLAN_SANDBOX_MISSIONS=0 可整体关闭。
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function enabled(): boolean {
	return process.env.PI_PLAN_SANDBOX_MISSIONS !== "0";
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function missionDirs(projectDir: string): { missionDir: string; globalIndexDir: string; projectRoot: string } {
	const projectRoot = path.resolve(projectDir);
	const key = createHash("sha256").update(projectRoot).digest("hex");
	return {
		missionDir: path.join(agentDir(), "missions", "projects", key),
		globalIndexDir: path.join(agentDir(), "missions", "index"),
		projectRoot,
	};
}

function recordPath(missionDir: string, id: string): string {
	return path.join(missionDir, `${id}.json`);
}

function indexPath(globalIndexDir: string, projectRoot: string, id: string): string {
	const key = createHash("sha256").update(`${projectRoot}\0${id}`).digest("hex");
	return path.join(globalIndexDir, `${key}.json`);
}

function privateWrite(p: string, obj: unknown): void {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const tmp = `${p}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, p);
}

function writeRecordAndIndex(
	missionDir: string,
	globalIndexDir: string,
	projectRoot: string,
	record: Record<string, unknown>,
): void {
	privateWrite(recordPath(missionDir, String(record.id)), record);
	const lastRun = (record.runs as any[] | undefined)?.at(-1) as any;
	privateWrite(indexPath(globalIndexDir, projectRoot, String(record.id)), {
		schemaVersion: 1,
		missionId: record.id,
		projectRoot,
		recordPath: recordPath(missionDir, String(record.id)),
		title: record.title,
		status: record.status,
		updatedAt: record.updatedAt,
		...(lastRun?.runId ? { lastRunId: lastRun.runId } : {}),
	});
}

function loadRecord(missionDir: string, id: string): Record<string, any> | null {
	try {
		return JSON.parse(fs.readFileSync(recordPath(missionDir, id), "utf8"));
	} catch {
		return null;
	}
}

function sandboxMissionId(sandboxDir: string): string | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(sandboxDir, "mission.json"), "utf8")).id ?? null;
	} catch {
		return null;
	}
}

/** plan 开始：建 mission（planned）。返回 missionId（失败/禁用返回 null）。
 *  ownerSessionId（P1-1 尾巴，lineage-closure）：透传真实 pi 会话 id——mission 归因
 *  从字面量 "plan-sandbox" 升级为可回链会话；缺省（直连/自动化场景）维持字面量。 */
export function missionStart(projectDir: string, tier: string, ownerSessionId?: string | null): string | null {
	if (!enabled()) return null;
	try {
		const { missionDir, globalIndexDir, projectRoot } = missionDirs(projectDir);
		const now = new Date().toISOString();
		const id = randomUUID();
		const record = {
			schemaVersion: 1 as const,
			id,
			title: `Plan-Sandbox: ${path.basename(projectRoot)} (${tier})`,
			objective: `Plan-Sandbox 快照规划会话（项目 ${projectRoot}，tier=${tier}）。交付物采认后本 mission 关闭。`,
			status: "planned",
			createdAt: now,
			updatedAt: now,
			runs: [],
			workflowChildren: [],
			decisions: [],
			artifacts: [],
			receipts: [],
			cwd: projectRoot,
			ownerSessionId: ownerSessionId?.trim() || "plan-sandbox",
			labels: ["plan-sandbox"],
		};
		writeRecordAndIndex(missionDir, globalIndexDir, projectRoot, record);
		return id;
	} catch {
		return null;
	}
}

/** declare：加 open decision（门控 needs_decision）+ manifest 工件 */
export function missionDeclare(sandboxDir: string, projectDir: string, manifest: { summary: string; gate?: string; files: string[]; deletions: string[] }): void {
	if (!enabled()) return;
	try {
		const id = sandboxMissionId(sandboxDir);
		if (!id) return;
		const { missionDir, globalIndexDir, projectRoot } = missionDirs(projectDir);
		const record = loadRecord(missionDir, id);
		if (!record) return;
		const now = new Date().toISOString();
		record.decisions.push({
			id: randomUUID(),
			status: "open",
			title: "采认 plan 交付物",
			prompt: manifest.summary || "采认声明的交付物到真实工作区",
			createdAt: now,
		});
		record.artifacts.push({
			kind: "manifest",
			path: path.join(sandboxDir, "review.json"),
			description: `plan-sandbox 采认契约（${manifest.files.length} files / ${manifest.deletions.length} deletions）`,
		});
		record.status = "needs_decision";
		record.summary = manifest.summary || record.summary;
		record.updatedAt = now;
		writeRecordAndIndex(missionDir, globalIndexDir, projectRoot, record);
	} catch {}
}

/** 采认/丢弃/回滚收尾：resolve decision + 终态 */
export function missionResolve(sandboxDir: string, projectDir: string, outcome: "accepted" | "discarded" | "rolledback", detail?: string): void {
	if (!enabled()) return;
	try {
		const id = sandboxMissionId(sandboxDir);
		if (!id) return;
		const { missionDir, globalIndexDir, projectRoot } = missionDirs(projectDir);
		const record = loadRecord(missionDir, id);
		if (!record) return;
		const now = new Date().toISOString();
		for (const d of record.decisions ?? []) {
			if (d.status === "open") {
				d.status = "resolved";
				d.resolvedAt = now;
				d.resolution = outcome === "accepted" ? "用户采认交付物" : outcome === "rolledback" ? `门禁失败整单回滚${detail ? "：" + detail : ""}` : "用户丢弃全部内容";
			}
		}
		record.artifacts.push({ kind: "output", path: projectDir, description: `采认落盘（${outcome}）` });
		record.status = outcome === "accepted" ? "completed" : "cancelled";
		record.summary = `${record.summary ? record.summary + " — " : ""}${outcome}`;
		record.updatedAt = now;
		writeRecordAndIndex(missionDir, globalIndexDir, projectRoot, record);
	} catch {}
}

/** 供持久化：把 missionId 写进沙箱目录 */
export function persistMissionId(sandboxDir: string, missionId: string | null): void {
	if (!missionId) return;
	try {
		fs.writeFileSync(path.join(sandboxDir, "mission.json"), JSON.stringify({ id: missionId }, null, 2));
	} catch {}
}
