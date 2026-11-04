/**
 * generic-handle —— aiti-custom-agent 的 generic 驱动会话句柄。
 *
 * one-shot 任务型：prompt 写 stdin → stdout 逐块流式（message_update）→ 进程退出
 * 收口（message_end + agent_settled）；abort 杀进程（SIGTERM → 3s → SIGKILL）。
 * launch 解析走共享层 resolveCliLaunch（command/argsPrefix/成员 env/bridge 重写，
 * ${cwd}=会话工作目录）。历史本地 JSONL（<configDir>/sessions/<id>.jsonl），
 * P1 不进 All Sessions（provider 不带 agentKey，宿主不落站位文件）。
 *
 * 能力面诚实声明：仅核心四件套 + getMessages（maxCapabilities 同款，见 index.ts）；
 * 模型/权限/fork/队列/工具等一律 false——完整协议能力等 P2 协议委托。
 */

import { spawn as cpSpawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveCliLaunch } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { CustomAgentSpec } from "@aiti-ai/ext-shared/agent-spawn-env";

type Listener = (event: Record<string, unknown>) => void;

export interface HistoryEntry {
	role: "user" | "assistant";
	text: string;
	ts: number;
}

export interface GenericHandleDeps {
	/** 测试注入点；缺省 node:child_process.spawn */
	spawn?: typeof cpSpawn;
	/** 测试注入点；缺省 Date.now */
	now?: () => number;
	/** 测试注入点；缺省 console.warn */
	warn?: (msg: string) => void;
}

export interface GenericHandleOptions {
	/** 成员配置（driver=generic） */
	member: CustomAgentSpec;
	/** 会话工作目录（${cwd} 解析 + 进程 cwd） */
	cwd?: string;
	/** 扩展 configDir（历史 JSONL 根；缺省不持久化） */
	configDir?: string;
	/** 复用既有会话 id（resume 场景；缺省生成） */
	id?: string;
	deps?: GenericHandleDeps;
}

const ABORT_KILL_GRACE_MS = 3000;
const STDERR_TAIL_LIMIT = 8000;

export class GenericAgentHandle {
	readonly source: string;
	readonly id: string;
	readonly cwd: string;
	readonly capabilities: Record<string, boolean> = {
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

	private readonly member: CustomAgentSpec;
	private readonly configDir?: string;
	private readonly deps: Required<Pick<GenericHandleDeps, "spawn" | "now">> & GenericHandleDeps;
	private readonly listeners = new Set<Listener>();
	private messages: HistoryEntry[] = [];
	private running = false;
	private disposed = false;
	private child: ReturnType<typeof cpSpawn> | null = null;
	private abortRequested = false;
	private lastActivity = 0;

	constructor(opts: GenericHandleOptions) {
		this.member = opts.member;
		this.cwd = opts.cwd ?? process.cwd();
		this.configDir = opts.configDir;
		this.id = opts.id ?? `custom-${randomUUID().slice(0, 8)}`;
		this.source = `aiti-custom-agent/${opts.member.id}`;
		this.deps = {
			spawn: opts.deps?.spawn ?? cpSpawn,
			now: opts.deps?.now ?? (() => Date.now()),
			warn: opts.deps?.warn,
		};
		if (this.configDir) this.loadHistory();
	}

	// ---------------- SessionHandle core ----------------

	async prompt(text: string): Promise<void> {
		if (this.disposed) throw new Error("session disposed");
		if (this.running) throw new Error("generic agent is one-shot: wait for settled");
		if (!text?.trim()) throw new Error("empty prompt");

		this.running = true;
		this.abortRequested = false;
		this.lastActivity = this.deps.now();
		this.pushHistory({ role: "user", text, ts: this.lastActivity });
		this.emit({ type: "message_start", role: "assistant", sessionId: this.id });

		const launch = resolveCliLaunch({
			defaultCommand: this.member.command,
			command: this.member.command,
			argsPrefix: this.member.argsPrefix,
			driverArgs: [],
			memberEnv: this.member.env,
			bridge: this.member.bridge,
			cwd: this.cwd,
			warn: (m) => this.warnOut(m),
		});

		let stdoutText = "";
		let stderrText = "";
		let spawnError: Error | null = null;

		await new Promise<void>((resolve) => {
			let child: ReturnType<typeof cpSpawn>;
			try {
				child = this.deps.spawn(launch.command, launch.args, {
										shell: launch.shell,
cwd: this.cwd,
					env: launch.env,
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (e) {
				spawnError = e as Error;
				resolve();
				return;
			}
			this.child = child;

			// StringDecoder 跨 chunk 安全解码（加固 A1）：逐 chunk String() 会切碎多字节字符
			const stdoutDec = new StringDecoder("utf8");
			const stderrDec = new StringDecoder("utf8");
			child.stdout?.on("data", (chunk: Buffer | string) => {
				const s = typeof chunk === "string" ? chunk : stdoutDec.write(chunk);
				stdoutText += s;
				this.lastActivity = this.deps.now();
				this.emit({ type: "message_update", delta: s });
			});
			child.stderr?.on("data", (chunk: Buffer | string) => {
				stderrText = (stderrText + (typeof chunk === "string" ? chunk : stderrDec.write(chunk))).slice(-STDERR_TAIL_LIMIT);
			});
			child.on("error", (e: Error) => {
				spawnError = e;
			});
			child.on("close", () => resolve());

			// prompt 写 stdin；进程若不读 stdin，write 的 EPIPE 由 error 事件兜住
			child.stdin?.on("error", () => { /* 下游不读 stdin（如纯任务命令）——prompt 丢弃不致命 */ });
			child.stdin?.end(text);
		});

		const aborted = this.abortRequested;
		this.child = null;
		let outText = stdoutText;
		if (spawnError) {
			outText = `启动失败：${spawnError.message}${stderrText.trim() ? `\n[stderr]\n${stderrText.trim()}` : ""}`;
		} else if (stderrText.trim() && (aborted || !stdoutText.trim())) {
			// 无 stdout 时 stderr 就是全部结果（任务命令常把产物写 stderr）；有 stdout 时不混入
			outText = stderrText.trim();
		}
		if (aborted) outText = (outText ? outText + "\n" : "") + "（已中断）";

		this.lastActivity = this.deps.now();
		this.pushHistory({ role: "assistant", text: outText, ts: this.lastActivity });
		this.emit({ type: "message_end", text: outText });
		this.emit({ type: "agent_settled" });
		this.running = false;
	}

	async abort(): Promise<void> {
		if (!this.child) {
			this.abortRequested = true;
			return;
		}
		this.abortRequested = true;
		const child = this.child;
		try {
			child.kill("SIGTERM");
		} catch { /* 已退出 */ }
		setTimeout(() => {
			try {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			} catch { /* 已退出 */ }
		}, ABORT_KILL_GRACE_MS).unref?.();
		// close 事件收口 message_end/agent_settled（prompt 流程内），此处只标记
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.listeners.clear();
		if (this.child) {
			try {
				this.child.kill("SIGKILL");
			} catch { /* 已退出 */ }
			this.child = null;
		}
	}

	alive(): boolean {
		return !this.disposed;
	}

	isRunning(): boolean {
		return this.running;
	}

	getModel(): undefined {
		return undefined;
	}

	getLastActivity(): number | undefined {
		return this.lastActivity || undefined;
	}

	async getMessages(): Promise<unknown[]> {
		return this.messages;
	}

	// ---------------- history persistence ----------------

	private historyFile(): string | null {
		if (!this.configDir) return null;
		return join(this.configDir, "sessions", `${this.id}.jsonl`);
	}

	private loadHistory(): void {
		const fp = this.historyFile();
		if (!fp || !existsSync(fp)) return;
		try {
			const lines = readFileSync(fp, "utf8").split(/\r?\n/).filter(Boolean);
			this.messages = lines
				.map((l) => {
					try {
						return JSON.parse(l) as HistoryEntry;
					} catch {
						return null;
					}
				})
				.filter((e): e is HistoryEntry => !!e && typeof e?.text === "string");
		} catch (e) {
			this.warnOut(`历史读取失败（${fp}）：${(e as Error)?.message || e}`);
		}
	}

	private pushHistory(entry: HistoryEntry): void {
		this.messages.push(entry);
		const fp = this.historyFile();
		if (!fp) return;
		try {
			mkdirSync(join(this.configDir as string, "sessions"), { recursive: true });
			appendFileSync(fp, JSON.stringify(entry) + "\n");
		} catch (e) {
			this.warnOut(`历史写入失败（${fp}）：${(e as Error)?.message || e}`);
		}
	}

	private emit(event: Record<string, unknown>): void {
		for (const l of this.listeners) {
			try {
				l(event);
			} catch { /* 订阅方异常不影响流 */ }
		}
	}

	private warnOut(msg: string): void {
		const w = this.deps.warn;
		if (w) w(msg);
		else console.warn(`[aiti-custom-agent:${this.member.id}] ${msg}`);
	}
}
