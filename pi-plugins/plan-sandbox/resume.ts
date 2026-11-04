/**
 * 跨会话 resume：保留沙箱的 meta/manifest 落盘与重建采认。
 * 从 index.ts 抽出以便独立测试。
 *
 * 采认统一走 accept-core（基线指纹分流：漂移落 sidecar 不覆盖）；trace 记账经
 * `__aitiTracePlanRecord` 三钩子（pi-git-trace，begin/end/note——缺席判空降级，
 * 绝不阻断采认主流程）。旧 `__aitiTraceAppendPlanRecord` 已删除（未上线无兼容包袱）。
 */
import fs from "node:fs";
import path from "node:path";
import { LocalView, MergedView } from "./fsview.ts";
import { rmRfSafe, sandboxBaseDir, createProvider, type SandboxHandle, type SandboxProvider } from "./providers.ts";
import { manifestIssues, type DeliverableManifest } from "./protocol.ts";
import { acceptWithSplit, conflictLines, handleViewRoot, stalenessHint, type DriftConflict } from "./accept-core.ts";

export interface PersistedMeta {
	provider: string;
	tier: string;
	projectDir: string;
	sandboxDir: string;
	createdAt: number;
}

export interface Resumable {
	sandboxDir: string;
	meta: PersistedMeta;
	manifest: DeliverableManifest;
}

export function persistMeta(h: SandboxHandle, provider: SandboxProvider): void {
	try {
		fs.mkdirSync(h.sandboxDir, { recursive: true });
		fs.writeFileSync(
			path.join(h.sandboxDir, "meta.json"),
			JSON.stringify({ provider: provider.name, tier: h.tier, projectDir: h.projectDir, sandboxDir: h.sandboxDir, createdAt: h.createdAt }, null, 2),
		);
	} catch {}
}

export function persistManifest(h: SandboxHandle, m: DeliverableManifest): void {
	try {
		fs.writeFileSync(path.join(h.sandboxDir, "manifest.json"), JSON.stringify(m, null, 2));
	} catch {}
}

/** 扫描保留沙箱：属于 projectDir 且带 manifest 的最新一个 */
export function findResumable(projectDir: string): Resumable | null {
	const base = sandboxBaseDir();
	let best: Resumable | null = null;
	try {
		for (const d of fs.readdirSync(base)) {
			const dir = path.join(base, d);
			let meta: PersistedMeta;
			let manifest: DeliverableManifest;
			try {
				meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
				manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
			} catch {
				continue;
			}
			if (meta.projectDir !== projectDir) continue;
			const cand: Resumable = { sandboxDir: dir, meta, manifest };
			if (!best || ((manifest.ts ?? 0) > (best.manifest.ts ?? 0))) best = cand;
		}
	} catch {}
	return best;
}

/** 从落盘 meta 重建句柄（仅采认/销毁所需字段） */
export function reconstructHandle(meta: PersistedMeta): SandboxHandle | null {
	try {
		const expected = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "macos" : "win32";
		if (meta.provider !== expected) return null;
		if (meta.tier === "overlay" || meta.tier === "overlay-noro") {
			const upper = path.join(meta.sandboxDir, "upper");
			if (!fs.existsSync(upper)) return null;
			return {
				id: path.basename(meta.sandboxDir),
				tier: meta.tier,
				projectDir: meta.projectDir,
				sandboxDir: meta.sandboxDir,
				view: new MergedView(meta.projectDir, upper),
				createdAt: meta.createdAt ?? 0,
				extra: { tmpDir: "/tmp", pids: [] },
			};
		}
		const snapshotDir = path.join(meta.sandboxDir, "snapshot");
		if (!fs.existsSync(snapshotDir)) return null;
		return {
			id: path.basename(meta.sandboxDir),
			tier: meta.tier,
			projectDir: meta.projectDir,
			sandboxDir: meta.sandboxDir,
			view: new LocalView(snapshotDir),
			createdAt: meta.createdAt ?? 0,
			extra: { snapshotDir, tmpDir: osTmp(), pids: [] },
		};
	} catch {
		return null;
	}
}

function osTmp(): string {
	return process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
}

// ---------------- trace 记账钩子（pi-git-trace；缺席判空降级） ----------------

type TraceApi = {
	begin?: (meta: { projectDir: string; sandboxDir: string; summary: string; files: string[]; deletions: string[] }) => Promise<string | null>;
	end?: (recordId: string | null, info: { outcome: "accepted" | "rolledback"; projectDir: string; sandboxDir: string; summary: string; files: string[]; deletions: string[]; conflicts: string[]; mission?: string | null }) => Promise<void>;
	note?: (info: { outcome: "discarded"; projectDir: string; sandboxDir: string; summary: string }) => Promise<void>;
};

export function traceApi(): TraceApi | null {
	return ((globalThis as any).__aitiTracePlanRecord as TraceApi) ?? null;
}

/** 沙箱 mission id（mission.json；缺省 null——仅作 trace 归因，读取失败不影响主流程） */
function missionIdOf(sandboxDir: string): string | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(sandboxDir, "mission.json"), "utf8")).id ?? null;
	} catch {
		return null;
	}
}

/** 统一收尾文本：采认/回滚主行 + 冲突清单 + 陈旧度提示（三条 CLI 路径共用措辞） */
function resultLines(opts: { headline: string; gate?: string; gateResult?: { output: string } | null; report: { copied: string[]; deleted: string[]; failed: { path: string; error: string }[] }; conflicts: DriftConflict[]; baseTs?: number }): string[] {
	const lines: string[] = [opts.headline];
	if (opts.gateResult?.output) lines.push("门禁输出（尾部）：", opts.gateResult.output.split("\n").slice(-15).join("\n"));
	else if (opts.gate) lines.push(`门禁通过：${opts.gate}`);
	lines.push(...conflictLines(opts.conflicts));
	const stale = stalenessHint(opts.baseTs);
	if (stale) lines.push(stale);
	if (opts.report.failed.length > 0) lines.push(`失败 ${opts.report.failed.length} 项：`, ...opts.report.failed.slice(0, 10).map((f) => `  ${f.path}: ${f.error}`));
	return lines;
}

/** 跨会话采认：重建→重校验（含 baseHashes 缺失拒绝）→分流采认→destroy。返回用户可见的结果文本。 */
export async function acceptResumed(projectDir: string): Promise<string> {
	const res = findResumable(projectDir);
	if (!res) return "没有待采认的交付物。";
	const h = reconstructHandle(res.meta);
	if (!h) return `保留沙箱无法重建（平台不匹配或目录损坏）：${res.sandboxDir}`;
	const provider = createProvider();
	const d = await provider.delta(h);
	const issues = manifestIssues(d, res.manifest, projectDir);
	if (issues.length > 0) {
		return `保留的交付物与当前快照不符：\n- ${issues.join("\n- ")}`;
	}
	const files = res.manifest.files;
	const deletions = res.manifest.deletions;
	const trace = traceApi();
	let rec: string | null = null;
	try {
		rec = (await trace?.begin?.({ projectDir, sandboxDir: h.sandboxDir, summary: res.manifest.summary, files, deletions })) ?? null;
	} catch {}
	const { report, gate: gateResult, reverted, conflicts } = await acceptWithSplit(provider, h, files, deletions, {
		gate: res.manifest.gate,
		base: { baseHashes: res.manifest.baseHashes, baseTs: res.manifest.baseTs },
		viewRoot: handleViewRoot(h),
	});
	try {
		const { missionResolve } = await import("./mission.ts");
		missionResolve(h.sandboxDir, h.projectDir, reverted ? "rolledback" : "accepted");
	} catch {}
	try {
		await trace?.end?.(rec, {
			outcome: reverted ? "rolledback" : "accepted",
			projectDir, sandboxDir: h.sandboxDir, summary: res.manifest.summary, files, deletions,
			conflicts: conflicts.map((c) => c.rel),
			mission: missionIdOf(h.sandboxDir),
		});
	} catch {}
	await provider.destroy(h).catch(() => {});
	const lines = reverted
		? resultLines({ headline: `[plan-sandbox] 跨会话采认：门禁未通过，已整单回滚，沙箱已销毁。`, gateResult, report, conflicts, baseTs: res.manifest.baseTs })
		: resultLines({
				headline: `[plan-sandbox] 跨会话采认完成：${report.copied.length} 文件写入，${report.deleted.length} 删除，沙箱已销毁。`,
				gate: res.manifest.gate, gateResult: null, report, conflicts, baseTs: res.manifest.baseTs,
			});
	return lines.join("\n");
}

/** 跨会话丢弃 */
export async function discardResumed(projectDir: string): Promise<string> {
	const res = findResumable(projectDir);
	if (!res) return "没有保留的沙箱。";
	try {
		await traceApi()?.note?.({ outcome: "discarded", projectDir, sandboxDir: res.sandboxDir, summary: "丢弃保留沙箱" });
	} catch {}
	await rmRfSafe(res.sandboxDir);
	return `已丢弃保留的沙箱：${res.sandboxDir}`;
}

// ---------------- Review 契约（plan 结束后的收尾：声明 vs 其他） ----------------

export interface ReviewPayload {
	projectDir: string;
	sandboxDir: string;
	tier: string;
	provider: string;
	status: "pending" | "accepted" | "discarded";
	delta: { added: string[]; modified: string[]; deleted: string[] };
	declared: { files: string[]; deletions: string[] };
	summary: string;
	gate?: string;
	notes?: string;
	updatedAt: number;
}

/** 声明之外、沙箱自动检测出的增量（"其他"）——不自动选中，留给用户点选 */
export function othersOf(delta: { added: string[]; modified: string[]; deleted: string[] }, m: DeliverableManifest): { added: string[]; modified: string[]; deleted: string[] } {
	const dec = new Set([...m.files, ...m.deletions]);
	const f = (a: string[]) => a.filter((x) => !dec.has(x));
	return { added: f(delta.added), modified: f(delta.modified), deleted: f(delta.deleted) };
}

/** 生成/刷新 review.json（declare-keep 与 shutdown-保留时调用；沙箱冻结后 delta 即最终态） */
export function writeReview(h: SandboxHandle, provider: SandboxProvider, m: DeliverableManifest, delta: { added: string[]; modified: string[]; deleted: string[] }): void {
	try {
		const payload: ReviewPayload = {
			projectDir: h.projectDir,
			sandboxDir: h.sandboxDir,
			tier: h.tier,
			provider: provider.name,
			status: "pending",
			delta,
			declared: { files: m.files, deletions: m.deletions },
			summary: m.summary,
			gate: m.gate,
			notes: m.notes,
			updatedAt: Date.now(),
		};
		fs.writeFileSync(path.join(h.sandboxDir, "review.json"), JSON.stringify(payload, null, 2));
	} catch {}
}

/** 按用户点选的选择集采认（选择 ⊆ 快照增量；gate 来自 review，基线指纹来自 manifest） */
export async function applyReviewSelection(projectDir: string, sandboxDir: string, selFiles: string[], selDeletions: string[]): Promise<string> {
	const metaPath = path.join(sandboxDir, "meta.json");
	const reviewPath = path.join(sandboxDir, "review.json");
	const manifestPath = path.join(sandboxDir, "manifest.json");
	let meta: PersistedMeta;
	let review: ReviewPayload;
	let manifest: DeliverableManifest | null;
	try {
		meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
		review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
		manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	} catch (e: any) {
		return `读取保留沙箱失败：${e?.message || e}`;
	}
	if (!manifest?.baseHashes || typeof manifest.baseHashes !== "object") {
		return "保留沙箱缺少基线指纹（manifest.baseHashes），无法安全比对工作区漂移，已拒绝采认。";
	}
	const h = reconstructHandle(meta);
	if (!h) return "保留沙箱无法重建（平台不匹配或目录损坏）。";
	const provider = createProvider();
	// 选择集 ⊆ 快照增量
	const all = new Set([...review.delta.added, ...review.delta.modified]);
	const del = new Set(review.delta.deleted);
	const bad: string[] = [];
	for (const f of selFiles) if (!all.has(f)) bad.push(f);
	for (const f of selDeletions) if (!del.has(f)) bad.push(f);
	if (bad.length > 0) return `选择集与快照增量不符：${bad.join(", ")}`;
	if (selFiles.length === 0 && selDeletions.length === 0) {
		// [P0-3] 终态先落盘再销毁（原顺序 markStatus 写在 destroy 后 → review.json 已删，死代码）
		markStatus(sandboxDir, "discarded");
		try {
			await traceApi()?.note?.({ outcome: "discarded", projectDir, sandboxDir, summary: "选择为空" });
		} catch {}
		try {
			const { missionResolve } = await import("./mission.ts");
			missionResolve(sandboxDir, h.projectDir, "discarded");
		} catch {}
		await provider.destroy(h).catch(() => {});
		return "选择为空：未采认任何内容，沙箱已销毁。";
	}
	const trace = traceApi();
	let rec: string | null = null;
	try {
		rec = (await trace?.begin?.({ projectDir, sandboxDir, summary: review.summary, files: selFiles, deletions: selDeletions })) ?? null;
	} catch {}
	const { report, gate: gateResult, reverted, conflicts } = await acceptWithSplit(provider, h, selFiles, selDeletions, {
		gate: review.gate,
		base: { baseHashes: manifest.baseHashes, baseTs: manifest.baseTs },
		viewRoot: handleViewRoot(h),
	});
	// [P0-3] 终态先落盘再销毁；并补 missionResolve（采认路径此前不结算 mission）
	markStatus(sandboxDir, reverted ? "discarded" : "accepted");
	try {
		const { missionResolve } = await import("./mission.ts");
		missionResolve(sandboxDir, h.projectDir, reverted ? "rolledback" : "accepted");
	} catch {}
	try {
		await trace?.end?.(rec, {
			outcome: reverted ? "rolledback" : "accepted",
			projectDir, sandboxDir, summary: review.summary, files: selFiles, deletions: selDeletions,
			conflicts: conflicts.map((c) => c.rel),
			mission: missionIdOf(sandboxDir),
		});
	} catch {}
	await provider.destroy(h).catch(() => {});
	const lines = reverted
		? resultLines({ headline: `[plan-sandbox] 门禁未通过，已整单回滚，沙箱已销毁。`, gateResult, report, conflicts, baseTs: manifest.baseTs })
		: resultLines({
				headline: `[plan-sandbox] 采认完成：${report.copied.length} 文件写入，${report.deleted.length} 删除，沙箱已销毁。`,
				gate: review.gate, gateResult: null, report, conflicts, baseTs: manifest.baseTs,
			});
	return lines.join("\n");
}

function markStatus(sandboxDir: string, status: "accepted" | "discarded"): void {
	try {
		const p = path.join(sandboxDir, "review.json");
		const r = JSON.parse(fs.readFileSync(p, "utf8"));
		r.status = status;
		r.updatedAt = Date.now();
		fs.writeFileSync(p, JSON.stringify(r, null, 2));
	} catch {}
}
