/**
 * pi-plan-sandbox — Plan-Sandbox 模式
 *
 * 全工具放行 + 执行发生在可丢弃快照 + declare_deliverables 硬协议采认 + 其余销毁。
 * 平台：Linux(overlayfs, 已验证) / macOS(clonefile+seatbelt) / Windows(robocopy)。
 *
 * 用法：/plan-sandbox start 开启 → 正常对话规划 → AI 调 declare_deliverables → 采认/丢弃。
 */
import path from "node:path";
import fs from "node:fs";
import { Type } from "typebox";
import * as piPkg from "@earendil-works/pi-coding-agent";

// pi 0.84.x 的扩展加载器（jiti）下，命名导入的工具工厂绑定不可调用（ReferenceError），
// 必须用 import * as piPkg + 解构（实测结论，勿改回命名导入）。
const createToolFactory = (name: string): any => (piPkg as any)[`create${name}Tool`];
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProvider, rmRfSafe, sandboxBaseDir, type SandboxHandle, type SandboxProvider, type Delta } from "./providers.ts";
import { acceptWithSplit, computeBaseHashes, conflictLines, handleViewRoot, stalenessHint } from "./accept-core.ts";
import { buildBashOps, buildEditOps, buildFindOps, buildLsOps, buildReadOps, buildWriteOps, executeGrep } from "./ops.ts";
import { LocalView, MergedView } from "./fsview.ts";
import { deliverableProtocol, formatManifest, manifestIssues, type DeliverableManifest } from "./protocol.ts";
import { acceptResumed, discardResumed, findResumable, othersOf, persistManifest, persistMeta, reconstructHandle, traceApi, writeReview, type PersistedMeta } from "./resume.ts";
import { missionDeclare, missionResolve, missionStart, persistMissionId } from "./mission.ts";

// ---------------- 状态 ----------------

type Phase = "idle" | "active" | "delivered";
const state: {
	phase: Phase;
	provider?: SandboxProvider;
	handle?: SandboxHandle;
	manifest?: DeliverableManifest;
} = { phase: "idle" };

function isActive(): boolean {
	return state.phase !== "idle" && !!state.handle;
}

function resetState(): void {
	state.phase = "idle";
	state.handle = undefined;
	state.manifest = undefined;
}

// ---- 循环护栏（2026-08-30 session eccffb90 教训）：连续无操作命令注入出口提示 ----
const LOOP = { run: 0 };
const NOOP_RE = /^\s*(?:true|:|echo\s+[^;&|<>`$]{1,80})\s*$/i;
const loopHint = (n: number) =>
	`\n[plan-sandbox] ⚠ 已连续 ${n} 次无操作命令（true/echo 占位）。你在等待的那个工具调用【并没有发生】——bash 只是执行了文本，不会替你发出它。`
	+ `若计划已完成：调用 declare_deliverables（无文件交付的任务 files=[] 即可）；若任务无法继续：调用 plan_abort(reason) 中止并退出沙箱。不要再用占位命令。`;

// ---------------- 采认流程 ----------------

function deltaSummary(d: Delta): string {
	return `+${d.added.length} 新增 / ~${d.modified.length} 修改 / -${d.deleted.length} 删除`;
}

/** 声明/结算时冻结基线指纹：覆盖「采认可能动到的工作区既有文件」∪ 全部增量（added 记 null 标记） */
function withBaseHashes(projectDir: string, m: DeliverableManifest, delta: Delta): DeliverableManifest {
	return {
		...m,
		baseHashes: computeBaseHashes(projectDir, [...m.files, ...m.deletions, ...delta.added, ...delta.modified, ...delta.deleted]),
		baseTs: Date.now(),
	};
}

async function doAccept(ctx: ExtensionContext | undefined): Promise<string> {
	const provider = state.provider!;
	const h = state.handle!;
	const m = state.manifest!;
	// 重新校验：声明之后快照可能又变了
	try {
		const d = await provider.delta(h);
		const issues = manifestIssues(d, m, h.projectDir);
		if (issues.length > 0) {
			return `[plan-sandbox] 采认中止：声明与当前快照不符：\n- ${issues.join("\n- ")}\n请让 AI 重新调用 declare_deliverables。`;
		}
	} catch {}
	// 采认落 trace（pi-git-trace 三钩子；缺席判空降级，绝不阻断采认）
	const trace = traceApi();
	let rec: string | null = null;
	try {
		rec = (await trace?.begin?.({ projectDir: h.projectDir, sandboxDir: h.sandboxDir, summary: m.summary, files: m.files, deletions: m.deletions })) ?? null;
	} catch {}
	const { report, gate: gateResult, reverted, conflicts } = await acceptWithSplit(provider, h, m.files, m.deletions, {
		gate: m.gate,
		base: m,
		viewRoot: handleViewRoot(h),
	});
	missionResolve(h.sandboxDir, h.projectDir, reverted ? "rolledback" : "accepted", gateResult?.output ? gateResult.output.slice(-200) : undefined);
	try {
		await trace?.end?.(rec, {
			outcome: reverted ? "rolledback" : "accepted",
			projectDir: h.projectDir, sandboxDir: h.sandboxDir, summary: m.summary, files: m.files, deletions: m.deletions,
			conflicts: conflicts.map((c) => c.rel),
			mission: (() => { try { return JSON.parse(fs.readFileSync(path.join(h.sandboxDir, "mission.json"), "utf8")).id ?? null; } catch { return null; } })(),
		});
	} catch {}
	await provider.destroy(h).catch(() => {});
	const lines: string[] = [];
	if (reverted) {
		lines.push(`[plan-sandbox] 门禁未通过，已整单回滚（真实工作区恢复原状），沙箱已销毁。`);
		if (gateResult && gateResult.output) lines.push("门禁输出（尾部）：", gateResult.output.split("\n").slice(-15).join("\n"));
	} else {
		lines.push(`[plan-sandbox] 采认完成：${report.copied.length} 个文件已写入真实工作区，${report.deleted.length} 个文件已删除，沙箱已销毁。`);
		if (gateResult) lines.push(`门禁通过：${m.gate}`);
	}
	lines.push(...conflictLines(conflicts));
	const stale = stalenessHint(m.baseTs);
	if (stale) lines.push(stale);
	if (report.failed.length > 0) {
		lines.push(`失败 ${report.failed.length} 项：`, ...report.failed.slice(0, 10).map((f) => `  ${f.path}: ${f.error}`));
	}
	if (!reverted && !gateResult) lines.push(`建议在真实工作区复跑门禁验证（如 npm test）。`);
	resetState();
	ctx?.ui.setStatus("plan-sandbox", undefined);
	return lines.join("\n");
}

async function doDiscard(ctx: ExtensionContext | undefined): Promise<string> {
	const provider = state.provider!;
	const h = state.handle!;
	try {
		await traceApi()?.note?.({ outcome: "discarded", projectDir: h.projectDir, sandboxDir: h.sandboxDir, summary: "丢弃沙箱" });
	} catch {}
	missionResolve(h.sandboxDir, h.projectDir, "discarded");
	await provider.destroy(h).catch(() => {});
	resetState();
	ctx?.ui.setStatus("plan-sandbox", undefined);
	return "[plan-sandbox] 已全部丢弃，沙箱销毁，真实工作区未受影响。";
}

// ---------------- 扩展入口 ----------------

const __DBG = "/tmp/psb-debug.log";
function dbg(msg: string): void {
	try {
		fs.appendFileSync(__DBG, `${new Date().toISOString()} [${__psbInst}] ${msg}\n`);
	} catch {}
}
const __psbInst = Math.random().toString(36).slice(2, 6);

const realpathSafe = (p: string): string => {
	try { return fs.realpathSync(p); } catch { return p; }
};

type ResolvedSandbox = { handle: SandboxHandle; provider: SandboxProvider; manifest: DeliverableManifest | null; fromDisk: boolean };

/**
 * 按会话目录解析活跃沙箱：优先进程内 state（projectDir 匹配），否则从磁盘 meta.json 认领。
 *
 * pi-web 场景（2026-08-30 /plan 命令失效复盘）：沙箱由 web 注入工具（aiti-plan-review agentTools）
 * 启动，活在 web 侧内存态；但 persistMeta 已落盘。pi 扩展命令面据此认领，消除双脑状态。
 * adopt=true 时写入进程内 state（后续 doAccept/doDiscard 直接操作 state）。
 */
function resolveSandbox(dir: string, opts?: { adopt?: boolean }): ResolvedSandbox | null {
	if (state.handle && state.provider && state.handle.projectDir === dir) {
		return { handle: state.handle, provider: state.provider, manifest: state.phase === "delivered" ? state.manifest ?? null : null, fromDisk: false };
	}
	try {
		const base = sandboxBaseDir();
		let best: { meta: PersistedMeta; ts: number } | null = null;
		for (const d of fs.readdirSync(base)) {
			const sd = path.join(base, d);
			let meta: PersistedMeta;
			try { meta = JSON.parse(fs.readFileSync(path.join(sd, "meta.json"), "utf8")); } catch { continue; }
			if (meta.projectDir !== dir) continue;
			const ts = meta.createdAt ?? 0;
			if (!best || ts > best.ts) best = { meta, ts };
		}
		if (!best) return null;
		const handle = reconstructHandle(best.meta);
		if (!handle) return null;
		const provider = createProvider();
		let manifest: DeliverableManifest | null = null;
		try { manifest = JSON.parse(fs.readFileSync(path.join(handle.sandboxDir, "manifest.json"), "utf8")); } catch {}
		if (opts?.adopt) {
			state.handle = handle;
			state.provider = provider;
			state.phase = manifest ? "delivered" : "active";
			state.manifest = manifest ?? undefined;
		}
		return { handle, provider, manifest, fromDisk: true };
	} catch { return null; }
}

export default function planSandboxExtension(pi: ExtensionAPI): void {
	dbg("factory called");
	const g = globalThis as any;
	// 守卫只护工具注册（dec439e：同进程双路径加载 → Tool "bash" conflicts → 整个扩展加载失败）。
	// 命令与钩子每次 factory 都注册（try/catch 兜底同名冲突）：pi-web 常驻进程每个会话独立
	// ExtensionRunner，全局 no-op 会导致 2nd+ 会话永远没有 /plan 命令（2026-08-30 /plan 失效根因）。
	const firstLoad = !g.__planSandboxLoaded;
	g.__planSandboxLoaded = true;
	// realpath：resume 匹配、delta 归一化都依赖与 meta.json 一致的规范路径。
	// 注意：pi-web 场景下这只是服务器进程 cwd，命令面一律用运行时 ctx.cwd（会话目录）。
	const projectDir = fs.realpathSync(process.cwd());

	// 工具注册仅首次（守卫）；命令/钩子每次都注册（见上注释）
	const registerToolFirstLoad = (tool: any): void => { if (firstLoad) pi.registerTool(tool); };

	// ---- 工具覆盖（idle 时全部透传内置实现） ----

	// 动态键取工厂：工具覆盖集的增删不再依赖手工同步解构列表（此前两次被重写弄丢）
	const mk = (name: string): any => createToolFactory(name)(projectDir);
	const localRead = mk("Read");
	const localWrite = mk("Write");
	const localEdit = mk("Edit");
	const localBash = mk("Bash");
	const localLs = mk("Ls");
	const localFind = mk("Find");
	const localGrep = mk("Grep");

	function passthrough<T extends { execute: (...a: any[]) => any }>(tool: T, id: string, params: any, signal: any, onUpdate: any) {
		return (tool as any).execute(id, params, signal, onUpdate);
	}

	registerToolFirstLoad({
		...localRead,
		async execute(id: string, params: any, signal: any, onUpdate: any) {
			if (!isActive()) return passthrough(localRead, id, params, signal, onUpdate);
			const tool = createToolFactory("Read")(projectDir, { operations: buildReadOps(state.handle!) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	registerToolFirstLoad({
		...localWrite,
		async execute(id: string, params: any, signal: any, onUpdate: any) {
			if (!isActive()) return passthrough(localWrite, id, params, signal, onUpdate);
			const tool = createToolFactory("Write")(projectDir, { operations: buildWriteOps(state.handle!) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	registerToolFirstLoad({
		...localEdit,
		async execute(id: string, params: any, signal: any, onUpdate: any) {
			if (!isActive()) return passthrough(localEdit, id, params, signal, onUpdate);
			const tool = createToolFactory("Edit")(projectDir, { operations: buildEditOps(state.handle!) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	registerToolFirstLoad({
		...localBash,
		async execute(id: string, params: any, signal: any, onUpdate: any, ctx?: ExtensionContext) {
			const result: any = isActive()
				? await createToolFactory("Bash")(projectDir, { operations: buildBashOps(state.handle!, state.provider!) }).execute(id, params, signal, onUpdate, ctx)
				: await passthrough(localBash, id, params, signal, onUpdate);
			if (NOOP_RE.test(String(params?.command || ""))) {
				LOOP.run++;
				if (isActive() && LOOP.run >= 3 && Array.isArray(result?.content)) {
					result.content.push({ type: "text", text: loopHint(LOOP.run) });
				}
			} else {
				LOOP.run = 0;
			}
			return result;
		},
	});

	registerToolFirstLoad({
		...localLs,
		async execute(id: string, params: any, signal: any, onUpdate: any) {
			if (!isActive()) return passthrough(localLs, id, params, signal, onUpdate);
			const tool = createToolFactory("Ls")(projectDir, { operations: buildLsOps(state.handle!) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	registerToolFirstLoad({
		...localFind,
		async execute(id: string, params: any, signal: any, onUpdate: any) {
			if (!isActive()) return passthrough(localFind, id, params, signal, onUpdate);
			const tool = createToolFactory("Find")(projectDir, { operations: buildFindOps(state.handle!) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	registerToolFirstLoad({
		...localGrep,
		async execute(id: string, params: GrepToolInput, signal: any, onUpdate: any) {
			if (!isActive()) return passthrough(localGrep, id, params, signal, onUpdate);
			return executeGrep(state.handle!, params, signal);
		},
	});

	// ---- plan_start：模型自主激活入口（用户说"做个计划/方案"时由模型调用） ----

	registerToolFirstLoad({
		name: "plan_start",
		label: "plan_start",
		description:
			"进入 Plan-Sandbox 模式。当用户要求你【制定计划/方案/规划】、评估实现思路、探索方案可行性（而不是直接动手改代码）时调用本工具。"
			+ "激活后：所有文件写入与命令执行都在隔离沙箱中（真实工作区不受影响），你可以放心实验、跑测试验证假设；"
			+ "计划完成时必须调用 declare_deliverables 声明交付物，由用户采认后才落盘。若用户明确要求直接实现/修改，则不要调用本工具。",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx?: ExtensionContext) {
			if (isActive()) {
				return { content: [{ type: "text" as const, text: `Plan-Sandbox 已激活（tier=${state.handle!.tier}）。继续规划即可。` }], details: undefined };
			}
			if (!state.provider) state.provider = createProvider();
			try {
				await startSandbox(ctx, ctx?.cwd);
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: `Plan-Sandbox 激活失败：${e?.message || e}` }], details: undefined };
			}
			if (!isActive()) {
				return { content: [{ type: "text" as const, text: "Plan-Sandbox 激活失败（详见启动错误）。" }], details: undefined };
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Plan-Sandbox 已激活（tier=${state.handle!.tier}）。\n真实工作区: ${state.handle!.projectDir}\n现在所有写入与命令都在隔离沙箱内。请开始规划：自由探索、实验、跑测试验证假设；计划完成时调用 declare_deliverables 声明交付物（无文件交付的任务 files=[] 即可）。任务无法继续时调用 plan_abort(reason) 中止并退出（沙箱销毁，真实工作区不受影响）。`,
					},
				],
				details: undefined,
			};
		},
	});

	// ---- declare_deliverables 硬出口 ----

	registerToolFirstLoad({
		name: "declare_deliverables",
		label: "declare_deliverables",
		description:
			"声明 plan 交付物并结束 plan-sandbox 计划。files=要采认进真实工作区的项目相对路径；deletions=要从真实工作区删除的文件；未声明内容随沙箱销毁。",
		parameters: Type.Object({
			files: Type.Array(Type.String({ description: "项目相对路径，如 src/a.ts" }), { description: "交付文件清单（自洽集合）" }),
			deletions: Type.Optional(Type.Array(Type.String()), { description: "要删除的文件清单" }),
			summary: Type.String({ description: "一句话说明计划/结论" }),
				gate: Type.Optional(Type.String(), { description: '采认后在真实工作区执行的验证命令（如 "npm test"）；失败将整单回滚' }),
			notes: Type.Optional(Type.String(), { description: "补充说明：风险、依赖、验证结果" }),
		}),
		async execute(_id, params: any, _signal, _onUpdate, ctx?: ExtensionContext) {
			if (!isActive() || !state.provider || !state.handle) {
				return { content: [{ type: "text" as const, text: "plan-sandbox 未激活，无法声明交付物。" }], details: undefined };
			}
			const manifest: DeliverableManifest = {
				files: [...new Set((params.files as string[]) || [])],
				deletions: [...new Set((params.deletions as string[]) || [])],
				summary: String(params.summary ?? ""),
				gate: params.gate ? String(params.gate) : undefined,
				notes: params.notes ? String(params.notes) : undefined,
				ts: Date.now(),
			};

			let delta: Delta;
			try {
				delta = await state.provider.delta(state.handle);
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: `delta 计算失败：${e?.message || e}` }], details: undefined };
			}
			// 基线指纹在声明时冻结（封存时刻工作区原貌；陈旧恢复分流的安全底线）
			const frozen = withBaseHashes(projectDir, manifest, delta);
			const issues = manifestIssues(delta, frozen, projectDir);
			if (issues.length > 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `声明校验失败，请修正后重新调用 declare_deliverables：\n- ${issues.join("\n- ")}\n当前增量：${deltaSummary(delta)}`,
						},
					],
					details: undefined,
				};
			}
			state.manifest = frozen;
			state.phase = "delivered";

			const summaryText = `${formatManifest(frozen)}\n快照增量：${deltaSummary(delta)}`;
			let userChoice: string | undefined;
			const ui = ctx?.ui;
			if (typeof ui?.confirm === "function") {
				const ok = await ui.confirm("采认交付物到真实工作区？", summaryText);
				if (ok && manifest.deletions.length > 0) {
					// 删除逐项显式确认：任一拒绝则该项不采认
					for (const d of [...manifest.deletions]) {
						const yes = await ui.confirm(`删除确认：${d}`, "该删除将应用到真实工作区。");
						if (!yes) manifest.deletions = manifest.deletions.filter((x) => x !== d);
					}
				}
				if (!ok) {
					if (typeof ui.select === "function") {
						userChoice = (await ui.select("不采认。沙箱如何处理？", ["保留沙箱（稍后 /plan-sandbox accept|discard）", "全部丢弃并关闭"])) ?? "keep";
					} else {
						userChoice = "keep";
					}
				} else {
					userChoice = "accept";
				}
			} else {
				// 无 UI（print/RPC 等）：绝不自动采认，落盘留待用户手动处理
				userChoice = "keep";
			}

			try {
				if (userChoice === "accept") return { content: [{ type: "text" as const, text: await doAccept(ctx) }], details: undefined };
				if (userChoice?.startsWith("全部丢弃")) return { content: [{ type: "text" as const, text: await doDiscard(ctx) }], details: undefined };
				persistMeta(state.handle!, state.provider!);
				persistManifest(state.handle!, state.manifest!);
				try {
					const d2 = await state.provider!.delta(state.handle!);
					writeReview(state.handle!, state.provider!, state.manifest!, d2);
				} catch {}
				missionDeclare(state.handle!.sandboxDir, projectDir, state.manifest!);
				return {
					content: [
						{
							type: "text" as const,
							text: `[plan-sandbox] 交付物已记录并落盘，沙箱保留。可随时：/plan-sandbox accept 采认，或 /plan-sandbox discard 丢弃（跨会话有效）。`,
						},
					],
					details: undefined,
				};
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: `[plan-sandbox] 处理失败：${e?.message || e}（沙箱保留，可重试 /plan-sandbox accept）` }], details: undefined };
			}
		},
	});

	// ---- plan_abort：失败出口（中止并退出，沙箱销毁） ----

	registerToolFirstLoad({
		name: "plan_abort",
		label: "plan_abort",
		description:
			"中止并退出 Plan-Sandbox 模式（失败出口）：销毁沙箱（全部未采认内容丢弃，真实工作区不受影响），回到正常模式。"
			+ "当你发现自己在反复执行无意义命令、陷入循环、方案走不通、或判断任务无法完成时调用；调用后立即向用户如实说明中止原因与已验证结论。"
			+ "不要用 bash/echo 尝试退出模式——出口只有两个：declare_deliverables（成功收尾）与本工具（失败中止）。",
		parameters: Type.Object({ reason: Type.String({ description: "中止原因（一句话，展示给用户）" }) }),
		async execute(_id, params: any, _signal, _onUpdate, ctx?: ExtensionContext) {
			if (!isActive() || !state.provider || !state.handle) {
				return { content: [{ type: "text" as const, text: "Plan-Sandbox 未激活，无需中止。" }], details: undefined };
			}
			const reason = String(params?.reason || "未说明").slice(0, 500);
			missionResolve(state.handle.sandboxDir, state.handle.projectDir, "discarded", reason);
			await state.provider.destroy(state.handle).catch(() => {});
			resetState();
			ctx?.ui.setStatus("plan-sandbox", undefined);
			return {
				content: [{
					type: "text" as const,
					text: `Plan-Sandbox 已中止（原因：${reason}）。沙箱已销毁，未采认内容全部丢弃，真实工作区未受任何影响。\n你现在已回到正常模式（无沙箱，所有工具恢复真实工作区语义）。请立即停止原计划的循环动作，向用户如实报告：①中止原因 ②已验证的结论/发现 ③建议的下一步。除非用户明确要求，不要再次调用 plan_start。`,
				}],
				details: undefined,
			};
		},
	});

	// ---- 命令 ----

	async function startSandbox(ctx: ExtensionContext, forDir?: string): Promise<void> {
		const dir = forDir ? realpathSafe(forDir) : projectDir;
		if (state.handle && state.provider && state.handle.projectDir === dir) {
			ctx.ui.notify(`plan-sandbox 已激活（tier=${state.handle.tier}）。`, "info");
			return;
		}
		ctx.ui.setStatus("plan-sandbox", "starting…");
		try {
			const provider = createProvider();
			const handle = await provider.start(dir);
			state.provider = provider;
			state.handle = handle;
			state.phase = "active";
			persistMeta(handle, provider);
			// P1-1 尾巴（lineage-closure）：透传真实会话 id 进 mission 归因（ownerSessionId）
			const ownerSid = (() => { const v = (ctx as any)?.sessionManager?.getSessionId?.(); return v ? String(v) : null; })();
			const missionId = missionStart(dir, handle.tier, ownerSid);
			persistMissionId(handle.sandboxDir, missionId);
			ctx.ui.setStatus("plan-sandbox", `\ud83d\udee1 ${handle.tier}`);
			ctx.ui.notify(`plan-sandbox \u5df2\u6fc0\u6d3b\uff08tier=${handle.tier}\uff09\u3002\u771f\u5b9e\u5de5\u4f5c\u533a: ${handle.projectDir}\uff0c\u76f4\u63a5\u63cf\u8ff0\u4efb\u52a1\u5373\u53ef\u3002`, "info");
		} catch (e: any) {
			ctx.ui.setStatus("plan-sandbox", undefined);
			console.error("[plan-sandbox] \u542f\u52a8\u5931\u8d25：", e?.stack || e?.message || e);
			ctx.ui.notify?.(`plan-sandbox \u542f\u52a8\u5931\u8d25：${e?.message || e}`, "error");
		}
	}

	const PLAN_SUBS = new Set(["start", "status", "accept", "discard", "off", "execute", "exit", "pause", "review", "cleanup"]);
	const stripQuotes = (s: string): string => {
		const t = s.trim();
		const pairs: Array<[string, string]> = [["\"", "\""], ["'", "'"], ["\u201c", "\u201d"], ["\u300c", "\u300d"]];
		for (const [a, b] of pairs) {
			if (t.length >= 2 && t.startsWith(a) && t.endsWith(b)) return t.slice(1, -1).trim();
		}
		return t;
	};
	const planCommandHandler = async (args: string | undefined, ctx: ExtensionContext): Promise<void> => {
		// 会话目录：pi-web 下 ≠ 服务器进程 cwd，命令面一律以会话 cwd 为准
		const dir = realpathSafe(ctx?.cwd || projectDir);
		const trimmed = (args || "").trim();
		const sub = trimmed.split(/\s+/)[0] || "";
		// /plan <提示词>：进入（或确认）规划沙箱后，把提示词原样交给模型开跑
		if (!PLAN_SUBS.has(sub)) {
			const prompt = stripQuotes(trimmed);
			if (!prompt) {
				ctx.ui.notify(`plan-sandbox: 未激活。/plan start 开启，或 /plan <提示词> 直接进入规划。`, "info");
				return;
			}
			if (!resolveSandbox(dir)) await startSandbox(ctx, dir);
			if (typeof (pi as any).sendUserMessage !== "function") {
				ctx.ui.notify("plan-sandbox: 当前 SDK 无 sendUserMessage，无法转发提示词。", "error");
				return;
			}
			(pi as any).sendUserMessage(prompt, { deliverAs: "steer" });
			return;
		}
		switch (sub) {
			case "start": {
				dbg(`cmd start -> startSandbox dir=${dir}`);
				const rest = stripQuotes(trimmed.slice(sub.length));
				if (resolveSandbox(dir)) {
					if (!rest) {
						ctx.ui.notify(`plan-sandbox: 该目录已有活跃沙箱（${dir}）。/plan status 查看，/plan discard 丢弃。`, "warning");
						return;
					}
					// 已激活 + 尾随提示词：直接转发提示词
				} else {
					await startSandbox(ctx, dir);
					dbg(`cmd start done, phase=${state.phase} handle=${!!state.handle}`);
				}
				if (rest && typeof (pi as any).sendUserMessage === "function") {
					(pi as any).sendUserMessage(rest, { deliverAs: "steer" });
				}
				return;
			}
			case "status": {
				const r = resolveSandbox(dir);
				if (!r) {
					const res = findResumable(dir);
					ctx.ui.notify(
						res
							? `plan-sandbox: 未激活。发现保留的沙箱（含交付物）：${res.sandboxDir}\n/plan-sandbox accept 采认 | discard 丢弃。`
							: `plan-sandbox: 未激活。/plan-sandbox start 开启。`,
						"info",
						);
					return;
				}
				let deltaText = "";
				try {
					deltaText = deltaSummary(await r.provider.delta(r.handle));
				} catch (e: any) {
					deltaText = `delta 失败: ${e?.message || e}`;
				}
				ctx.ui.notify(
					[
						`plan-sandbox: ${r.manifest ? "delivered" : "active"}（tier=${r.handle.tier}${r.fromDisk ? "，已从磁盘认领" : ""}）`,
						`真实工作区: ${r.handle.projectDir}`,
						`沙箱目录: ${r.handle.sandboxDir}`,
						`快照增量: ${deltaText}`,
						r.manifest ? `已声明交付物:\n${formatManifest(r.manifest)}` : `交付物: 未声明`,
					].join("\n"),
					"info",
				);
				return;
			}
			case "accept": {
				if (resolveSandbox(dir, { adopt: true }) && state.phase === "delivered" && state.manifest) {
					ctx.ui.notify(await doAccept(ctx), "info");
					return;
				}
				// 跨会话 resume：从落盘的 meta/manifest 重建采认
				ctx.ui.notify(await acceptResumed(dir), "info");
				return;
			}
			case "execute": {
				// 用户批准计划并开始执行：采认交付物（未声明则采认全部增量）+ 退出沙箱
				if (!resolveSandbox(dir, { adopt: true }) || !state.provider || !state.handle) {
					ctx.ui.notify("plan-sandbox 未激活。", "warning");
					return;
				}
				const d = await state.provider.delta(state.handle);
				if (!state.manifest) {
					// 未声明：全部增量作为交付物（交互确认；无 UI 拒绝并要求先声明）
					if (typeof ctx.ui.confirm !== "function") {
						ctx.ui.notify("未声明交付物。请让 AI 先调用 declare_deliverables 后再 /execute。", "warning");
						return;
					}
					const total = d.added.length + d.modified.length;
					const okAll = await ctx.ui.confirm(
						"未声明交付物。",
						`将采认全部增量（+${d.added.length}/~${d.modified.length}/-${d.deleted.length}）并进入执行模式？`,
					);
					if (!okAll) return;
					state.manifest = withBaseHashes(dir, { files: [...d.added, ...d.modified], deletions: [...d.deleted], summary: "/execute 全量采认", ts: Date.now() }, d);
					void total;
				}
				await doAccept(ctx);
				ctx.ui.notify("已采认并进入执行模式：工具已恢复真实工作区，可以继续执行后续任务。", "info");
				return;
			}
			case "discard":
			case "off": {
				if (!resolveSandbox(dir, { adopt: true })) {
					ctx.ui.notify(await discardResumed(dir), "info");
					return;
				}
				const ok = typeof ctx.ui.confirm === "function" ? await ctx.ui.confirm("丢弃沙箱？", "未采认的全部内容将销毁。") : true;
				if (ok) ctx.ui.notify(await doDiscard(ctx), "info");
				return;
			}
			case "review": {
				// TUI 收尾：声明交付物预选确认 + 未声明"其他"逐个点选
				const res = findResumable(dir);
				if (!res) {
					ctx.ui.notify("没有保留的沙箱。", "info");
					return;
				}
				const h = reconstructHandle(res.meta);
				if (!h) {
					ctx.ui.notify("保留沙箱无法重建。", "error");
					return;
				}
				try {
					const provider = createProvider();
					const d = await provider.delta(h);
					const others = othersOf(d, res.manifest);
					const selFiles = [...res.manifest.files];
					const selDel = [...res.manifest.deletions];
					if (typeof ctx.ui.confirm === "function") {
						const ok = await ctx.ui.confirm(
							"声明交付物（预选）",
							`${res.manifest.summary}\nfiles: ${selFiles.join(", ") || "无"}\ndeletions: ${selDel.join(", ") || "无"}`,
						);
						if (!ok) {
							selFiles.length = 0;
							selDel.length = 0;
						}
					}
					for (const f of [...others.added, ...others.modified]) {
						if (typeof ctx.ui.confirm === "function") {
							if (await ctx.ui.confirm(`未声明的"其他"变更：${f}`, "也一并采认？")) selFiles.push(f);
						}
					}
					for (const f of others.deleted) {
						if (typeof ctx.ui.confirm === "function") {
							if (await ctx.ui.confirm(`未声明的"其他"删除：${f}`, "也一并应用删除？")) selDel.push(f);
						}
					}
					const { applyReviewSelection } = await import("./resume.ts");
					ctx.ui.notify(await applyReviewSelection(projectDir, res.sandboxDir, selFiles, selDel), "info");
				} catch (e: any) {
					ctx.ui.notify(`review 失败：${e?.message || e}`, "error");
				}
				return;
			}
			case "exit":
			case "pause": {
				// 退出但挂起保留：沙箱连增量落盘，稍后 /plan review 或 pi-web 采认页处理
				if (!resolveSandbox(dir, { adopt: true })) {
					ctx.ui.notify(await discardResumed(dir), "info");
					return;
				}
				const provider = state.provider!;
				const h = state.handle!;
				try {
					const d = await provider.delta(h);
					const m0 = state.manifest ?? { files: [], deletions: [], summary: "未声明（暂停保留）", ts: Date.now() };
					const m = withBaseHashes(dir, m0, d);
					persistMeta(h, provider);
					persistManifest(h, m);
					writeReview(h, provider, m, d);
					missionDeclare(h.sandboxDir, dir, m);
				} catch {}
				const kept = h.sandboxDir;
				resetState();
				ctx.ui.setStatus("plan-sandbox", undefined);
				ctx.ui.notify(`plan-sandbox 已退出，沙箱挂起保留：${kept}\n/plan review 点选采认，或 pi-web 采认页处理；/plan discard 丢弃。`, "info");
				return;
			}
			case "cleanup": {
				const baseDir = sandboxBaseDir();
				let n = 0;
				try {
					for (const d of fs.readdirSync(baseDir)) {
						const pd = path.join(baseDir, d);
						const st = fs.statSync(pd);
						if (Date.now() - st.mtimeMs > 24 * 3600 * 1000) {
							await rmRfSafe(pd);
							if (!fs.existsSync(pd)) n++;
						}
					}
				} catch {}
				ctx.ui.notify(`cleanup: 清理了 ${n} 个超过 24h 的残留沙箱。`, "info");
				return;
			}
			default:
				ctx.ui.notify(`plan-sandbox: 未知用法。/plan <提示词> 进入规划；子命令：start | status | accept | discard | execute | exit | review | cleanup`, "warning");
		}
	};

	try {
		pi.registerCommand("plan", {
			description: "Plan-Sandbox 模式：/plan <提示词> 直接进入规划；子命令 start|execute|exit|status|accept|discard|review|cleanup",
			handler: planCommandHandler,
		});
		// 兼容别名
		pi.registerCommand("plan-sandbox", {
			description: "Plan-Sandbox 模式（/plan 别名）",
			handler: planCommandHandler,
		});
	} catch (e: any) {
		dbg(`registerCommand dup/conflict: ${e?.message || e}`); // 同 runner 重复注册（dec439e 场景）静默
	}

	// ---- 钩子 ----

	pi.on("session_start", async (_event, ctx) => {
		// 自动激活：PI_PLAN_SANDBOX=1（自动化/print 模式等无法执行斜杠命令的场景）
		if (process.env.PI_PLAN_SANDBOX === "1" && !isActive()) {
			await startSandbox(ctx);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const dir = ctx?.cwd ? realpathSafe(ctx.cwd) : projectDir;
		// 只读解析（不 adopt）：web 注入工具启动的沙箱（meta.json 在盘）同样注入协议，
		// 修复 pi-web 会话每轮系统提示缺失出口协议的问题
		const r = resolveSandbox(dir);
		if (!r) return undefined;
		const protocol = deliverableProtocol(dir, r.handle.tier);
		return { systemPrompt: `${event.systemPrompt}\n\n${protocol}` };
	});

	pi.on("user_bash", async (_event, ctx) => {
		const dir = ctx?.cwd ? realpathSafe(ctx.cwd) : projectDir;
		const r = resolveSandbox(dir, { adopt: true });
		if (!r) return undefined;
		return { operations: buildBashOps(r.handle, r.provider) };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!isActive() || !state.provider || !state.handle) return;
		const dir = ctx?.cwd ? realpathSafe(ctx.cwd) : projectDir;
		if (state.handle.projectDir !== dir) return; // 其他会话目录的沙箱，不越界处理
		const provider = state.provider;
		const h = state.handle;
		const manifest = state.manifest;
		const hadManifest = state.phase === "delivered" && !!manifest;
		resetState();
		ctx.ui.setStatus("plan-sandbox", undefined);
		if (hadManifest && manifest) {
			// 有待采认交付物时保留沙箱并落盘 manifest + review.json，供跨会话收尾
			persistMeta(h, provider);
			persistManifest(h, manifest);
			try {
				const d = await provider.delta(h);
				writeReview(h, provider, manifest, d);
			} catch {}
			ctx.ui.notify(`plan-sandbox: 会话结束，沙箱保留于 ${h.sandboxDir}（含未采认交付物）。任意会话中 /plan-sandbox accept|discard 处理，或 /plan-sandbox cleanup 清理。`, "warning");
			return;
		}
		try {
			await provider.destroy(h);
		} catch {}
		ctx.ui.notify(`plan-sandbox: 会话结束，沙箱已销毁（未采认内容已丢弃）。`, "info");
	});
}
