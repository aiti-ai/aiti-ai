/**
 * [拷贝部署] 权威源：pi-ext/plan-sandbox/accept-core.ts（改动须双向同步，engine-sync.test.mjs 钉形）
 * 采认核心（三条采认路径共用的唯一实现：CLI acceptResumed / CLI 点选 / web applyOne 同步副本）。
 *
 * 职责（docs/aiti-plan-sandbox-stale-resume-trace-fusion-plan.md §2.1/§2.2）：
 * 1. 基线指纹：封存时刻逐文件 sha256（added 记 null），manifest 单一事实源；
 * 2. 恢复分流：采认前逐项比对「封存基线 vs 当前工作区」——干净才覆盖，漂移落
 *    sidecar（<rel>.planmerge-<ts>）绝不静默覆盖；
 * 3. 采认编排：干净集拷贝/删除 → 门禁（stash 收窄为门禁失败整单回滚专用）。
 * 用户主动回撤不走 stash（随沙箱销毁），走 git-trace patch（pi 宿主，钩子在调用方）。
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AcceptReport, SandboxHandle, SandboxProvider } from "./providers.ts";

// ---------------- 基线指纹 ----------------

/** 单文件 sha256（"sha256:<hex>"）；目录 = 清单+逐文件 hash 的组合摘要（Merkle 式单值）；不存在 = null */
export function hashPath(abs: string): string | null {
	let st: fs.Stats;
	try {
		st = fs.lstatSync(abs);
	} catch {
		return null;
	}
	const h = createHash("sha256");
	if (st.isDirectory()) {
		// 目录交付：相对路径 + 逐文件内容 hash 一起进摘要（判定时对当前目录同法重算比对）
		const entries: string[] = [];
		const rec = (d: string) => {
			let list: fs.Dirent[];
			try {
				list = fs.readdirSync(d, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of list) {
				const abs2 = path.join(d, e.name);
				if (e.isDirectory()) rec(abs2);
				else {
					const rel2 = path.relative(abs, abs2).split(path.sep).join("/");
					try {
						entries.push(`${rel2}:${createHash("sha256").update(fs.readFileSync(abs2)).digest("hex")}`);
					} catch {}
				}
			}
		};
		rec(abs);
		entries.sort();
		h.update(entries.join("\n"));
		return `sha256dir:${h.digest("hex")}`;
	}
	if (!st.isFile()) return null;
	try {
		h.update(fs.readFileSync(abs));
	} catch {
		return null;
	}
	return `sha256:${h.digest("hex")}`;
}

/** 封存时刻计算基线指纹：rels 里不存在的文件记 null（added 语义，检测「后来同名出现」） */
export function computeBaseHashes(projectDir: string, rels: Iterable<string>): Record<string, string | null> {
	const out: Record<string, string | null> = {};
	for (const raw of rels) {
		const rel = String(raw);
		if (!rel || rel in out) continue;
		out[rel] = hashPath(path.join(projectDir, rel));
	}
	return out;
}

// ---------------- 漂移分流判定 ----------------

export interface DriftConflict {
	rel: string;
	/** drifted=封存后被改过；appeared=封存时不存在、现在有了；vanished=封存时存在、现在没了 */
	kind: "drifted" | "appeared" | "vanished";
	/** 沙箱版 sidecar 的项目相对路径（写成功才有） */
	sidecar?: string;
	/** sidecar 落盘失败原因（沙箱版未保住，采认文本必须提示） */
	error?: string;
}

export interface SplitResult {
	/** 可以照常覆盖/删除的干净集 */
	cleanFiles: string[];
	cleanDeletions: string[];
	/** 漂移集（绝不覆盖；sidecar 在 acceptWithSplit 里统一落盘） */
	conflicts: DriftConflict[];
}

/**
 * 逐项判定「封存基线 vs 当前工作区」。
 * baseHashes 缺键的文件按漂移处理（绝不覆盖未知基线的文件——fail-safe）。
 */
export function classifyAgainstBase(projectDir: string, baseHashes: Record<string, string | null>, files: string[], deletions: string[]): SplitResult {
	const cleanFiles: string[] = [];
	const cleanDeletions: string[] = [];
	const conflicts: DriftConflict[] = [];
	const judge = (rel: string, willDelete: boolean): void => {
		const base = Object.prototype.hasOwnProperty.call(baseHashes, rel) ? baseHashes[rel] : undefined;
		const cur = hashPath(path.join(projectDir, rel));
		if (base === undefined || (base !== null && cur === null) || (base !== cur)) {
			conflicts.push({ rel, kind: base === null ? "appeared" : base === undefined ? "drifted" : cur === null ? "vanished" : "drifted" });
			return;
		}
		(willDelete ? cleanDeletions : cleanFiles).push(rel);
	};
	for (const rel of files) judge(rel, false);
	for (const rel of deletions) judge(rel, true);
	return { cleanFiles, cleanDeletions, conflicts };
}

/** sidecar 命名：<rel>.planmerge-<ts>（目录同形，落为 .planmerge-<ts>/ 目录） */
export function sidecarRel(rel: string, ts: number): string {
	return `${rel}.planmerge-${ts}`;
}

/** 把沙箱版（viewRoot 下）写到 sidecar，保住新旧两版中的旧版 */
async function writeSidecar(projectDir: string, viewRoot: string, c: DriftConflict, ts: number): Promise<void> {
	const src = path.join(viewRoot, c.rel);
	const sRel = sidecarRel(c.rel, ts);
	const dst = path.join(projectDir, sRel);
	try {
		if (!fs.existsSync(src)) {
			c.error = "沙箱内已无该文件，无法落 sidecar";
			return;
		}
		await fsp.mkdir(path.dirname(dst), { recursive: true });
		const st = fs.lstatSync(src);
		if (st.isDirectory()) {
			if (fs.existsSync(dst)) throw new Error(`sidecar 目标已存在：${sRel}`);
			await fsp.cp(src, dst, { recursive: true });
		} else {
			await fsp.copyFile(src, dst);
		}
		c.sidecar = sRel;
	} catch (e: any) {
		c.error = String(e?.message || e);
	}
}

// ---------------- 门禁（自 gate.ts 并入） ----------------

export interface GateResult {
	passed: boolean;
	output: string; // 失败时截取的尾部输出
}

/** 门禁命令在真实工作区（宿主 shell）执行 */
export async function runGate(projectDir: string, gate: string, timeoutSec = 600): Promise<GateResult> {
	const isWin = process.platform === "win32";
	const outputChunks: Buffer[] = [];
	const child = isWin
		? spawn("cmd.exe", ["/d", "/s", "/c", gate], { cwd: projectDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
		: spawn("bash", ["-lc", gate], { cwd: projectDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	return new Promise((resolve) => {
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {}
		}, timeoutSec * 1000);
		child.stdout?.on("data", (b) => outputChunks.push(b));
		child.stderr?.on("data", (b) => outputChunks.push(b));
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ passed: false, output: String(e?.message || e) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const all = Buffer.concat(outputChunks).toString("utf8");
			if (timedOut) resolve({ passed: false, output: `门禁超时\n${all.slice(-2000)}` });
			else if (code === 0) resolve({ passed: true, output: "" });
			else resolve({ passed: false, output: all.slice(-2000) });
		});
	});
}

// ---------------- stash（门禁失败整单回滚专用，自 gate.ts 并入） ----------------

/** 采认前快照原文件（供门禁失败回滚）：files=将被覆盖/新增的，deletions=将被删除的 */
async function stashOriginals(projectDir: string, stashDir: string, files: string[], deletions: string[]): Promise<void> {
	await fsp.mkdir(stashDir, { recursive: true });
	for (const rel of [...files, ...deletions]) {
		const abs = path.join(projectDir, rel);
		const dst = path.join(stashDir, rel);
		if (fs.existsSync(abs)) {
			await fsp.mkdir(path.dirname(dst), { recursive: true });
			const st = fs.statSync(abs);
			if (st.isDirectory()) {
				await fsp.cp(abs, dst, { recursive: true }); // 目录交付/目录删除：整树快照
			} else {
				await fsp.copyFile(abs, dst);
			}
			// 标记存在性（回滚时还原文件而非删除）
			await fsp.writeFile(dst + ".psb-orig", "1");
		} else {
			// 原本不存在（新增文件）→ 回滚时应删除
			await fsp.mkdir(path.dirname(dst), { recursive: true });
			await fsp.writeFile(dst + ".psb-absent", "1");
		}
	}
}

/** 回滚：把 stash 还原到真实工作区 */
async function rollback(projectDir: string, stashDir: string, files: string[], deletions: string[]): Promise<string[]> {
	const errors: string[] = [];
	const restore = async (rel: string) => {
		const src = path.join(stashDir, rel);
		const abs = path.join(projectDir, rel);
		if (fs.existsSync(src + ".psb-absent")) {
			await fsp.rm(abs, { recursive: true, force: true }); // 原本没有 → 删掉
			return;
		}
		if (fs.existsSync(src)) {
			await fsp.mkdir(path.dirname(abs), { recursive: true });
			if (fs.statSync(src).isDirectory()) {
				await fsp.rm(abs, { recursive: true, force: true });
				await fsp.cp(src, abs, { recursive: true });
			} else {
				await fsp.copyFile(src, abs);
			}
			return;
		}
		errors.push(rel);
	};
	for (const rel of files) await restore(rel);
	for (const rel of deletions) await restore(rel);
	return errors;
}

// ---------------- 采认编排 ----------------

export interface AcceptWithSplitResult {
	report: AcceptReport;
	gate?: GateResult;
	reverted: boolean;
	/** 漂移集（含 sidecar 落点/错误） */
	conflicts: DriftConflict[];
}

/**
 * 采认主流程：分流（漂移落 sidecar 不覆盖）→ 干净集拷贝/删除 → 门禁（失败整单回滚）。
 * base 必传（manifest 单一事实源；调用方经 manifestIssues 保证存在与覆盖）。
 * viewRoot = 沙箱内容源目录（CLI 传 handle 的 upper/snapshot，web 传 viewRoot(sandboxDir)）。
 */
export async function acceptWithSplit(
	provider: Pick<SandboxProvider, "accept">,
	h: SandboxHandle,
	files: string[],
	deletions: string[],
	opts: { gate?: string; base: { baseHashes: Record<string, string | null>; baseTs?: number }; viewRoot: string },
): Promise<AcceptWithSplitResult> {
	const ts = Date.now();
	const { cleanFiles, cleanDeletions, conflicts } = classifyAgainstBase(h.projectDir, opts.base.baseHashes, files, deletions);
	// 漂移集先落 sidecar（旧版保底；此后沙箱即使销毁也不丢内容）
	for (const c of conflicts) await writeSidecar(h.projectDir, opts.viewRoot, c, ts);

	const stashDir = path.join(h.sandboxDir, "orig");
	const gate = opts.gate?.trim() ? opts.gate : undefined;
	if (gate) {
		await stashOriginals(h.projectDir, stashDir, cleanFiles, cleanDeletions);
	}
	const report = await provider.accept(h, cleanFiles, cleanDeletions);
	const hadFailure = report.failed.length > 0;
	let gateResult: GateResult | undefined;
	let reverted = false;
	if (hadFailure) {
		// 拷贝本身有失败：不跑门禁，直接整单回滚（门禁面对半残状态没有意义）
		const errs = await rollback(h.projectDir, stashDir, cleanFiles, cleanDeletions);
		reverted = true;
		for (const rel of errs) report.failed.push({ path: rel, error: "rollback failed" });
	} else if (gate) {
		gateResult = await runGate(h.projectDir, gate);
		if (!gateResult.passed) {
			const errs = await rollback(h.projectDir, stashDir, cleanFiles, cleanDeletions);
			reverted = true;
			for (const rel of errs) report.failed.push({ path: rel, error: "rollback failed" });
		}
	}
	return { report, gate: gateResult, reverted, conflicts };
}

// ---------------- 提示文本 ----------------

/** CLI 侧：从 handle 推沙箱内容源目录（copy 档=snapshot；overlay 档=upper） */
export function handleViewRoot(h: SandboxHandle): string {
	return (h.extra?.snapshotDir as string) || path.join(h.sandboxDir, "upper");
}

/** 陈旧度提示：封存超 24h 提醒（调用方拼进结果文本） */
export function stalenessHint(baseTs: number | undefined, now = Date.now()): string | null {
	if (typeof baseTs !== "number" || !(baseTs > 0)) return null;
	const days = (now - baseTs) / 86_400_000;
	if (days < 1) return null;
	return `沙箱封存于 ${days >= 2 ? Math.floor(days) + " 天" : "1 天"}前，期间工作区可能有后续变更，请留意合并。`;
}

/** 冲突集统一措辞（三条路径同文案） */
export function conflictLines(conflicts: DriftConflict[]): string[] {
	if (conflicts.length === 0) return [];
	const lines = [`${conflicts.length} 个文件因工作区已变更而未覆盖（新旧两版都在，.planmerge 后缀为沙箱版）：`];
	for (const c of conflicts.slice(0, 20)) {
		lines.push(`  ${c.rel} → ${c.sidecar ?? "（sidecar 落盘失败" + (c.error ? `：${c.error}）` : "）")}`);
	}
	if (conflicts.length > 20) lines.push(`  …(+${conflicts.length - 20} more)`);
	return lines;
}
