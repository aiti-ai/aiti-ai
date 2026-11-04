/**
 * aiti-custom-agent —— 自定义 agent 注册中心（方案 docs/aiti-custom-agent-plan.md）。
 *
 * 职责：
 *   1. agents.json（<configDir>，UI 读写）→ startup 逐成员注册 SessionProvider
 *      （type=成员 id、探活失败跳过 + 日志）；provider 不带 agentKey——generic
 *      会话不落站位文件、不进 All Sessions（P1 定位：任务型，历史本地 JSONL）。
 *   2. generic 驱动：one-shot spawn（prompt 写 stdin → stdout 流式 → 退出收口），
 *      句柄见 generic-handle.ts；launch 解析走共享层 resolveCliLaunch
 *      （command/argsPrefix/成员 env/bridge 重写，$VAR/${cwd} 展开）。
 *   3. 管理 API：GET/POST/PUT/DELETE agents、POST probe（保存即热生效——
 *      unregister/register 热更新；失败回退 POST /api/extensions/reload）。
 *   4. client：工具条按钮 + data-ext-float 管理面板（列表 + 表单，用户不写 JSON）。
 *
 * 协议型驱动（claude/codex/…，P2）：下拉占位 + parseCustomAgents 明确跳过，
 * 待各基础扩展暴露 ctx.services 委托服务后接入。
 */

// ============================================================================
// 结构化契约（镜像 lib/ext/types.ts / lib/session/types.ts，扩展 out-of-tree 惯例）
// ============================================================================

type Listener = (event: Record<string, unknown>) => void;
type SessionCapabilities = Record<string, boolean>;

interface SessionHandleLike {
	readonly id: string;
	readonly source: string;
	readonly capabilities: SessionCapabilities;
	readonly cwd: string;
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	subscribe(listener: Listener): () => void;
	dispose(): Promise<void>;
	alive(): boolean;
	isRunning(): boolean;
	getModel(): undefined;
	getLastActivity?(): number | undefined;
	getMessages(): Promise<unknown[]>;
}

interface CreateSessionOptionsLike {
	sessionFile?: string;
	sessionId?: string;
	cwd?: string;
}

/** P2 协议委托服务契约（基础扩展 `<extId>.launch`，aiti-docs guide/ext-services 同款 provide/get）。 */
interface LaunchServiceLike {
	/** 代理成员的 agentKey（All Sessions join key；多成员家族 = 缺省成员）。 */
	agentKey: string;
	/** 能力模板（与基础扩展自家 provider 一致）。 */
	capabilities: SessionCapabilities;
	/** 可委托成员（多成员家族如 acp 提供；单成员可省略）。 */
	members?: Array<{ name: string; agentKey: string; label: string }>;
	listModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
	createSessionFromLaunch(
		launch: { command?: string; argsPrefix?: string[]; env?: Record<string, string>; bridge?: string; target?: string },
		options: CreateSessionOptionsLike,
	): Promise<SessionHandleLike> | SessionHandleLike;
}

interface ExtServerContextLike {
	id: string;
	dir: string;
	configDir: string;
	/** 跨扩展服务 slot（P2 消费侧；旧宿主缺省=协议型成员不注册）。 */
	services?: {
		get<T>(key: string): T | undefined;
	};
	sessionProviders: {
		register(provider: {
			type: string;
			label: string;
			agentKey?: string;
			priority?: number;
			order?: number;
			maxCapabilities: SessionCapabilities;
			listModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
			createSession(options: CreateSessionOptionsLike): Promise<SessionHandleLike> | SessionHandleLike;
		}): string;
		remove(type: string): boolean;
	};
}

/** 协议型 driver → 基础扩展映射（launch 服务键 = `<extId>.launch`）。 */
const PROTOCOL_DRIVERS: Record<string, { extId: string; label: string }> = {
	claude: { extId: "aiti-claude-code-agent", label: "Claude Code" },
	codex: { extId: "aiti-codex-agent", label: "Codex" },
	zcode: { extId: "aiti-zcode-agent", label: "ZCode" },
	cursor: { extId: "aiti-cursor-agent", label: "Cursor" },
	qoder: { extId: "aiti-qoder-agent", label: "Qoder" },
	acp: { extId: "aiti-acp-agent", label: "ACP" },
	codebuddy: { extId: "aiti-codebuddy-agent", label: "CodeBuddy" },
	pi: { extId: "aiti-pi-agent", label: "Pi" },
};

function serviceKeyOf(m: CustomAgentSpec): string | null {
	const d = PROTOCOL_DRIVERS[m.driver];
	return d ? `${d.extId}.launch` : null;
}

function protocolService(m: CustomAgentSpec): LaunchServiceLike | null {
	const key = serviceKeyOf(m);
	if (!key || !ctxRef?.services) return null;
	return ctxRef.services.get<LaunchServiceLike>(key) ?? null;
}

import { parseCustomAgents } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { CustomAgentSpec } from "@aiti-ai/ext-shared/agent-spawn-env";
import { GenericAgentHandle } from "./generic-handle.ts";
import { spawn as cpSpawn } from "node:child_process";
import { createRequire } from "node:module";

/** core.cjs 加载（原生 createRequire——jiti 的 require.cache 是空对象；每次加载清缓存，热重载后拿新逻辑） */
function loadCore() {
	const nativeRequire = createRequire(import.meta.url);
	const c = nativeRequire.cache || {};
	for (const k of Object.keys(c)) {
		if (k.endsWith("aiti-custom-agent/core.cjs")) delete c[k];
	}
	return nativeRequire("./core.cjs");
}
const core = loadCore();

// ============================================================================
// generic 驱动能力面（诚实声明：任务型 one-shot，仅核心四件套 + getMessages）
// ============================================================================

const GENERIC_CAPABILITIES: SessionCapabilities = {
	steer: false,
	followUp: false,
	getMessages: true,
	contextUsage: false,
	setModel: false,
	setThinkingLevel: false,
	fork: false,
	renameSession: false,
	compact: false,
	executeBash: false,
	listTools: false,
	setActiveTools: false,
	navigateTree: false,
	deleteSession: false,
	getCommands: false,
};

// ============================================================================
// 注册中心状态（reload 后本模块重新执行 → 全量重建）
// ============================================================================

interface ProbeStatus {
	ok: boolean;
	detail: string;
	ts: number;
}

let ctxRef: ExtServerContextLike | null = null;
let members: CustomAgentSpec[] = [];
let loadWarnings: string[] = [];
const registeredKeys = new Map<string, string>(); // member.id → registry key（"<extId>/<type>"）
const probeCache = new Map<string, { sig: string; status: ProbeStatus }>(); // member.id → 按配置签名缓存
let handleSeq = 0;

function memberSig(m: Pick<CustomAgentSpec, "probe" | "command" | "argsPrefix" | "env" | "bridge">): string {
	return JSON.stringify([m.probe, m.command, m.argsPrefix, m.env, m.bridge]);
}

/** 探活：跑 probe（缺省 command，可带空格分隔参数）。ENOENT/不可执行 → 失败；
 *  退出码不判定（CLI 无参常非 0）；超时杀进程但视为存活（二进制存在即算活）。 */
async function runProbe(target: { probe?: string; command: string; argsPrefix?: string[] }, timeoutMs = 5000): Promise<ProbeStatus> {
	const line = String(target.probe ?? "").trim() || String(target.command ?? "").trim();
	const parts = line.split(/\s+/).filter(Boolean);
	const ts = Date.now();
	if (!parts.length) return { ok: false, detail: "探活命令为空", ts };
	return await new Promise<ProbeStatus>((resolve) => {
		let settled = false;
		let child: ReturnType<typeof cpSpawn>;
		const done = (status: ProbeStatus) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(status);
		};
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch { /* 已退出 */ }
			done({ ok: true, detail: `可执行（探活 ${timeoutMs}ms 超时杀掉，进程存在即算活）`, ts: Date.now() });
		}, timeoutMs);
		try {
			child = cpSpawn(parts[0], parts.slice(1), { stdio: "ignore", timeout: timeoutMs + 1000 });
		} catch (e) {
			done({ ok: false, detail: `启动失败：${(e as Error)?.message || e}`, ts });
			return;
		}
		child.on("error", (e: Error) => {
			const code = (e as NodeJS.ErrnoException).code;
			done({ ok: false, detail: code === "ENOENT" ? `命令未找到：${parts[0]}` : `启动失败：${e.message}`, ts: Date.now() });
		});
		child.on("close", (code: number | null, signal: string | null) => {
			done({
				ok: true,
				detail: signal ? `被信号 ${signal} 终止（可执行）` : `可执行（退出码 ${code ?? "-"}，不判定成败）`,
				ts: Date.now(),
			});
		});
	});
}

async function probeMember(m: CustomAgentSpec): Promise<ProbeStatus> {
	// 协议型且无探活命令/命令：可用性 = 基础扩展 launch 服务在场（不 spawn、不缓存——服务随 reload 动态）
	if (m.driver !== "generic" && !m.probe && !m.command) {
		const svc = protocolService(m);
		const key = serviceKeyOf(m);
		return {
			ok: !!svc,
			detail: svc
				? `launch 服务可用（${key}）`
				: `launch 服务不可用（${key ?? "未知驱动"}：基础扩展未部署或旧版本不支持委托）`,
			ts: Date.now(),
		};
	}
	const sig = memberSig(m);
	const cached = probeCache.get(m.id);
	if (cached && cached.sig === sig) return cached.status;
	const status = await runProbe(m);
	probeCache.set(m.id, { sig, status });
	return status;
}

function providerFor(m: CustomAgentSpec, launch?: LaunchServiceLike) {
	// P2 协议型：委托基础扩展 launch 服务（handle 完整协议能力；agentKey/能力模板均来自服务）
	if (m.driver !== "generic") {
		return {
			type: m.id,
			label: m.label,
			agentKey: launch!.agentKey,
			priority: 5, // 低于基础扩展自家 provider（认领/恢复直连优先）；别名仅作包装入口
			order: m.order,
			maxCapabilities: launch!.capabilities,
			...(launch!.listModels ? { listModels: () => launch!.listModels!() } : {}),
			createSession: (options: CreateSessionOptionsLike) =>
				launch!.createSessionFromLaunch(
					{
						...(m.command ? { command: m.command } : {}),
						...(m.argsPrefix.length ? { argsPrefix: m.argsPrefix } : {}),
						...(Object.keys(m.env).length ? { env: m.env } : {}),
						...(m.bridge ? { bridge: m.bridge } : {}),
						...(m.target ? { target: m.target } : {}),
					},
					options,
				),
		};
	}
	return {
		type: m.id,
		label: m.label,
		order: m.order,
		maxCapabilities: GENERIC_CAPABILITIES,
		createSession: (options: CreateSessionOptionsLike) =>
			new GenericAgentHandle({
				member: m,
				cwd: options.cwd,
				configDir: ctxRef?.configDir,
				...(options.sessionId ? { id: options.sessionId } : {}),
			}),
	};
}

/** 全量热重建：注销全部 → 逐成员探活/注册（探活失败/服务缺席跳过 + 日志）。返回问题清单（空 = 全注册）。 */
async function registerAll(): Promise<string[]> {
	const ctx = ctxRef;
	if (!ctx) return ["ctx 未就绪"];
	const problems: string[] = [];
	for (const key of registeredKeys.values()) {
		try {
			ctx.sessionProviders.remove(key);
		} catch { /* 宿主侧已清理（reload）——无害 */ }
	}
	registeredKeys.clear();
	for (const m of members) {
		if (!m.enabled) continue;
		// P2 协议型：先裁决 launch 服务在场（缺席 fail-loud 跳过，UI 可见）
		const launch = m.driver !== "generic" ? protocolService(m) : undefined;
		if (m.driver !== "generic" && !launch) {
			problems.push(
				`跳过「${m.label}」(${m.id})：驱动 ${m.driver} 的 launch 服务不可用` +
					`（${serviceKeyOf(m)} —— 基础扩展未部署或版本过旧，不支持委托）`,
			);
			continue;
		}
		const status = await probeMember(m);
		if (!status.ok) {
			console.log(`[aiti-custom-agent] 跳过「${m.label}」(${m.id})：探活失败 —— ${status.detail}`);
			continue;
		}
		try {
			const key = ctx.sessionProviders.register(providerFor(m, launch));
			registeredKeys.set(m.id, key);
		} catch (e) {
			problems.push(`注册「${m.label}」(${m.id}) 失败：${(e as Error)?.message || e}`);
		}
	}
	return problems;
}

function persist(): string[] {
	core.saveAgents(ctxRef?.configDir ?? "", members);
	const parsed = parseCustomAgents({ agents: members });
	members = parsed.agents; // 保存侧规整后回读（去未知字段）
	return [...loadWarnings, ...parsed.warnings];
}

function listPayload() {
	return {
		agents: members.map((m) => ({
			...m,
			// 协议型无探活命令：探活状态即时计算（服务在场性随 reload 动态，不缓存）
			probe: (m.driver !== "generic" && !m.probe && !m.command)
				? probeMemberSync(m)
				: probeCache.get(m.id)?.status ?? null,
			registered: registeredKeys.has(m.id),
			registryKey: registeredKeys.get(m.id) ?? null,
			// P2 协议型辅助字段（UI 显示服务可解析性；generic 恒 null）
			serviceKey: serviceKeyOf(m),
			serviceOk: m.driver !== "generic" ? !!protocolService(m) : null,
		})),
		warnings: loadWarnings,
		// P2 各协议驱动当前可委托成员（多成员家族如 acp 供 UI 下拉；单成员扩展缺省无 members）
		driverMembers: driverMembersPayload(),
	};
}

/** 各协议驱动 launch 服务的成员清单（服务缺席/旧版本 → 不出现在对应驱动下）。 */
function driverMembersPayload(): Record<string, Array<{ name: string; agentKey: string; label: string }>> {
	const out: Record<string, Array<{ name: string; agentKey: string; label: string }>> = {};
	if (!ctxRef?.services) return out;
	for (const [driver, meta] of Object.entries(PROTOCOL_DRIVERS)) {
		const svc = ctxRef.services.get<LaunchServiceLike>(`${meta.extId}.launch`);
		if (svc?.members?.length) out[driver] = svc.members;
	}
	return out;
}

/** 协议型服务在场性同步探活（listPayload 用；无 spawn）。 */
function probeMemberSync(m: CustomAgentSpec): ProbeStatus {
	const svc = protocolService(m);
	const key = serviceKeyOf(m);
	return {
		ok: !!svc,
		detail: svc ? `launch 服务可用（${key}）` : `launch 服务不可用（${key ?? "未知驱动"}：基础扩展未部署或旧版本不支持委托）`,
		ts: Date.now(),
	};
}

// ============================================================================
// Extension entry
// ============================================================================

export default {
	id: "aiti-custom-agent",
	name: "自定义 Agent",
	version: "0.1.0",
	icon: "🧩",
	// 管理面板（零构建原生 h() client；client/src 随 deploy 拷 dist）
	client: "dist/custom-agent-client.mjs",

	server: {
		async startup(ctx: ExtServerContextLike) {
			ctxRef = ctx;
			const loaded = core.loadAgents(ctx.configDir);
			const parsed = parseCustomAgents(loaded);
			members = parsed.agents;
			loadWarnings = parsed.warnings;
			if (loadWarnings.length) console.warn(`[aiti-custom-agent] agents.json 校验警告：\n  ${loadWarnings.join("\n  ")}`);
			const problems = await registerAll();
			for (const p of problems) console.warn(`[aiti-custom-agent] ${p}`);
			console.log(
				`[aiti-custom-agent] ready：${registeredKeys.size}/${members.length} 个自定义后端已注册` +
					`（configDir: ${ctx.configDir}）`,
			);
		},

		async api(req: Request, ctx: { path: string[]; method: string }) {
			const [seg0, seg1] = Array.isArray(ctx.path) ? ctx.path : [];
			const method = String(ctx.method ?? "GET").toUpperCase();
			if (!ctxRef) return Response.json({ error: "扩展未就绪" }, { status: 503 });

			if (seg0 === "agents" && method === "GET") return Response.json(listPayload());

			if (seg0 === "agents" && (method === "POST" || method === "PUT")) {
				let body: Record<string, unknown> = {};
				try {
					body = (await req.json()) as Record<string, unknown>;
				} catch { /* 空体 */ }
				const input = core.normalizeInput(body);
				if (input.error) return Response.json({ error: input.error }, { status: 400 });
				const next = input.agent as CustomAgentSpec;
				const prevId = method === "PUT" ? seg1 || String(body.id ?? "") : "";
				if (method === "PUT" && prevId && !members.some((m) => m.id === prevId)) {
					return Response.json({ error: `未找到「${prevId}」` }, { status: 404 });
				}
				// PUT 未显式带 id 时沿用路径 id（body.id 缺省会被 slug(label) 填充，不视为改名）
				if (method === "PUT" && prevId && !body.id) next.id = prevId;
				if (method === "POST" && members.some((m) => m.id === next.id)) {
					return Response.json({ error: `标识「${next.id}」已存在（PUT 可覆盖，或换个 id）` }, { status: 409 });
				}
				// PUT /agents/<oldId> 且 body.id 变了 = 改名：原位替换（id 换新）
				const targetId = prevId || next.id;
				members = members.some((m) => m.id === targetId)
					? members.map((m) => (m.id === targetId ? next : m))
					: [...members, next];
				probeCache.delete(targetId);
				const warnings = persist();
				const problems = await registerAll();
				return Response.json({
					ok: problems.length === 0,
					...(problems.length ? { problems, fallback: "POST /api/extensions/reload" } : {}),
					warnings,
					...listPayload(),
				});
			}

			if (seg0 === "agents" && method === "DELETE" && seg1) {
				if (!members.some((m) => m.id === seg1)) return Response.json({ error: `未找到「${seg1}」` }, { status: 404 });
				members = members.filter((m) => m.id !== seg1);
				probeCache.delete(seg1);
				const warnings = persist();
				const problems = await registerAll();
				return Response.json({ ok: problems.length === 0, warnings, ...listPayload() });
			}

			if (seg0 === "probe" && method === "POST") {
				let body: Record<string, unknown> = {};
				try {
					body = (await req.json()) as Record<string, unknown>;
				} catch { /* 空体 */ }
				// 两种形态：{ id } 重探已存成员；{ command, probe } 表单未保存的临场探测
				if (body.id) {
					const m = members.find((x) => x.id === String(body.id));
					if (!m) return Response.json({ error: `未找到「${body.id}」` }, { status: 404 });
					probeCache.delete(m.id);
					return Response.json({ ...(await probeMember(m)), ...listPayload() });
				}
				const command = String(body.command ?? "").trim();
				if (!command) return Response.json({ error: "command 必填" }, { status: 400 });
				return Response.json(await runProbe({ probe: String(body.probe ?? ""), command }));
			}

			if (seg0 === "reload" && method === "POST") {
				const problems = await registerAll();
				return Response.json({ ok: problems.length === 0, problems, ...listPayload() });
			}

			if (seg0 === "selftest" && method === "POST") {
				// 调试：用本进程 node 跑一轮 generic 句柄（stdout 流式 → 收口序列）
				const m: CustomAgentSpec = {
					id: "selftest",
					label: "selftest",
					driver: "generic",
					command: process.execPath,
					argsPrefix: ["-e", "process.stdout.write('hello from generic'); "],
					env: {},
					bridge: "",
					probe: "",
					order: 1000,
					enabled: true,
				};
				const handle = new GenericAgentHandle({ member: m, deps: { warn: () => {} } });
				const events: string[] = [];
				let text = "";
				const unsub = handle.subscribe((e) => {
					events.push(String(e.type));
					if (e.type === "message_update") text += String(e.delta ?? "");
					if (e.type === "message_end") text = String(e.text ?? "");
				});
				await handle.prompt("ignored");
				unsub();
				await handle.dispose();
				return Response.json({ ok: true, events, text, capabilities: handle.capabilities });
			}

			return Response.json({ error: `未知端点 /${[seg0, seg1].filter(Boolean).join("/")}` }, { status: 404 });
		},
	},
};
