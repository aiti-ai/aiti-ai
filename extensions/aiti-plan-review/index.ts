/**
 * aiti-plan-review — Plan-Sandbox 采认收尾 UI + pi-web 会话 plan 模式全量接管（读 review.json 契约，声明/其他分类点选采认）
 *
 * 数据契约（pi 扩展与 web 注入的 declare_deliverables 落盘）：
 *   <sandboxBase>/<id>/meta.json     { provider, tier, projectDir, sandboxDir, createdAt, sessionId? }
 *     sessionId = 沙箱归属会话（所有权）。缺失 = 无主（UI /new-plan 预建，等待新会话收养）。
 *     工具侧认领规则见 latestSandboxFor：只认自己的 + 无主仅限「比沙箱年轻的会话」收养一次——
 *     绝不允许按 cwd 无差别认领（否则同目录其他运行中会话会被劫持进沙箱）。
 *   <sandboxBase>/<id>/manifest.json { files, deletions, summary, gate?, notes?, baseHashes, baseTs }
 *     baseHashes = 封存时刻工作区原文件 sha256（added 记 null；缺键/缺失 → 采认拒绝，陈旧恢复分流底线）
 *   <sandboxBase>/<id>/review.json   { status:"pending", delta:{added,modified,deleted}, declared, ... }
 *   <sandboxBase>/<id>/upper|snapshot/  快照内容（overlay 档=upper；copy 档=snapshot）
 *
 * agent 注入（方案 M server.agent）：plan_start / sandbox_bash / declare_deliverables 三工具
 *   + 同名覆盖 read/write/edit/bash/ls/find/grep（激活后经 ops 自动进沙箱；未激活透传内置实现）。
 *   依赖 SDK 工具工厂：部署目录带 node_modules 符号链接（deploy.mjs 创建）。
 *
 * API（/api/extensions/aiti-plan-review/*）：
 *   GET  /list                          → pending 列表（含 others 分类）
 *   POST /status  { cwd }                → 当前会话目录 plan 沙箱态（active/tier/declared/pending）
 *   POST /preview { sessionId, cwd }      → 结算前置预览（只读）
 *   POST /history { cwd }                 → 当前工作区遗留沙箱历史
 *   POST /file    { sandbox, rel, side }   → 单文件内容（side=rev 快照 | base 项目现状）
 *   POST /apply  { sandbox, files, deletions } → 拷回 + 门禁（失败整单回滚）+ 销毁
 *   POST /discard { sandbox }                  → 丢弃销毁
 *   （文件路径一律走 body，不进 URL）
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as piPkg from "@earendil-works/pi-coding-agent";
import { createProvider, rmRfSafe, type SandboxHandle, type SandboxProvider } from "./lib/providers.ts";
import { acceptWithSplit, computeBaseHashes, conflictLines, stalenessHint } from "./lib/accept-core.ts";
import { buildBashOps, buildEditOps, buildFindOps, buildLsOps, buildReadOps, buildWriteOps, executeGrep } from "./lib/ops.ts";

/** [P0-3] 采认终态 survive 位根（server.startup 注入 ctx.configDir；落 cache/，可再生；缺省落系统临时目录） */
let configDir = "";
import { LocalView, MergedView } from "./lib/fsview.ts";

/** 落 meta.json 契约（与 pi-ext/plan-sandbox resume.ts 对齐；采认面板 base 侧与 apply 门禁依赖）。sessionId = 归属会话（所有权）。 */
function persistMeta(h: SandboxHandle, p: SandboxProvider, sessionId?: string): void {
	try {
		fs.mkdirSync(h.sandboxDir, { recursive: true });
		fs.writeFileSync(
			path.join(h.sandboxDir, "meta.json"),
			JSON.stringify({ provider: (p as any).name, tier: h.tier, projectDir: h.projectDir, sandboxDir: h.sandboxDir, createdAt: h.createdAt, ...(sessionId ? { sessionId } : {}) }, null, 2),
		);
	} catch {}
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function baseDirs(): string[] {
	const out = new Set<string>();
	if (process.env.XDG_RUNTIME_DIR) out.add(path.join(process.env.XDG_RUNTIME_DIR, "plan-sandbox"));
	out.add(path.join(os.tmpdir(), "plan-sandbox"));
	return [...out].filter((d) => fs.existsSync(d));
}

// 会话级 plan 态（sessionId → {provider, handle, bornAt}）：agentTools 闭包与 HTTP API 共享，
// UI /start 开的沙箱模型工具立即可见；UI /end / apply / discard 后 handle 失效由 active() 兜底清理。
// bornAt = agentTools 调用时刻（≈会话创建时刻），用于「无主沙箱只能被年轻会话收养」判定。
const sessionStates = new Map<string, { provider?: SandboxProvider; handle?: SandboxHandle; bornAt?: number }>();
function sessionState(sessionId: string): { provider?: SandboxProvider; handle?: SandboxHandle; bornAt?: number } {
	let s = sessionStates.get(sessionId);
	if (!s) {
		s = {};
		sessionStates.set(sessionId, s);
		if (sessionStates.size > 200) {
			const oldest = sessionStates.keys().next().value;
			if (oldest !== undefined && oldest !== sessionId) sessionStates.delete(oldest);
		}
	}
	return s;
}

// 无主（预建）沙箱收养窗口：超时视为预建流程已中断，不再被静默认领（可从沙箱历史显式重用）
const ADOPT_MAX_AGE_MS = 10 * 60_000;

/** 沙箱是否处于可被工具侧认领的活跃可写态：无 review.json（从未 declare）或 status=active。
 *  pending（待采认）/kept/extracted 不可自动认领——重用必须走显式 /reuse。 */
function claimableStatus(sandboxDir: string): boolean {
	try {
		const st = JSON.parse(fs.readFileSync(path.join(sandboxDir, "review.json"), "utf8")).status;
		return !st || st === "active";
	} catch {
		return true;
	}
}

/**
 * 按【会话所有权】找当前可认领的沙箱（修复：旧实现按 cwd 无差别认领 → 同目录其他运行中会话被劫持进沙箱）。
 *  - mode="own"：只认 meta.sessionId === sid 的（含 pi-web 重启后磁盘恢复）；
 *  - mode="adopt"：自己的 + 无主预建沙箱收养（收养条件：会话 bornAt 不早于沙箱 createdAt——「为它而生」的新会话，
 *    且沙箱未过收养窗口）；调用方认领成功后须调 adoptSandbox 写回归属，此后其他会话永远认领不走；
 *  - mode="unowned"：只看无主可认领沙箱（/new-plan 幂等去重用）；
 *  - 一律跳过 pending/kept/extracted 态与他人所有的沙箱。
 */
function latestSandboxFor(cwd: string, opts: { mode: "own" | "adopt" | "unowned"; sid?: string; bornAt?: number }): { meta: any; sandboxDir: string } | null {
	let best: { meta: any; sandboxDir: string; ts: number } | null = null;
	for (const base of baseDirs()) {
		let ids: string[] = [];
		try { ids = fs.readdirSync(base); } catch { continue; }
		for (const id of ids) {
			const dir = path.join(base, id);
			try {
				const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
				if (meta.projectDir !== cwd) continue;
				if (!claimableStatus(dir)) continue;
				const created = Number(meta.createdAt) || 0;
				if (meta.sessionId) {
					if (opts.mode === "unowned") continue;
					if (meta.sessionId !== opts.sid) continue; // 他人所有 → 不认领
				} else {
					if (opts.mode === "own") continue;
					if (Date.now() - created > ADOPT_MAX_AGE_MS) continue;
					if (opts.mode === "adopt" && (opts.bornAt === undefined || opts.bornAt + 2000 < created)) continue; // 老会话不收养
				}
				if (!best || created > best.ts) best = { meta, sandboxDir: dir, ts: created };
			} catch {}
		}
	}
	return best ? { meta: best.meta, sandboxDir: best.sandboxDir } : null;
}

/** 收养：把会话 id 写进 meta.json（此后沙箱归属该会话，其他会话认领不走）；
 *  force=true 强制覆盖旧主归属（/reuse 显式重用：用户主动把沙箱转移给当前会话，
 *  不写回则 pi-web 重启/扩展热重载后 sessionStates 内存态丢失 → 沙箱脱钩孤悬） */
function adoptSandbox(sandboxDir: string, sessionId: string, force = false): void {
	try {
		const p = path.join(sandboxDir, "meta.json");
		const meta = JSON.parse(fs.readFileSync(p, "utf8"));
		if (force || !meta.sessionId) {
			if (meta.sessionId !== sessionId) {
				meta.sessionId = sessionId;
				fs.writeFileSync(p, JSON.stringify(meta, null, 2));
			}
		}
	} catch {}
}

/** 从落盘 meta 重建句柄（与 pi-ext resume.ts reconstructHandle 同构；仅 fs 操作所需字段） */
function reconstructFromMeta(meta: any): SandboxHandle | null {
	try {
		const expected = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "macos" : "win32";
		if (meta.provider !== expected) return null;
		if (meta.tier === "overlay" || meta.tier === "overlay-noro") {
			const upper = path.join(meta.sandboxDir, "upper");
			if (!fs.existsSync(upper)) return null;
			return { id: path.basename(meta.sandboxDir), tier: meta.tier, projectDir: meta.projectDir, sandboxDir: meta.sandboxDir, view: new MergedView(meta.projectDir, upper), createdAt: meta.createdAt ?? 0, extra: { tmpDir: "/tmp", pids: [] } } as SandboxHandle;
		}
		const snapshotDir = path.join(meta.sandboxDir, "snapshot");
		if (!fs.existsSync(snapshotDir)) return null;
		return { id: path.basename(meta.sandboxDir), tier: meta.tier, projectDir: meta.projectDir, sandboxDir: meta.sandboxDir, view: new LocalView(snapshotDir), createdAt: meta.createdAt ?? 0, extra: { snapshotDir, tmpDir: "/tmp", pids: [] } } as SandboxHandle;
	} catch {
		return null;
	}
}

function isUnder(base: string, p: string): boolean {
	const r = path.relative(base, p);
	return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
}

interface Pending {
	sandboxDir: string;
	projectDir: string;
	tier: string;
	summary: string;
	gate?: string;
	notes?: string;
	declared: { files: string[]; deletions: string[] };
	delta: { added: string[]; modified: string[]; deleted: string[] };
	others: { added: string[]; modified: string[]; deleted: string[] };
	updatedAt: number;
}

function listPending(): Pending[] {
	const out: Pending[] = [];
	for (const base of baseDirs()) {
		for (const id of fs.readdirSync(base)) {
			const dir = path.join(base, id);
			try {
				const review = JSON.parse(fs.readFileSync(path.join(dir, "review.json"), "utf8"));
				if (review.status !== "pending") continue;
				const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
				const dec = new Set([...(manifest.files || []), ...(manifest.deletions || [])]);
				const f = (a: string[]) => a.filter((x: string) => !dec.has(x));
				out.push({
					sandboxDir: dir,
					projectDir: review.projectDir,
					tier: review.tier || metaTier(dir),
					summary: review.summary || manifest.summary || "",
					gate: review.gate,
					notes: review.notes,
					declared: { files: manifest.files || [], deletions: manifest.deletions || [] },
					delta: review.delta,
					others: { added: f(review.delta.added), modified: f(review.delta.modified), deleted: f(review.delta.deleted) },
					updatedAt: review.updatedAt || 0,
				});
			} catch {}
		}
	}
	return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function metaTier(dir: string): string {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")).tier || "?";
	} catch {
		return "?";
	}
}

/** 快照视图根：overlay 档=upper；copy 档=snapshot */
function viewRoot(sandboxDir: string): string | null {
	for (const d of ["upper", "snapshot"]) {
		const p = path.join(sandboxDir, d);
		if (fs.existsSync(p)) return p;
	}
	return null;
}

function readFileSafe(p: string): string | null {
	try {
		return fs.readFileSync(p, "utf8");
	} catch {
		return null;
	}
}


/** 门禁执行已收敛进 lib/accept-core.ts runGate（异步 spawn；2026-09-13 性能红线保留：
 *  gate 绝不在 pi-web 主线程同步执行）。 */

async function applyOne(sandboxDir: string, files: string[], deletions: string[]): Promise<{ ok: boolean; text: string }> {
	const read = (f: string) => {
		try {
			return JSON.parse(fs.readFileSync(path.join(sandboxDir, f), "utf8"));
		} catch {
			return null;
		}
	};
	const meta = read("meta.json");
	const manifest = read("manifest.json");
	const review = read("review.json");
	if (!meta || !manifest || !review || review.status !== "pending") return { ok: false, text: "沙箱不存在或不在 pending 状态" };
	const projectDir: string = meta.projectDir;
	const view = viewRoot(sandboxDir);
	if (!view) return { ok: false, text: "快照视图缺失" };

	// 基线指纹（manifest 单一事实源；缺失 = 拒绝——未上线无降级，陈旧恢复分流的安全底线）
	if (!manifest.baseHashes || typeof manifest.baseHashes !== "object") {
		return { ok: false, text: "沙箱缺少基线指纹（manifest.baseHashes），无法安全比对工作区漂移，已拒绝采认。" };
	}
	const h = reconstructFromMeta(meta);
	if (!h) return { ok: false, text: "沙箱无法重建（平台不匹配或目录损坏）" };

	// 选择 ⊆ delta
	const modOrAdd = new Set([...review.delta.added, ...review.delta.modified]);
	const del = new Set(review.delta.deleted);
	const bad = [...files.filter((f: string) => !modOrAdd.has(f)), ...deletions.filter((f: string) => !del.has(f))];
	if (bad.length > 0) return { ok: false, text: `选择集与快照增量不符：${bad.join(", ")}` };

	// 分流采认（共享 accept-core：漂移落 sidecar 不覆盖，绝不静默丢新版；stash 收窄为门禁回滚专用）
	const baseTs: number = typeof manifest.baseTs === "number" ? manifest.baseTs : 0;
	const gate: string | undefined = manifest.gate;
	const { report, gate: gateResult, reverted, conflicts } = await acceptWithSplit(createProvider(), h, files, deletions, {
		gate,
		base: { baseHashes: manifest.baseHashes, baseTs },
		viewRoot: view,
	});
	const gateOutput = reverted && gateResult?.output ? gateResult.output : "";

	// 收尾
	review.status = reverted ? "discarded" : "accepted";
	fs.writeFileSync(reviewPath(sandboxDir), JSON.stringify(review, null, 2));
	// [P0-3] 终态持久：①missionResolve 结算（/plan review 路径此前不结算 → mission 永久悬空）；
	// ②终态副本写 configDir survive 位（review.json 随沙箱销毁，此前无法事后回答采认结果）。
	try {
		const { missionResolve } = await import("./lib/mission.ts");
		missionResolve(sandboxDir, projectDir, reverted ? "rolledback" : "accepted");
	} catch {}
	// [P1-1 记账合一] 采认/丢弃落 aiti-git-trace 台账（JSONL 追加，语义对齐 trace-core.appendOps；
	// kind=plan-accept/plan-discard 供时间线过滤）。configDir 缺席（旧宿主）静默跳过。
	// 注意：web 宿主不接 trace 双 commit（fusion 实施档 §2.3：globalThis 时序不可依赖 + ctxRef 归因
	// 错误），此 op-less 行是 web 端唯一记账形态；CLI 端走 __aitiTracePlanRecord 真 op。
	try {
		if (configDir) {
			const sid = String(meta.sessionId || "default").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "default";
			const dir = path.join(path.dirname(configDir), "cache", "aiti-git-trace", "ops"); // 数据分层：cache 在 <extRoot> 下
			fs.mkdirSync(dir, { recursive: true });
			fs.appendFileSync(path.join(dir, `${sid}.jsonl`), JSON.stringify({
				kind: reverted ? "plan-discard" : "plan-accept", t: Date.now(),
				sandbox: path.basename(sandboxDir),
				mission: (() => { try { return JSON.parse(fs.readFileSync(path.join(sandboxDir, "mission.json"), "utf8")).id || ""; } catch { return ""; } })(),
				files, conflicts: conflicts.map((c) => c.rel), summary: String(review.summary || "").slice(0, 500),
			}) + "\n", "utf8");
		}
	} catch {}
	try {
		const dir = configDir ? path.join(path.dirname(configDir), "cache", "plan-review") : path.join(os.tmpdir(), "aiti-plan-review");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${path.basename(sandboxDir)}-review.json`), JSON.stringify(review, null, 2));
	} catch {}
	rmRfSafe(sandboxDir);

	const lines: string[] = [];
	if (reverted) {
		lines.push(`门禁未通过，已整单回滚（真实工作区恢复原状）。`);
		if (gateOutput) lines.push("门禁输出（尾部）：", gateOutput.split("\n").slice(-15).join("\n"));
	} else {
		lines.push(`采认完成：${report.copied.length} 文件写入，${report.deleted.length} 删除，沙箱已销毁。`);
		if (gate && gateResult) lines.push(`门禁通过：${gate}`);
	}
	lines.push(...conflictLines(conflicts));
	const stale = stalenessHint(baseTs || undefined);
	if (stale) lines.push(stale);
	if (report.failed.length) lines.push(`失败 ${report.failed.length} 项：`, ...report.failed.slice(0, 10).map((f) => `  ${f.path}: ${f.error}`));
	return { ok: !reverted || report.failed.length === 0, text: lines.join("\n") };
}

function reviewPath(sandboxDir: string): string {
	return path.join(sandboxDir, "review.json");
}

// ---------- 沙箱生命周期：历史 / 提取 / 重用 / 保留（结算前置预览用） ----------

/** 读取沙箱目录下的 JSON 契约（成败都吞异常） */
function readSandboxJson(sandboxDir: string, name: string): any {
	try {
		return JSON.parse(fs.readFileSync(path.join(sandboxDir, name), "utf8"));
	} catch {
		return null;
	}
}

/** 解析当前会话的活跃沙箱句柄：优先会话内存态，否则磁盘恢复（只认本会话所有的，不收养无主沙箱） */
function resolveActiveHandle(sid: string, cwd: string): { handle: SandboxHandle; provider: SandboxProvider; sandboxDir: string } | null {
	if (sid) {
		const st = sessionStates.get(sid);
		if (st?.handle && st.provider && fs.existsSync(st.handle.sandboxDir)) return { handle: st.handle, provider: st.provider, sandboxDir: st.handle.sandboxDir };
	}
	const disk = latestSandboxFor(cwd, { mode: "own", sid });
	if (disk) {
		const h = reconstructFromMeta(disk.meta);
		if (h) return { handle: h, provider: createProvider(), sandboxDir: disk.sandboxDir };
	}
	return null;
}

/** 从沙箱快照视图把选中文件拷贝回真实工作区，但【保留】沙箱（供重新提取/重用/再销毁）。
 *  不跑门禁（部分提取不做整体校验），不 stash/不回滚，设 review.status = "extracted"。 */
async function extractKeep(sandboxDir: string, files: string[], deletions: string[]): Promise<{ ok: boolean; text: string }> {
	const meta = readSandboxJson(sandboxDir, "meta.json");
	if (!meta) return { ok: false, text: "沙箱不存在" };
	const projectDir: string = meta.projectDir;
	const view = viewRoot(sandboxDir);
	if (!view) return { ok: false, text: "快照视图缺失" };

	// 选择 ⊆ delta
	let delta: { added: string[]; modified: string[]; deleted: string[] } | null = readSandboxJson(sandboxDir, "review.json")?.delta ?? null;
	if (!delta) {
		const h = reconstructFromMeta(meta);
		delta = h ? await createProvider().delta(h) : { added: [], modified: [], deleted: [] };
	}
	const modOrAdd = new Set([...delta.added, ...delta.modified]);
	const del = new Set(delta.deleted);
	const bad = [...files.filter((f: string) => !modOrAdd.has(f)), ...deletions.filter((f: string) => !del.has(f))];
	if (bad.length > 0) return { ok: false, text: `选择集与快照增量不符：${bad.join(", ")}` };

	const copyIn = async (rel: string) => {
		const s = path.join(view, rel);
		const d = path.join(projectDir, rel);
		fs.mkdirSync(path.dirname(d), { recursive: true });
		const st = fs.statSync(s);
		if (st.isDirectory()) await fsp.cp(s, d, { recursive: true });
		else {
			fs.copyFileSync(s, d);
			fs.chmodSync(d, st.mode & 0o7777);
		}
	};
	const copied: string[] = [];
	const failed: string[] = [];
	for (const rel of files) {
		try {
			await copyIn(rel);
			copied.push(rel);
		} catch (e: any) {
			failed.push(`${rel}: ${e?.message || e}`);
		}
	}
	const deleted: string[] = [];
	for (const rel of deletions) {
		try {
			fs.rmSync(path.join(projectDir, rel), { recursive: true, force: true });
			deleted.push(rel);
		} catch (e: any) {
			failed.push(`${rel}: ${e?.message || e}`);
		}
	}

	const review = readSandboxJson(sandboxDir, "review.json");
	if (review) {
		review.status = "extracted";
		review.updatedAt = Date.now();
		fs.writeFileSync(reviewPath(sandboxDir), JSON.stringify(review, null, 2));
	}
	// P2-2（lineage-closure）：部分提取不走「gate 失败整单回滚」承诺——如实明示降级语义
	const lines = [`已提取 ${copied.length} 文件、${deleted.length} 删除到真实工作区，沙箱保留（可继续重用/再提取/销毁）。`, "⚠ 部分提取：不跑采认门禁、不做整体校验（与整单采认不同，出问题不自动回滚）。"];
	if (failed.length) lines.push(`失败 ${failed.length} 项：`, ...failed.slice(0, 10));
	return { ok: failed.length === 0, text: lines.join("\n") };
}

/** 当前工作区（cwd）全部遗留沙箱的历史列表（含 active/pending/kept/extracted；已销毁的不出现） */
async function listHistoryByCwd(cwd: string): Promise<unknown[]> {
	const out: unknown[] = [];
	for (const base of baseDirs()) {
		for (const id of fs.readdirSync(base)) {
			const dir = path.join(base, id);
			try {
				const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
				if (meta.projectDir !== cwd) continue;
				if (!viewRoot(dir)) continue; // 已销毁
				const manifest = readSandboxJson(dir, "manifest.json");
				const review = readSandboxJson(dir, "review.json");
				const status = review?.status || (manifest ? "pending" : "active");
				let delta = review?.delta;
				if (!delta) {
					const h = reconstructFromMeta(meta);
					delta = h ? await createProvider().delta(h) : { added: [], modified: [], deleted: [] };
				}
				out.push({
					sandboxDir: dir,
					projectDir: meta.projectDir,
					tier: meta.tier || "",
					status,
					summary: manifest?.summary || review?.summary || "",
					gate: manifest?.gate,
					notes: manifest?.notes || review?.notes,
					declared: { files: manifest?.files || [], deletions: manifest?.deletions || [] },
					delta,
					updatedAt: review?.updatedAt || Number(meta.createdAt) || 0,
				});
			} catch { /* 跳过坏目录 */ }
		}
	}
	(out as { updatedAt: number }[]).sort((a, b) => b.updatedAt - a.updatedAt);
	return out;
}

export default {
	id: "aiti-plan-review",
	name: "Plan-Sandbox 采认（声明 vs 其他，点选回收）",
	version: "0.1.0",
	icon: "📥",
	client: "dist/aiti-plan-review-client.mjs",
	// 插槽意图声明（规范 §5：与 client registerItems 同 id；本扩展立即加载，声明以显意图 + extman 展示）
	ui: {
		toolbar: [{ id: "aiti-plan-review-open", label: "Plan 采认", icon: "icons/inbox.svg" }, { id: "aiti-plan-review-history", label: "沙箱历史", icon: "icons/history.svg" }],
		dialogs: [{ id: "aiti-plan-review-panel", label: "Plan 采认" }],
	},
	// 功能管理（规范 §6 工具级约定 tool.<注入后的工具名>）：默认全开，extman 可逐个关。
	// 沙箱化同名工具（read/write/edit/…）：plan 未激活时与内置行为完全一致（透传），
	// 关闭 = 回退内置直写真实工作区（plan 模式下失去隔离，declare 校验会失败）。
	features: [
		{ id: "tool.plan_start", label: "进入 Plan-Sandbox 模式", group: "Plan 工具" },
		{ id: "tool.sandbox_bash", label: "沙箱内执行命令", group: "Plan 工具" },
		{ id: "tool.declare_deliverables", label: "声明交付物（采认）", group: "Plan 工具" },
		{ id: "tool.plan_abort", label: "中止计划（失败出口）", group: "Plan 工具" },
		{ id: "tool.read", label: "read（沙箱化：激活后读快照）", group: "沙箱化系统工具" },
		{ id: "tool.write", label: "write（沙箱化：激活后写快照）", group: "沙箱化系统工具" },
		{ id: "tool.edit", label: "edit（沙箱化：激活后改快照）", group: "沙箱化系统工具" },
		{ id: "tool.bash", label: "bash（沙箱化：激活后在沙箱执行）", group: "沙箱化系统工具" },
		{ id: "tool.ls", label: "ls（沙箱化：激活后列快照）", group: "沙箱化系统工具" },
		{ id: "tool.find", label: "find（沙箱化：激活后搜快照）", group: "沙箱化系统工具" },
		{ id: "tool.grep", label: "grep（沙箱化：激活后搜快照）", group: "沙箱化系统工具" },
		{ id: "ui.toolbar.sandboxHistory", label: "工具栏·沙箱历史入口", group: "Plan UI", default: false },
	],
	server: {
		startup(ctx: any) {
			// [P0-3] 终态 survive 位根目录（采认终态记录写到 <configDir>/plan-review/，不随沙箱销毁）
			configDir = ctx?.configDir || configDir;
		},
		// 方案 M agent 注入点：plan 模式三工具 + 沙箱态同名工具覆盖，注入每个 agent 会话
		agent: {
			agentTools(info: any) {
				console.error("[aiti-plan-review] agentTools called, sessionId=", info?.sessionId, "cwd=", info?.cwd);
				const sessionId: string = info?.sessionId || String(Math.random());
				const cwd: string = info?.cwd || info?.projectDir || process.env.HOME || "/tmp";
				const bornAt = Date.now(); // ≈会话创建时刻：无主沙箱只允许「比它年轻」的会话收养
				const st = sessionState(sessionId);
				st.bornAt = bornAt;
				const active = () => {
					if (st.handle) {
						// 沙箱已被采认/丢弃销毁 → 失效清理
						if (!fs.existsSync(st.handle.sandboxDir)) {
							st.handle = undefined;
							st.provider = undefined;
						} else return true;
					}
					// 磁盘恢复/收养：只认本会话所有的；无主预建沙箱仅由「为它而生」的新会话收养（写回归属）。
					// 绝不按 cwd 无差别认领——否则同目录其他运行中会话会被劫持进沙箱。
					const disk = latestSandboxFor(cwd, { mode: "adopt", sid: sessionId, bornAt });
					if (disk) {
						const h = reconstructFromMeta(disk.meta);
						if (h) {
							adoptSandbox(disk.sandboxDir, sessionId);
							st.handle = h;
							st.provider = createProvider();
							return true;
						}
					}
					return false;
				};
				const tools: any[] = [];

				// ---- 循环护栏（2026-08-30 session eccffb90 教训：弱模型在 plan 模式退化成 true/echo 占位循环，
				// 每次都成功返回→无错误信号→无法自纠。连续 ≥3 次无操作命令时在结果里注入出口提示）----
				const LOOP = { run: 0 };
				const NOOP_RE = /^\s*(?:true|:|echo\s+[^;&|<>`$]{1,80})\s*$/i;
				const loopHint = (n: number) =>
					`\n[plan-sandbox] ⚠ 已连续 ${n} 次无操作命令（true/echo 占位）。你在等待的那个工具调用【并没有发生】——bash 只是执行了文本，不会替你发出它。`
					+ `若计划已完成：调用 declare_deliverables（无文件交付的任务 files=[] 即可）；若任务无法继续：调用 plan_abort(reason) 中止并退出沙箱。不要再用占位命令。`;
				const guardNoop = (params: any, result: any): any => {
					if (NOOP_RE.test(String(params?.command || ""))) {
						LOOP.run++;
						if (active() && LOOP.run >= 3 && Array.isArray(result?.content)) {
							result.content.push({ type: "text", text: loopHint(LOOP.run) });
						}
					} else {
						LOOP.run = 0;
					}
					return result;
				};

				// ---- 沙箱态工具覆盖：同名覆盖内置（agent-session.js 里 customTools 后置 set，同名后者胜）；
				// 未激活透传内置实现，激活后经 ops（与 pi-ext/plan-sandbox 同一套）进沙箱视图 ----
				const factory = (cap: string, opts?: any) => (piPkg as any)[`create${cap}Tool`](cwd, opts);
				const overrides: Array<[string, string, (h: SandboxHandle) => any]> = [
					["read", "Read", (h) => ({ operations: buildReadOps(h) })],
					["write", "Write", (h) => ({ operations: buildWriteOps(h) })],
					["edit", "Edit", (h) => ({ operations: buildEditOps(h) })],
					["ls", "Ls", (h) => ({ operations: buildLsOps(h) })],
					["find", "Find", (h) => ({ operations: buildFindOps(h) })],
					["bash", "Bash", (h) => ({ operations: buildBashOps(h, st.provider!) })],
				];
				for (const [name, cap, opsOf] of overrides) {
					const base = factory(cap);
					tools.push({
						name,
						label: (base as any).label ?? name,
						description: (base as any).description,
						parameters: (base as any).parameters,
						async execute(id: string, params: any, signal: any, onUpdate: any, extCtx?: any) {
							const inst = active() && st.handle ? factory(cap, opsOf(st.handle)) : base;
							const result: any = await inst.execute(id, params, signal, onUpdate, extCtx);
							return name === "bash" ? guardNoop(params, result) : result;
						},
					});
				}
				// grep：激活时用 ops.ts 的遍历式实现（与 pi 扩展一致）
				{
					const gbase = factory("Grep");
					tools.push({
						name: "grep",
						label: (gbase as any).label ?? "grep",
						description: (gbase as any).description,
						parameters: (gbase as any).parameters,
						async execute(id: string, params: any, signal: any, onUpdate: any) {
							if (!active() || !st.handle) return gbase.execute(id, params, signal, onUpdate);
							return executeGrep(st.handle, params, signal);
						},
					});
				}

				tools.push({
					name: "plan_start",
					label: "plan_start",
					description:
						"进入 Plan-Sandbox 模式。当用户要求你【制定计划/方案/规划】、评估思路、探索可行性（而非直接改代码）时调用。"
						+ "激活后所有文件写入与命令执行自动进入隔离沙箱（真实工作区不受影响），工具照常用、无需改变习惯；"
						+ "计划完成时调用 declare_deliverables 声明交付物，由用户在采认面板逐文件采认后才落盘。",
					parameters: { type: "object", properties: {} },
					async execute() {
						if (active()) return { content: [{ type: "text", text: `Plan-Sandbox 已激活（tier=${st.handle!.tier}）。` }], details: undefined };
						try {
							st.provider = createProvider();
							st.handle = await st.provider.start(cwd);
							persistMeta(st.handle, st.provider, sessionId);
						} catch (e: any) {
							return { content: [{ type: "text", text: `激活失败：${e?.message || e}` }], details: undefined };
						}
						return {
							content: [{
								type: "text",
								text: `Plan-Sandbox 已激活（tier=${st.handle!.tier}）。
真实工作区: ${cwd}
现在起 read/write/edit/bash/ls/find/grep 全部自动进沙箱，照常使用即可。计划完成时调用 declare_deliverables 声明交付物（可带 gate 验证命令如 "npm test"；无文件交付的纯分析/验证任务 files=[] 即可），用户采认前不会写入真实工作区。任务无法继续时调用 plan_abort(reason) 中止并退出（沙箱销毁，真实工作区不受影响）。`,
							}],
							details: undefined,
						};
					},
				});

				tools.push({
					name: "sandbox_bash",
					label: "sandbox_bash",
					description: "在 Plan-Sandbox 沙箱内执行 bash 命令。仅在 plan_start 激活后使用；未激活时会返回错误提示。",
					parameters: {
						type: "object",
						properties: { command: { type: "string", description: "要执行的命令" }, timeout: { type: "number" } },
						required: ["command"],
					},
					async execute(_id: string, params: any, signal: any) {
						if (!active() || !st.provider) return { content: [{ type: "text", text: "Plan-Sandbox 未激活：请先调用 plan_start，或改用普通 bash。" }], details: undefined };
						const chunks: Buffer[] = [];
						try {
							const r = await st.provider.bashExec(st.handle!, String(params.command || ""), cwd, {
								onData: (b) => chunks.push(b),
								signal: signal || undefined,
								timeout: params.timeout || 120,
							});
							return guardNoop(params, { content: [{ type: "text", text: chunks.join("").toString().slice(0, 30000) + `\n[exit=${r.exitCode}]` }], details: undefined });
						} catch (e: any) {
							return { content: [{ type: "text", text: `执行失败：${e?.message || e}` }], details: undefined };
						}
					},
				});

				tools.push({
					name: "declare_deliverables",
					label: "declare_deliverables",
					description:
						"声明 plan 交付物并结束规划：files=要采认进真实工作区的项目相对路径（自洽集合）；deletions=要删除的文件；"
						+ "gate=可选采认后验证命令（如 npm test，失败整单回滚）。声明后沙箱保留，等待用户在 📥 采认面板逐文件采认或丢弃；"
						+ "未声明内容最终随沙箱销毁。",
					parameters: {
						type: "object",
						properties: {
							files: { type: "array", items: { type: "string" } },
							deletions: { type: "array", items: { type: "string" } },
							summary: { type: "string" },
							gate: { type: "string" },
							notes: { type: "string" },
						},
						required: ["files", "summary"],
					},
					async execute(_id: string, params: any) {
						if (!active() || !st.provider || !st.handle) return { content: [{ type: "text", text: "Plan-Sandbox 未激活。" }], details: undefined };
						const h = st.handle;
						let d: { added: string[]; modified: string[]; deleted: string[] };
						try {
							d = await st.provider.delta(h);
						} catch (e: any) {
							return { content: [{ type: "text", text: `delta 计算失败：${e?.message || e}` }], details: undefined };
						}
						const all = new Set([...d.added, ...d.modified]);
						const del = new Set(d.deleted);
						const files: string[] = params.files || [];
						const deletions: string[] = params.deletions || [];
						const bad = [...files.filter((f) => !all.has(f)), ...deletions.filter((f) => !del.has(f))];
						if (bad.length > 0) return { content: [{ type: "text", text: `声明校验失败（不在快照增量中）：${bad.join(", ")}。若刚改完文件请稍候重试。` }], details: undefined };
						// 落契约（meta/manifest/review=pending），沙箱保留——采认/门禁/回滚由采认面板 apply/discard 完成
						persistMeta(h, st.provider, sessionId);
						const manifest = {
							files,
							deletions,
							summary: String(params.summary ?? ""),
							gate: params.gate ? String(params.gate) : undefined,
							notes: params.notes ? String(params.notes) : undefined,
							ts: Date.now(),
						};
						fs.writeFileSync(path.join(h.sandboxDir, "manifest.json"), JSON.stringify(manifest, null, 2));
						fs.writeFileSync(
							path.join(h.sandboxDir, "review.json"),
							JSON.stringify({ projectDir: h.projectDir, sandboxDir: h.sandboxDir, tier: h.tier, provider: (st.provider as any).name, status: "pending", delta: d, declared: { files, deletions }, summary: manifest.summary, gate: manifest.gate, notes: manifest.notes, updatedAt: Date.now() }, null, 2),
						);
						return {
							content: [{
								type: "text",
								text: `已声明交付物（${files.length} 文件、${deletions.length} 删除；快照增量 +${d.added.length}/~${d.modified.length}/-${d.deleted.length}），沙箱保留。\n等待用户在工具条 📥 采认面板逐文件采认或全部丢弃（未采认内容最终随沙箱销毁）。请停止改动，向用户说明计划与采认方式。`,
							}],
							details: undefined,
						};
					},
				});

				tools.push({
					name: "plan_abort",
					label: "plan_abort",
					description:
						"中止并退出 Plan-Sandbox 模式（失败出口）：销毁沙箱（全部未采认内容丢弃，真实工作区不受影响），回到正常模式。"
						+ "当你发现自己在反复执行无意义命令、陷入循环、方案走不通、或判断任务无法完成时调用；调用后立即向用户如实说明中止原因与已验证结论。"
						+ "不要用 bash/echo 尝试退出模式——出口只有两个：declare_deliverables（成功收尾）与本工具（失败中止）。",
					parameters: {
						type: "object",
						properties: { reason: { type: "string", description: "中止原因（一句话，展示给用户）" } },
						required: ["reason"],
					},
					async execute(_id: string, params: any) {
						if (!active() || !st.provider || !st.handle) {
							return { content: [{ type: "text", text: "Plan-Sandbox 未激活，无需中止。" }], details: undefined };
						}
						const reason = String(params?.reason || "未说明").slice(0, 500);
						await st.provider.destroy(st.handle).catch(() => {});
						st.handle = undefined;
						st.provider = undefined;
						return {
							content: [{
								type: "text",
								text: `Plan-Sandbox 已中止（原因：${reason}）。沙箱已销毁，未采认内容全部丢弃，真实工作区未受任何影响。\n你现在已回到正常模式（无沙箱，所有工具恢复真实工作区语义）。请立即停止原计划的循环动作，用一段话向用户如实报告：①中止原因 ②已验证的结论/发现 ③建议的下一步。除非用户明确要求，不要再次调用 plan_start。`,
							}],
							details: undefined,
						};
					},
				});

				return tools;
			},
		},
		startup() {
			console.log("[aiti-plan-review] 就绪 · bases=" + baseDirs().join(", "));
		},
		async api(req: Request, ctx: any) {
			const full: string[] = ctx.path || [];
				const p = full.slice(full[0] === "aiti-plan-review" ? 1 : 0);
			try {
				if (p[0] === "list" && req.method === "GET") return json({ ok: true, pending: listPending() });

				if (p[0] === "status" && req.method === "POST") {
					// 当前会话目录的 plan 沙箱生命周期态：按 review.status 推导 active/pending/kept/extracted。
					// meta.json 存在 = 沙箱在盘；manifest = 已声明；review.status 驱动终态（未销毁才报 active）。
					// active 判定限【归属当前会话】的沙箱：他人所有的不算本会话 active（pending/kept/extracted
					// 为工作区级展示态照常报告）；无主预建沙箱仅对可收养的年轻会话显示 active（与工具侧收养规则一致）。
					const body = await req.json().catch(() => ({}));
					const sid = String(body.sessionId || "");
					let cwd = String(body.cwd || "");
					try { cwd = cwd ? fs.realpathSync(cwd) : ""; } catch {}
					if (!cwd) return json({ ok: false, error: "cwd required" }, 400);
					const rec = sid ? sessionStates.get(sid) : undefined;
					let best: { sandboxDir: string; tier: string; status: string; declared: boolean; pending: boolean; createdAt: number } | null = null;
					let ownActive = false;
					for (const base of baseDirs()) {
						let ids: string[] = [];
						try { ids = fs.readdirSync(base); } catch { continue; }
						for (const id of ids) {
							const dir = path.join(base, id);
							try {
								const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
								if (meta.projectDir !== cwd) continue;
								const declared = fs.existsSync(path.join(dir, "manifest.json"));
								let reviewStatus = "";
								try { reviewStatus = JSON.parse(fs.readFileSync(path.join(dir, "review.json"), "utf8")).status || ""; } catch {}
								// 沙箱已被 apply/discard 销毁（无视图根）→ 不再报 active
								if (!viewRoot(dir)) continue;
								const status = reviewStatus === "kept" || reviewStatus === "extracted" || reviewStatus === "pending" ? reviewStatus : "active";
								const pending = status === "pending";
								const createdAt = Number(meta.createdAt) || 0;
								if (status === "active" && sid) {
									const own = meta.sessionId === sid
										|| (!!rec?.handle && rec.handle.sandboxDir === dir)
										|| (!meta.sessionId && rec?.bornAt !== undefined && rec.bornAt + 2000 >= createdAt && Date.now() - createdAt <= ADOPT_MAX_AGE_MS);
									if (own) ownActive = true;
								}
								if (!best || createdAt > best.createdAt) best = { sandboxDir: dir, tier: String(meta.tier || ""), status, declared, pending, createdAt };
							} catch {}
						}
					}
					if (!best) return json({ ok: true, active: false });
					return json({ ok: true, active: best.status === "active" && ownActive, ...best });
				}

				if (p[0] === "start" && req.method === "POST") {
					// UI 主动开启：创建沙箱并挂到会话态（模型工具立即可见）；本会话已开则幂等返回。
					// 磁盘恢复/收养只认本会话所有或可收养的无主预建沙箱；他人沙箱存在时新建自己的（overlay 各自独立互不污染）。
					const body = await req.json();
					const sid = String(body.sessionId || "");
					let cwd = String(body.cwd || "");
					try { cwd = cwd ? fs.realpathSync(cwd) : ""; } catch {}
					if (!sid || !cwd) return json({ ok: false, error: "sessionId/cwd required" }, 400);
					const existed = sessionStates.get(sid);
					if (existed?.handle) return json({ ok: true, already: true, tier: existed.handle.tier, sandboxDir: existed.handle.sandboxDir });
					const disk = latestSandboxFor(cwd, { mode: "adopt", sid, bornAt: sessionState(sid).bornAt });
					if (disk) {
						const h = reconstructFromMeta(disk.meta);
						if (h) {
							adoptSandbox(disk.sandboxDir, sid);
							const s = sessionState(sid);
							s.provider = createProvider();
							s.handle = h;
							return json({ ok: true, already: true, tier: h.tier, sandboxDir: disk.sandboxDir });
						}
					}
					const provider = createProvider();
					let handle: SandboxHandle | null = null;
					try { handle = await provider.start(cwd); } catch (e: any) { return json({ ok: false, error: e?.message || String(e) }, 500); }
					persistMeta(handle, provider, sid);
					const s = sessionState(sid);
					s.provider = provider;
					s.handle = handle;
					return json({ ok: true, tier: handle.tier, sandboxDir: handle.sandboxDir });
				}

				if (p[0] === "new-plan" && req.method === "POST") {
					// #5 全自动「开新会话进 /plan」：为新会话【预建】无主沙箱落盘，
					// 新会话（比沙箱年轻）的 agentTools.active() 收养它（写回 sessionId）→ 从第一 turn 就在沙箱内（自动 in-plan）；
					// 已在运行的老会话不收养（避免劫持），超窗口未认领视为流程中断（可从沙箱历史显式重用）。
					const body = await req.json();
					let cwd = String(body.cwd || "");
					try { cwd = cwd ? fs.realpathSync(cwd) : ""; } catch {}
					if (!cwd) return json({ ok: false, error: "cwd required" }, 400);
					// 幂等：该 cwd 已有无主可认领沙箱则不重复建
					const disk = latestSandboxFor(cwd, { mode: "unowned" });
					if (disk) return json({ ok: true, already: true, tier: disk.meta.tier || "", sandboxDir: disk.sandboxDir });
					const provider = createProvider();
					let handle: SandboxHandle | null = null;
					try { handle = await provider.start(cwd); } catch (e: any) { return json({ ok: false, error: e?.message || String(e) }, 500); }
					persistMeta(handle, provider);
					return json({ ok: true, tier: handle.tier, sandboxDir: handle.sandboxDir });
				}

				if (p[0] === "end" && req.method === "POST") {
					// UI 主动结束：改为「结算前置预览」——只计算快照增量，【不自动全量声明、不销毁】。
					// 客户端先展示 delta 文件清单供用户勾选，再调 /settle(apply|keep) 或 /discard。
					const body = await req.json();
					const sid = String(body.sessionId || "");
					let cwd = String(body.cwd || "");
					try { cwd = cwd ? fs.realpathSync(cwd) : ""; } catch {}
					const act = resolveActiveHandle(sid, cwd);
					if (!act) return json({ ok: false, error: "未找到活跃 plan 沙箱" }, 400);
					const d = await act.provider.delta(act.handle);
					return json({ ok: true, settled: "preview", sandboxDir: act.sandboxDir, delta: d });
				}

				if (p[0] === "preview" && req.method === "POST") {
					// 结算前置预览（只读）：当前会话/工作区活跃沙箱的快照增量，不声明、不销毁。
					// kept/extracted/pending 等非自由写入态不视为 active。
					const body = await req.json().catch(() => ({}));
					const sid = String(body.sessionId || "");
					let cwd = String(body.cwd || "");
					try { cwd = cwd ? fs.realpathSync(cwd) : ""; } catch {}
					if (!cwd) return json({ ok: false, error: "cwd required" }, 400);
					const act = resolveActiveHandle(sid, cwd);
					if (!act) return json({ ok: true, active: false });
					const st0 = readSandboxJson(act.sandboxDir, "review.json")?.status || "";
					if (st0 === "kept" || st0 === "extracted" || st0 === "pending") return json({ ok: true, active: false, status: st0, sandboxDir: act.sandboxDir });
					const d = await act.provider.delta(act.handle);
					return json({ ok: true, active: true, tier: act.handle.tier, sandboxDir: act.sandboxDir, delta: d });
				}

				if (p[0] === "settle" && req.method === "POST") {
					// 结算终态（用户在预览对话框中勾选后）：
					//   mode=apply → 写 manifest/review(pending, declared=选中子集) → applyOne（拷贝+门禁+销毁）
					//   mode=keep  → 只写 manifest/review(kept)，不销毁（沙箱保留，后续可提取/重用/销毁）
					const body = await req.json();
					const sandbox = path.resolve(String(body.sandbox || ""));
					if (!baseDirs().some((b) => isUnder(b, sandbox))) return json({ ok: false, error: "sandbox 路径非法" }, 400);
					const mode = body.mode === "keep" ? "keep" : "apply";
					const files: string[] = (body.files || []).map(String);
					const deletions: string[] = (body.deletions || []).map(String);
					const meta = readSandboxJson(sandbox, "meta.json");
					if (!meta) return json({ ok: false, error: "meta 缺失" }, 404);
					const h = reconstructFromMeta(meta);
					if (!h) return json({ ok: false, error: "沙箱无法重建" }, 400);
					const provider = createProvider();
					const d = await provider.delta(h);
					const modOrAdd = new Set([...d.added, ...d.modified]);
					const del = new Set(d.deleted);
					const bad = [...files.filter((f: string) => !modOrAdd.has(f)), ...deletions.filter((f: string) => !del.has(f))];
					if (bad.length > 0) return json({ ok: false, error: `选择集与快照增量不符：${bad.join(", ")}` }, 400);
					const declared = { files, deletions };
					// 基线指纹在结算时冻结（封存时刻工作区原貌；陈旧恢复分流的安全底线）
					const manifest = {
						files, deletions, summary: String(body.summary || "结算"), gate: body.gate ? String(body.gate) : undefined, notes: body.notes ? String(body.notes) : undefined, ts: Date.now(),
						baseHashes: computeBaseHashes(h.projectDir, [...files, ...deletions, ...d.added, ...d.modified, ...d.deleted]),
						baseTs: Date.now(),
					};
					fs.writeFileSync(path.join(sandbox, "manifest.json"), JSON.stringify(manifest, null, 2));
					fs.writeFileSync(
						path.join(sandbox, "review.json"),
						JSON.stringify({ projectDir: h.projectDir, sandboxDir: sandbox, tier: h.tier, provider: (provider as any).name, status: mode === "keep" ? "kept" : "pending", delta: d, declared, summary: manifest.summary, gate: manifest.gate, notes: manifest.notes, updatedAt: Date.now() }, null, 2),
					);
					if (mode === "keep") return json({ ok: true, kept: true, sandboxDir: sandbox, text: `沙箱已保留（${files.length} 文件、${deletions.length} 删除），可在历史中重新提取/重用/销毁。` });
					return json(await applyOne(sandbox, files, deletions));
				}

				if (p[0] === "extract" && req.method === "POST") {
					// 重新提取：把已保留/已提取沙箱的选中文件拷回真实工作区，保留沙箱（置 extracted）。
					const body = await req.json();
					const sandbox = path.resolve(String(body.sandbox || ""));
					if (!baseDirs().some((b) => isUnder(b, sandbox))) return json({ ok: false, error: "sandbox 路径非法" }, 400);
					return json(await extractKeep(sandbox, (body.files || []).map(String), (body.deletions || []).map(String)));
				}

				if (p[0] === "reuse" && req.method === "POST") {
					// 重用：把已保留/已提取沙箱挂回当前会话（sessionStates），后续模型工具在其快照内工作。
					const body = await req.json();
					const sandbox = path.resolve(String(body.sandbox || ""));
					const sid = String(body.sessionId || "");
					if (!baseDirs().some((b) => isUnder(b, sandbox))) return json({ ok: false, error: "sandbox 路径非法" }, 400);
					if (!sid) return json({ ok: false, error: "sessionId required" }, 400);
					const meta = readSandboxJson(sandbox, "meta.json");
					if (!meta) return json({ ok: false, error: "meta 缺失" }, 404);
					const h = reconstructFromMeta(meta);
					if (!h) return json({ ok: false, error: "沙箱无法重建" }, 400);
					const s = sessionState(sid);
					s.provider = createProvider();
					s.handle = h;
					// 归属写回（强制覆盖旧主）：重用是显式转移，不写回则重启/热重载后沙箱脱钩孤悬
					adoptSandbox(sandbox, sid, true);
					// 重用后回到自由写入态：review.status 从 kept/extracted 置回 active（历史不再显示为已保留）
					const review = readSandboxJson(sandbox, "review.json");
					if (review && (review.status === "kept" || review.status === "extracted")) {
						review.status = "active";
						review.updatedAt = Date.now();
						try { fs.writeFileSync(reviewPath(sandbox), JSON.stringify(review, null, 2)); } catch {}
					}
					return json({ ok: true, tier: h.tier, sandboxDir: sandbox, text: `沙箱已重用（${sandbox}），后续模型工具将在其快照内工作。` });
				}

				if (p[0] === "history" && req.method === "POST") {
					// 当前工作区遗留沙箱历史（含 active/pending/kept/extracted；已销毁不出现）。
					const body = await req.json().catch(() => ({}));
					let cwd = String(body.cwd || "");
					try { cwd = cwd ? fs.realpathSync(cwd) : ""; } catch {}
					if (!cwd) return json({ ok: false, error: "cwd required" }, 400);
					return json({ ok: true, sandboxes: await listHistoryByCwd(cwd) });
				}

				if (p[0] === "file" && req.method === "POST") {
					const body = await req.json().catch(() => ({}));
					const sandbox = path.resolve(String(body.sandbox || ""));
					const relRaw = String(body.rel || "");
					const side = String(body.side || "rev");
					if (!isUnder(baseDirs()[0] || "/nonexistent", sandbox) && !baseDirs().some((b) => isUnder(b, sandbox))) return json({ ok: false, error: "sandbox 路径非法" }, 400);
					const rel = path.normalize(relRaw).replace(/^(\.\.(\/|\\|$))+/, "");
					if (rel.startsWith("..") || path.isAbsolute(rel)) return json({ ok: false, error: "rel 非法" }, 400);
					let p2: string;
					if (side === "rev") {
						const view = viewRoot(sandbox);
						if (!view) return json({ ok: false, error: "快照视图缺失" }, 404);
						p2 = path.join(view, rel);
						if (!isUnder(view, p2)) return json({ ok: false, error: "rel 非法" }, 400);
					} else {
						const meta = readFileSafe(path.join(sandbox, "meta.json"));
						const projectDir = meta ? JSON.parse(meta).projectDir : null;
						if (!projectDir) return json({ ok: false, error: "meta 缺失" }, 404);
						p2 = path.join(projectDir, rel);
						if (!isUnder(projectDir, p2)) return json({ ok: false, error: "rel 非法" }, 400);
					}
					const content = readFileSafe(p2);
					if (content === null) return json({ ok: false, error: "文件不存在" }, 404);
					return json({ ok: true, content });
				}

				if (p[0] === "apply" && req.method === "POST") {
					const body = await req.json();
					const sandbox = path.resolve(String(body.sandbox || ""));
					if (!baseDirs().some((b) => isUnder(b, sandbox))) return json({ ok: false, error: "sandbox 路径非法" }, 400);
					return json(await applyOne(sandbox, body.files || [], body.deletions || []));
				}

				if (p[0] === "discard" && req.method === "POST") {
					const body = await req.json();
					const sandbox = path.resolve(String(body.sandbox || ""));
					if (!baseDirs().some((b) => isUnder(b, sandbox))) return json({ ok: false, error: "sandbox 路径非法" }, 400);
					rmRfSafe(sandbox);
					return json({ ok: true, text: "已丢弃并销毁。" });
				}

				return json({ ok: false, error: "unknown endpoint" }, 404);
			} catch (e: any) {
				return json({ ok: false, error: e?.message || String(e) }, 500);
			}
		},
	},
};

