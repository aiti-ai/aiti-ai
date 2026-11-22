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
	icon: "🧩",
	// 管理面板（零构建原生 h() client；client/src 随 deploy 拷 dist）
	client: "dist/custom-agent-client.mjs",

	ui: {
		// English manifest-text overrides (name/description/feature labels); zh source lives in the manifest.
		i18n: {
			"zh-CN": {
				"（副本）": "（副本）",
				"自定义 Agent": "自定义 Agent",
				"新建会话后端注册中心 · 保存即热生效": "新建会话后端注册中心 · 保存即热生效",
				"＋ 新增": "＋ 新增",
				"返回列表": "返回列表",
				"关闭": "关闭",
				"还没有自定义后端——点「＋ 新增」注册一条（如 docker 化的 CLI）。": "还没有自定义后端——点「＋ 新增」注册一条（如 docker 化的 CLI）。",
				"加载中…": "加载中…",
				"配置警告：\\n": "配置警告：\\n",
				"generic 驱动 = one-shot 任务型：任务文本写进 stdin，stdout 流式进会话；模型/权限等完整协议能力等 P2 协议委托。": "generic 驱动 = one-shot 任务型：任务文本写进 stdin，stdout 流式进会话；模型/权限等完整协议能力等 P2 协议委托。",
				"已停用": "已停用",
				"● 已注册": "● 已注册",
				"○ 未注册（探活失败或停用）": "○ 未注册（探活失败或停用）",
				"探活": "探活",
				"编辑": "编辑",
				"复制": "复制",
				"运行探活命令": "运行探活命令",
				"探活：": "探活：",
				"可执行": "可执行",
				"失败": "失败",
				"已更新": "已更新",
				"启用": "启用",
				"停用": "停用",
				"上移（与上一位交换位次）": "上移（与上一位交换位次）",
				"下移（与下一位交换位次）": "下移（与下一位交换位次）",
				"删除自定义后端「": "删除自定义后端「",
				"已删除": "已删除",
				"删除": "删除",
				" · 驱动 ": " · 驱动 ",
				" · 服务 ✓": " · 服务 ✓",
				" · 服务 ✗（基础扩展未部署/过旧）": " · 服务 ✗（基础扩展未部署/过旧）",
				"(默认 CLI)": "(默认 CLI)",
				"已调整位次": "已调整位次",
				"必填：": "必填：",
				"该驱动默认 CLI": "该驱动默认 CLI",
				"（command 已由包装命令顶替）": "（command 已由包装命令顶替）",
				"留空 = 用镜像入口点；否则填真实 CLI（如 claude）": "留空 = 用镜像入口点；否则填真实 CLI（如 claude）",
				"如 claude（可带参数）": "如 claude（可带参数）",
				"运行方式": "运行方式",
				"镜像/容器": "镜像/容器",
				"aiti/aiti:core（exec 模式填容器名）": "aiti/aiti:core（exec 模式填容器名）",
				"容器内命令": "容器内命令",
				"附加参数": "附加参数",
				"每行一个参数：-v / ${cwd}:${cwd} / -w / ${cwd}": "每行一个参数：-v / ${cwd}:${cwd} / -w / ${cwd}",
				"＋ 常用选项…": "＋ 常用选项…",
				"容器内回连宿主桥：桥模式选 host.docker.internal 时补 --add-host=host.docker.internal:host-gateway，或直接用共享宿主网络的运行方式。": "容器内回连宿主桥：桥模式选 host.docker.internal 时补 --add-host=host.docker.internal:host-gateway，或直接用共享宿主网络的运行方式。",
				"目标": "目标",
				"端口": "端口",
				"远端命令": "远端命令",
				"附加选项": "附加选项",
				"每行一个参数，如 -t / -o / StrictHostKeyChecking=accept-new": "每行一个参数，如 -t / -o / StrictHostKeyChecking=accept-new",
				"远端须免密登录（密钥 agent 已配好）；-p 端口在上方位次之间自动插入。": "远端须免密登录（密钥 agent 已配好）；-p 端口在上方位次之间自动插入。",
				"临时变量": "临时变量",
				"每行一个 KEY=VALUE，如：\\nHTTPS_PROXY=$HTTPS_PROXY\\nFOO=bar": "每行一个 KEY=VALUE，如：\\nHTTPS_PROXY=$HTTPS_PROXY\\nFOO=bar",
				"被包装命令": "被包装命令",
				"每行一个参数，如 nix-shell 的 --run / sudo 的 -E": "每行一个参数，如 nix-shell 的 --run / sudo 的 -E",
				"包装命令填在下方「命令」框（任意可执行文件：sudo / nix-shell / podman / timeout / firejail …）；这儿放它的参数。": "包装命令填在下方「命令」框（任意可执行文件：sudo / nix-shell / podman / timeout / firejail …）；这儿放它的参数。",
				"代理工具": "代理工具",
				"每行一个参数，如 proxychains 的 -f / 配置文件路径": "每行一个参数，如 proxychains 的 -f / 配置文件路径",
				"socks 服务端地址在各工具自己的配置里（dante.conf / proxychains.conf），不在本表单。": "socks 服务端地址在各工具自己的配置里（dante.conf / proxychains.conf），不在本表单。",
				"显示名": "显示名",
				"如 Claude Code (Docker)": "如 Claude Code (Docker)",
				"标识 id": "标识 id",
				"自动生成，可改": "自动生成，可改",
				"provider type（字母/数字/-_）": "provider type（字母/数字/-_）",
				"驱动类型": "驱动类型",
				"前缀命令": "前缀命令",
				"用 docker / ssh / env / proxychains 等包装真实 CLI——选中即顶替「命令」，真实 CLI 进参数前缀末尾": "用 docker / ssh / env / proxychains 等包装真实 CLI——选中即顶替「命令」，真实 CLI 进参数前缀末尾",
				"实际执行：": "实际执行：",
				"包装命令": "包装命令",
				"命令": "命令",
				"任意可执行文件：sudo / nix-shell / podman / timeout …": "任意可执行文件：sudo / nix-shell / podman / timeout …",
				"由包装类型决定（换 podman 等请选「自定义」）": "由包装类型决定（换 podman 等请选「自定义」）",
				"如 docker（容器内 CLI 写进参数前缀末尾）": "如 docker（容器内 CLI 写进参数前缀末尾）",
				"留空 = 用该驱动默认 CLI": "留空 = 用该驱动默认 CLI",
				"探测：": "探测：",
				"探测中…": "探测中…",
				"探测": "探测",
				"探活命令": "探活命令",
				"缺省 = 命令（可带空格分隔参数，如 docker version）": "缺省 = 命令（可带空格分隔参数，如 docker version）",
				"参数前缀": "参数前缀",
				"每行一个参数，如：\\nrun\\n--rm\\n-i\\n-v\\n${cwd}:${cwd}\\n-w\\n${cwd}\\nmy-image:latest\\nclaude": "每行一个参数，如：\\nrun\\n--rm\\n-i\\n-v\\n${cwd}:${cwd}\\n-w\\n${cwd}\\nmy-image:latest\\nclaude",
				"由上方包装字段生成；改任一包装字段即按模板重写，这里可继续手改（每行一个参数，支持 $VAR / ${cwd}）。": "由上方包装字段生成；改任一包装字段即按模板重写，这里可继续手改（每行一个参数，支持 $VAR / ${cwd}）。",
				"拼在驱动内置参数之前；支持 $VAR / ${cwd}（会话工作目录）。docker 配方建议 -v ${cwd}:${cwd} -w ${cwd} 同路径挂载。": "拼在驱动内置参数之前；支持 $VAR / ${cwd}（会话工作目录）。docker 配方建议 -v ${cwd}:${cwd} -w ${cwd} 同路径挂载。",
				"环境变量": "环境变量",
				"VALUE（支持 $VAR / ${cwd}）": "VALUE（支持 $VAR / ${cwd}）",
				"＋ 添加变量": "＋ 添加变量",
				"成员级 env，优先级最高；密钥建议写 $VAR 引用父进程环境变量而非明文。": "成员级 env，优先级最高；密钥建议写 $VAR 引用父进程环境变量而非明文。",
				"桥模式": "桥模式",
				"委托目标": "委托目标",
				"缺省成员": "缺省成员",
				"多成员驱动（如 ACP）指定委托到哪个成员；缺省由基础扩展决定。": "多成员驱动（如 ACP）指定委托到哪个成员；缺省由基础扩展决定。",
				"排序": "排序",
				"已保存并热生效": "已保存并热生效",
				"已保存，但以下成员未注册：\\n": "已保存，但以下成员未注册：\\n",
				"已保存，但有条目被跳过：\\n": "已保存，但有条目被跳过：\\n",
				"保存中…": "保存中…",
				"保存": "保存",
				"取消": "取消",
				"配置警告：\n": "配置警告：\n",
				"每行一个 KEY=VALUE，如：\nHTTPS_PROXY=$HTTPS_PROXY\nFOO=bar": "每行一个 KEY=VALUE，如：\nHTTPS_PROXY=$HTTPS_PROXY\nFOO=bar",
				"每行一个参数，如：\nrun\n--rm\n-i\n-v\n${cwd}:${cwd}\n-w\n${cwd}\nmy-image:latest\nclaude": "每行一个参数，如：\nrun\n--rm\n-i\n-v\n${cwd}:${cwd}\n-w\n${cwd}\nmy-image:latest\nclaude",
				"已保存，但以下成员未注册：\n": "已保存，但以下成员未注册：\n",
				"已保存，但有条目被跳过：\n": "已保存，但有条目被跳过：\n",
				"it.panel.label": "自定义 Agent",
				"it.panel.title": "自定义 Agent：注册自定义后端（命令/参数前缀/env/桥模式）",
			},
			en: {
				"（副本）": "(copy)",
				"自定义 Agent": "Custom Agents",
				"新建会话后端注册中心 · 保存即热生效": "Session-backend registry · hot-applied on save",
				"＋ 新增": "＋ Add",
				"返回列表": "Back to list",
				"关闭": "Close",
				"还没有自定义后端——点「＋ 新增」注册一条（如 docker 化的 CLI）。": "No custom backends yet — click \"＋ Add\" to register one (e.g. a dockerized CLI).",
				"加载中…": "Loading…",
				"配置警告：\n": "Config warnings:\\n",
				"generic 驱动 = one-shot 任务型：任务文本写进 stdin，stdout 流式进会话；模型/权限等完整协议能力等 P2 协议委托。": "The generic driver = one-shot task style: task text goes to stdin, stdout streams into the session; full protocol capabilities (model/permissions) come with the P2 protocol drivers.",
				"已停用": "Disabled",
				"● 已注册": "● Registered",
				"○ 未注册（探活失败或停用）": "○ Not registered (probe failed or disabled)",
				"探活": "Probe",
				"编辑": "Edit",
				"复制": "Copy",
				"运行探活命令": "Run the probe command",
				"探活：": "Probe: ",
				"可执行": "runnable",
				"失败": "failed",
				"已更新": "Updated",
				"启用": "Enable",
				"停用": "Disable",
				"上移（与上一位交换位次）": "Move up (swaps with the one above)",
				"下移（与下一位交换位次）": "Move down (swaps with the one below)",
				"删除自定义后端「": "Delete custom backend \"",
				"已删除": "Deleted",
				"删除": "Delete",
				" · 驱动 ": "· driver ",
				" · 服务 ✓": "· service ✓",
				" · 服务 ✗（基础扩展未部署/过旧）": "· service ✗ (base extension missing or too old)",
				"(默认 CLI)": "(default CLI)",
				"已调整位次": "Order adjusted",
				"必填：": "Required: ",
				"该驱动默认 CLI": "this driver's default CLI",
				"（command 已由包装命令顶替）": "(command is replaced by the wrapper command)",
				"留空 = 用镜像入口点；否则填真实 CLI（如 claude）": "Empty = image entrypoint; otherwise the real CLI (e.g. claude)",
				"如 claude（可带参数）": "e.g. claude (args allowed)",
				"运行方式": "Run mode",
				"镜像/容器": "Image / container",
				"aiti/aiti:core（exec 模式填容器名）": "aiti/aiti:core (container name in exec mode)",
				"容器内命令": "Command inside container",
				"附加参数": "Extra args",
				"每行一个参数：-v / ${cwd}:${cwd} / -w / ${cwd}": "One arg per line: -v / ${cwd}:${cwd} / -w / ${cwd}",
				"＋ 常用选项…": "＋ Common options…",
				"容器内回连宿主桥：桥模式选 host.docker.internal 时补 --add-host=host.docker.internal:host-gateway，或直接用共享宿主网络的运行方式。": "Container reaching the host bridge: with bridge mode host.docker.internal add --add-host=host.docker.internal:host-gateway, or use a run mode sharing the host network.",
				"目标": "Target",
				"端口": "Port",
				"远端命令": "Remote command",
				"附加选项": "Extra options",
				"每行一个参数，如 -t / -o / StrictHostKeyChecking=accept-new": "One arg per line, e.g. -t / -o / StrictHostKeyChecking=accept-new",
				"远端须免密登录（密钥 agent 已配好）；-p 端口在上方位次之间自动插入。": "Remote must be password-less (the key agent is already set up); -p port is inserted automatically between the options above.",
				"临时变量": "Temp vars",
				"每行一个 KEY=VALUE，如：\nHTTPS_PROXY=$HTTPS_PROXY\nFOO=bar": "One KEY=VALUE per line, e.g.:\\nHTTPS_PROXY=$HTTPS_PROXY\\nFOO=bar",
				"被包装命令": "Wrapped command",
				"每行一个参数，如 nix-shell 的 --run / sudo 的 -E": "One arg per line, e.g. nix-shell's --run / sudo's -E",
				"包装命令填在下方「命令」框（任意可执行文件：sudo / nix-shell / podman / timeout / firejail …）；这儿放它的参数。": "The wrapper command goes in the \"Command\" box below (any executable: sudo / nix-shell / podman / timeout / firejail …); its args go here.",
				"代理工具": "Proxy tool",
				"每行一个参数，如 proxychains 的 -f / 配置文件路径": "One arg per line, e.g. proxychains' -f / a config file path",
				"socks 服务端地址在各工具自己的配置里（dante.conf / proxychains.conf），不在本表单。": "SOCKS server addresses live in each tool's own config (dante.conf / proxychains.conf), not in this form.",
				"显示名": "Display name",
				"如 Claude Code (Docker)": "e.g. Claude Code (Docker)",
				"标识 id": "Identifier (id)",
				"自动生成，可改": "Auto-generated, editable",
				"provider type（字母/数字/-_）": "provider type (letters/digits/-_)",
				"驱动类型": "Driver",
				"前缀命令": "Prefix command",
				"用 docker / ssh / env / proxychains 等包装真实 CLI——选中即顶替「命令」，真实 CLI 进参数前缀末尾": "Wrap the real CLI with docker / ssh / env / proxychains etc. — selecting one replaces \"Command\"; the real CLI goes to the end of the args prefix",
				"实际执行：": "Actually runs: ",
				"包装命令": "Wrapper command",
				"命令": "Command",
				"任意可执行文件：sudo / nix-shell / podman / timeout …": "Any executable: sudo / nix-shell / podman / timeout …",
				"由包装类型决定（换 podman 等请选「自定义」）": "Decided by the wrapper type (switching to podman etc. — pick \"Custom\")",
				"如 docker（容器内 CLI 写进参数前缀末尾）": "e.g. docker (the in-container CLI goes to the end of the args prefix)",
				"留空 = 用该驱动默认 CLI": "Empty = use this driver's default CLI",
				"探测：": "Probe: ",
				"探测中…": "Probing…",
				"探测": "Probe",
				"探活命令": "Probe command",
				"缺省 = 命令（可带空格分隔参数，如 docker version）": "defaults to the command (space-separated args allowed, e.g. docker version)",
				"参数前缀": "Args prefix",
				"每行一个参数，如：\nrun\n--rm\n-i\n-v\n${cwd}:${cwd}\n-w\n${cwd}\nmy-image:latest\nclaude": "One arg per line, e.g.:\\nrun\\n--rm\\n-i\\n-v\\n${cwd}:${cwd}\\n-w\\n${cwd}\\nmy-image:latest\\nclaude",
				"由上方包装字段生成；改任一包装字段即按模板重写，这里可继续手改（每行一个参数，支持 $VAR / ${cwd}）。": "Generated from the wrapper fields above; changing any of them rewrites it from the template — you can still edit here (one arg per line, supports $VAR / ${cwd}).",
				"拼在驱动内置参数之前；支持 $VAR / ${cwd}（会话工作目录）。docker 配方建议 -v ${cwd}:${cwd} -w ${cwd} 同路径挂载。": "Prepended before the driver's built-in args; supports $VAR / ${cwd} (session working directory). Docker recipe suggests -v ${cwd}:${cwd} -w ${cwd} for same-path mounting.",
				"环境变量": "Environment variables",
				"VALUE（支持 $VAR / ${cwd}）": "VALUE (supports $VAR / ${cwd})",
				"＋ 添加变量": "＋ Add variable",
				"成员级 env，优先级最高；密钥建议写 $VAR 引用父进程环境变量而非明文。": "Member-level env, highest priority; for secrets prefer $VAR references to parent-process env vars over plaintext.",
				"桥模式": "Bridge mode",
				"委托目标": "Delegate target",
				"缺省成员": "Default member",
				"多成员驱动（如 ACP）指定委托到哪个成员；缺省由基础扩展决定。": "For multi-member drivers (e.g. ACP): which member to delegate to; default decided by the base extension.",
				"排序": "Order",
				"已保存并热生效": "Saved and hot-applied",
				"已保存，但以下成员未注册：\n": "Saved, but these members are not registered:\\n",
				"已保存，但有条目被跳过：\n": "Saved, but some entries were skipped:\\n",
				"保存中…": "Saving…",
				"配置警告：\\n": "Config warnings:\\n",
				"每行一个 KEY=VALUE，如：\\nHTTPS_PROXY=$HTTPS_PROXY\\nFOO=bar": "One KEY=VALUE per line, e.g.:\\nHTTPS_PROXY=$HTTPS_PROXY\\nFOO=bar",
				"每行一个参数，如：\\nrun\\n--rm\\n-i\\n-v\\n${cwd}:${cwd}\\n-w\\n${cwd}\\nmy-image:latest\\nclaude": "One arg per line, e.g.:\\nrun\\n--rm\\n-i\\n-v\\n${cwd}:${cwd}\\n-w\\n${cwd}\\nmy-image:latest\\nclaude",
				"已保存，但以下成员未注册：\\n": "Saved, but these members are not registered:\\n",
				"已保存，但有条目被跳过：\\n": "Saved, but some entries were skipped:\\n",
				"保存": "Save",
				"取消": "Cancel",
				"ext.displayName": "Custom Agents",
				"it.panel.label": "Custom Agents",
				"it.panel.title": "Custom Agents: register custom backends (command/args prefix/env/bridge mode)",
			},
		},
	},

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
