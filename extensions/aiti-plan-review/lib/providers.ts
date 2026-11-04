/**
 * SandboxProvider — 平台后端。
 *
 * 语义（与 docs/pi-plan-sandbox-final-design.md 对齐）：
 * - start(): 建立可丢弃快照（Linux=overlayfs 零拷贝；macOS=APFS clonefile；Windows=robocopy）
 * - bashExec(): 所有命令执行进沙箱（Linux=unshare overlay + bwrap ro 基座 + pidns）
 * - delta(): 快照增量 = 交付物候选（Linux=遍历 upperdir，whiteout=删除；复制档=git status）
 * - accept(): 仅采认声明文件拷回真实工作区
 * - destroy(): 销毁一切未采认内容
 *
 * 平台实测状态：Linux [已验证]，macOS/Windows [未验证-按设计实现]。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalView, MergedView, type FsView } from "./fsview.ts";

// ---------- 类型 ----------

export interface SandboxHandle {
	id: string;
	tier: string; // overlay | overlay-noro | copy-bwrap | copy
	projectDir: string;
	sandboxDir: string; // 隔离根（Linux=upper/work 宿主目录；复制档=快照目录）
	view: FsView; // 文件工具用的宿主侧视图
	createdAt: number;
	extra: Record<string, any>;
}

export interface Delta {
	added: string[];
	modified: string[];
	deleted: string[];
}

export interface AcceptReport {
	copied: string[];
	deleted: string[];
	failed: { path: string; error: string }[];
}

export interface ExecOptions {
	onData?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number; // 秒
	env?: NodeJS.ProcessEnv;
}

export interface SandboxProvider {
	readonly name: string;
	start(projectDir: string): Promise<SandboxHandle>;
	bashExec(h: SandboxHandle, command: string, cwd: string, opts: ExecOptions): Promise<{ exitCode: number | null }>;
	delta(h: SandboxHandle): Promise<Delta>;
	accept(h: SandboxHandle, files: string[], deletions: string[]): Promise<AcceptReport>;
	destroy(h: SandboxHandle): Promise<void>;
}

// ---------- 通用 ----------

export function sandboxBaseDir(): string {
	return path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), "plan-sandbox");
}

function newId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function envSanitized(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...process.env, ...(extra || {}) };
}

/** 流式执行（stdout+stderr 合流回调），支持 abort/超时 */
function streamExec(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; onData?: (b: Buffer) => void; signal?: AbortSignal; timeoutSec?: number }): Promise<{ exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let settled = false;
		const finish = (fn: () => void) => {
			if (!settled) {
				settled = true;
				fn();
			}
		};
		const onData = (buf: Buffer) => opts.onData?.(buf);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);

		let timedOut = false;
		const timer =
			opts.timeoutSec && opts.timeoutSec > 0
				? setTimeout(() => {
						timedOut = true;
						try {
							child.kill("SIGKILL");
						} catch {}
					}, opts.timeoutSec * 1000)
				: undefined;
		const onAbort = () => {
			try {
				child.kill("SIGKILL");
			} catch {}
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (e) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			finish(() => reject(e));
		});
		child.on("close", (code, signalName) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			finish(() => {
				if (opts.signal?.aborted) reject(new Error("Operation aborted"));
				else if (timedOut) reject(new Error(`timeout after ${opts.timeoutSec}s`));
				else resolve({ exitCode: signalName !== null ? null : code });
			});
		});
	});
}

// 进程级缓存（2026-09-10）：探测结果（unshare/bwrap 等系统工具有无）进程内不变，
// 缓存后重复探测 0 开销——spawnSync 同步探测单次可达 10s，阻塞事件循环。
const probeCache = new Map<string, boolean>();
function probe(cmd: string, args: string[], timeoutSec = 10): boolean {
	const key = cmd + "\u0000" + args.join("\u0000");
	const hit = probeCache.get(key);
	if (hit !== undefined) return hit;
	let ok = false;
	try {
		const r = spawnSync(cmd, args, { timeout: timeoutSec * 1000, stdio: "ignore", windowsHide: true });
		ok = !r.error && r.status === 0;
	} catch {
		ok = false;
	}
	probeCache.set(key, ok);
	return ok;
}

const GIT_SKIP = (rel: string) => rel === ".git" || rel.startsWith(".git/");

/** git status 解析（复制档 delta） */
async function gitDelta(root: string): Promise<Delta | null> {
	// 异步执行（2026-09-10）：大仓 git status 可达数秒，同步会阻塞 pi-web 事件循环。
	// 调用处原本就是 await gitDelta(...)，签名改动零波及。
	let out = "";
	try {
		const r = await streamExec("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
			timeoutSec: 60,
			onData: (b) => { out += b.toString("utf8"); },
		});
		if (r.exitCode !== 0 && r.exitCode !== null) return null;
	} catch {
		return null;
	}
	const delta: Delta = { added: [], modified: [], deleted: [] };
	const parts = out.split("\0").filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		const rec = parts[i];
		if (rec.length < 4) continue;
		const x = rec[0]!;
		const y = rec[1]!;
		const rel = rec.slice(3);
		if (GIT_SKIP(rel)) continue;
		if (x === "?" || y === "?" || x === "A") delta.added.push(rel);
		else if (x === "D" || y === "D") delta.deleted.push(rel);
		else delta.modified.push(rel);
	}
	return delta;
}

async function copyInto(dst: string, srcRoot: string, rel: string): Promise<void> {
	const s = path.join(srcRoot, rel);
	const d = path.join(dst, rel);
	await fsp.mkdir(path.dirname(d), { recursive: true });
	const st = await fsp.stat(s);
	await fsp.copyFile(s, d);
	await fsp.chmod(d, st.mode & 0o7777);
}

/** 安全递归删除：overlay workdir 内核产物为 root 属主，wind 权限删不动时退 sudo -n */
export async function rmRfSafe(dir: string): Promise<void> {
	try {
		await fsp.rm(dir, { recursive: true, force: true });
		return;
	} catch {}
	if (process.platform !== "win32") {
		try {
			spawnSync("sudo", ["-n", "rm", "-rf", dir], { timeout: 30_000, windowsHide: true });
		} catch {}
	}
	await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function acceptFromView(srcRoot: string, projectDir: string, files: string[], deletions: string[]): Promise<AcceptReport> {
	const report: AcceptReport = { copied: [], deleted: [], failed: [] };
	for (const rel of files) {
		try {
			await copyInto(projectDir, srcRoot, rel);
			report.copied.push(rel);
		} catch (e: any) {
			report.failed.push({ path: rel, error: String(e?.message || e) });
		}
	}
	for (const rel of deletions) {
		try {
			await fsp.rm(path.join(projectDir, rel), { recursive: true, force: true });
			report.deleted.push(rel);
		} catch (e: any) {
			report.failed.push({ path: rel, error: String(e?.message || e) });
		}
	}
	return report;
}


/** 无 git 时的对比 fallback：快照 vs 项目逐文件比较（size → 内容） */
async function diffByCompare(snapRoot: string, projectDir: string): Promise<Delta> {
	const d: Delta = { added: [], modified: [], deleted: [] };
	const snapSet = new Set<string>();
	const walk = async (root: string, cb: (abs: string, rel: string) => void) => {
		const rec = async (dir: string): Promise<void> => {
			let entries: fs.Dirent[];
			try {
				entries = await fsp.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const abs = path.join(dir, e.name);
				const rel = path.relative(root, abs).split(path.sep).join("/");
				if (GIT_SKIP(rel)) continue;
				if (e.isDirectory()) await rec(abs);
				else if (e.isFile()) cb(abs, rel);
			}
		};
		await rec(root);
	};
	await walk(snapRoot, (_abs, rel) => snapSet.add(rel));
	await walk(projectDir, (_abs, rel) => {
		if (!snapSet.has(rel)) d.deleted.push(rel);
	});
	for (const rel of snapSet) {
		const s = path.join(snapRoot, rel);
		const p = path.join(projectDir, rel);
		if (!fs.existsSync(p)) {
			d.added.push(rel);
			continue;
		}
		try {
			const a = fs.statSync(s);
			const b = fs.statSync(p);
			if (a.size !== b.size) {
				d.modified.push(rel);
				continue;
			}
			const c1 = await fsp.readFile(s);
			const c2 = await fsp.readFile(p);
			if (!c1.equals(c2)) d.modified.push(rel);
		} catch {}
	}
	return d;
}

// ---------- Linux ----------

/** /proc/self/mountinfo 顶层真实挂载（供 bwrap 显式 ro-bind；bwrap 的 bind 不递归） */
function hostTopMounts(): string[] {
	const out: string[] = [];
	try {
		const text = fs.readFileSync("/proc/self/mountinfo", "utf8");
		for (const line of text.split("\n")) {
			const idx = line.indexOf(" - ");
			if (idx < 0) continue;
			const left = line.slice(0, idx).split(" ");
			const right = line.slice(idx + 3).split(" ");
			const mpt = left[4];
			const fstype = right[0];
			if (!mpt || !mpt.startsWith("/")) continue;
			if (mpt === "/") continue; // 根挂载由 #bwrapArgs 开头统一 --ro-bind / /；重复 ro-bind 根会破坏 --dev /dev（/dev/null 必现 Permission denied，2026-09-01）
			const depth = mpt.split("/").length - 1;
			if (depth !== 1) continue;
			if (["proc", "sysfs", "devtmpfs", "devpts", "mqueue", "tmpfs", "cgroup", "cgroup2", "bpf", "tracefs", "debugfs", "securityfs", "pstore", "efivarfs", "configfs", "fusectl", "autofs", "binfmt_misc", "hugetlbfs", "overlay"].includes(fstype)) continue;
			if (fstype.startsWith("fuse") || /^(nfs|nfs4|cifs|smb|9p|ncp)/.test(fstype)) continue;
			out.push(mpt);
		}
	} catch {}
	return [...new Set(out)];
}

function linuxTmpGuard(projectDir: string): { tmpfsArgs: string[]; tmpDir: string } {
	// 项目若在某目录之下，则不能 tmpfs 盖掉它
	const guards: Array<[string, string]> = [
		["/tmp", "/tmp"],
		["/run", "/run"],
		["/var/tmp", "/var/tmp"],
	];
	const tmpfsArgs: string[] = [];
	let tmpDir = "/tmp";
	for (const [dir, mnt] of guards) {
		if (projectDir === dir || projectDir.startsWith(dir + "/")) {
			if (dir === "/tmp") tmpDir = "/var/tmp";
			continue;
		}
		tmpfsArgs.push("--tmpfs", mnt);
	}
	return { tmpfsArgs, tmpDir };
}

export const __DBG = "/tmp/psb-debug.log";
function dbgP(msg: string): void {
	try {
		fs.appendFileSync(__DBG, `${new Date().toISOString()} [prov] ${msg}\n`);
	} catch {}
}

class LinuxProvider implements SandboxProvider {
	readonly name = "linux";
	#tier: "overlay" | "overlay-noro" | "copy-bwrap" | "copy" = "copy";

	async start(projectDir: string, forceTier?: string): Promise<SandboxHandle> {
		projectDir = fs.realpathSync(projectDir);
		const id = newId();
		const sandboxDir = path.join(sandboxBaseDir(), id);
		await fsp.mkdir(path.join(sandboxDir, "upper"), { recursive: true });
		await fsp.mkdir(path.join(sandboxDir, "work"), { recursive: true });

		dbgP("start entry");
		const hasUnshare = probe("unshare", ["--user", "--map-root-user", "--mount", "true"]);
		dbgP(`hasUnshare=${hasUnshare}`);
		const hasBwrap = probe("bwrap", ["--version"]);
		dbgP(`hasBwrap=${hasBwrap}`);
		const { tmpfsArgs, tmpDir } = linuxTmpGuard(projectDir);

		let candidates: string[] = [];
		if (hasUnshare && hasBwrap) candidates.push("overlay");
		if (hasBwrap) candidates.push("copy-bwrap");
		if (hasUnshare) candidates.push("overlay-noro");
		candidates.push("copy");
		if (forceTier) candidates = candidates.includes(forceTier) ? [forceTier] : [];

		const errors: string[] = [];
		for (const tier of candidates) {
			try {
				const snapDir = tier === "copy-bwrap" || tier === "copy" ? path.join(sandboxDir, "snapshot") : undefined;
				if (snapDir) await fsp.cp(projectDir, snapDir, { recursive: true, verbatimSymlinks: false });
				const h: SandboxHandle = {
					id,
					tier,
					projectDir,
					sandboxDir,
					view:
						tier === "overlay" || tier === "overlay-noro"
							? new MergedView(projectDir, path.join(sandboxDir, "upper"))
							: new LocalView(snapDir!),
					createdAt: Date.now(),
					extra: { tmpfsArgs, tmpDir, snapshotDir: snapDir, errors },
				};
				dbgP(`tier=${tier} probe bash…`);
				const r = await this.bashExec(h, "true", projectDir, { timeoutSec: 30 });
				dbgP(`probe exit=${r.exitCode}`);
				if (r.exitCode !== 0) throw new Error(`probe exit=${r.exitCode}`);
				this.#tier = tier;
				return h;
			} catch (e: any) {
				dbgP(`tier ${tier} FAIL: ${e?.stack || e}`);
				errors.push(`${tier}: ${String(e?.message || e)}`);
			}
		}
		throw new Error(`[plan-sandbox] no usable linux tier: ${errors.join("; ")}`);
	}

	#overlayMountScript(h: SandboxHandle): string {
		const upper = path.join(h.sandboxDir, "upper");
		const work = path.join(h.sandboxDir, "work");
		return [
			"set -e",
			"mount --make-rprivate /",
			`mount -t overlay -o lowerdir=${shq(h.projectDir)},upperdir=${shq(upper)},workdir=${shq(work)} overlay ${shq(h.projectDir)}`,
		].join("\n");
	}

	#bwrapArgs(h: SandboxHandle): string[] {
		const { tmpfsArgs } = h.extra;
		const args = [
			"--unshare-user",
			"--unshare-pid",
			"--unshare-ipc",
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--proc",
			"/proc",
		];
		for (const m of hostTopMounts()) {
			if (tmpfsArgs.includes(m)) continue; // 被 tmpfs 覆盖的不重复 bind
			args.push("--ro-bind", m, m);
		}
		args.push(...tmpfsArgs);
		args.push("--die-with-parent", "--bind", h.projectDir, h.projectDir);
		return args;
	}

	async bashExec(h: SandboxHandle, command: string, cwd: string, opts: ExecOptions): Promise<{ exitCode: number | null }> {
		const rel = path.relative(h.projectDir, cwd);
		const cwdInside = !rel.startsWith("..") && !path.isAbsolute(rel) ? h.projectDir : h.projectDir;
		const env = envSanitized({
			...(opts.env || {}),
			TMPDIR: h.extra.tmpDir,
			TEMP: h.extra.tmpDir,
			TMP: h.extra.tmpDir,
			XDG_CACHE_HOME: path.join(h.extra.tmpDir, "cache"),
			npm_config_cache: path.join(h.extra.tmpDir, "cache"),
		});
		const cacheArg = `mkdir -p ${shq(path.join(h.extra.tmpDir, "cache"))} 2>/dev/null;`;

		if (h.tier === "overlay") {
			const script = [
				this.#overlayMountScript(h),
				`exec bwrap ${this.#bwrapArgs(h).map(shq).join(" ")} bash -c ${shq(cacheArg + " " + command)}`,
			].join("\n");
			return streamExec("unshare", ["--user", "--map-root-user", "--mount", "bash", "-c", script], {
				cwd: cwdInside,
				env,
				onData: opts.onData,
				signal: opts.signal,
				timeoutSec: opts.timeout,
			});
		}
		if (h.tier === "copy-bwrap") {
			return streamExec("bwrap", [...this.#bwrapArgs(h), "bash", "-c", cacheArg + " " + command], {
				cwd: h.extra.snapshotDir,
				env,
				onData: opts.onData,
				signal: opts.signal,
				timeoutSec: opts.timeout,
			});
		}
		if (h.tier === "overlay-noro") {
			const script = [
				this.#overlayMountScript(h),
				"mount -t proc proc /proc 2>/dev/null || true",
				`export TMPDIR=${shq(h.extra.tmpDir)} XDG_CACHE_HOME=${shq(path.join(h.extra.tmpDir, "cache"))} npm_config_cache=${shq(path.join(h.extra.tmpDir, "cache"))};`,
				cacheArg,
				`exec bash -c ${shq(command)}`,
			].join("\n");
			return streamExec("unshare", ["--user", "--map-root-user", "--mount", "--pid", "bash", "-c", script], {
				cwd: cwdInside,
				env,
				onData: opts.onData,
				signal: opts.signal,
				timeoutSec: opts.timeout,
			});
		}
		// copy：无防护兜底
		return streamExec("bash", ["-c", command], {
			cwd: h.extra.snapshotDir,
			env,
			onData: opts.onData,
			signal: opts.signal,
			timeoutSec: opts.timeout,
		});
	}

	/** upper 内全部目录的 opaque 标记集合（user.overlay.opaque，非特权 overlay 变体） */
	#detectOpaqueDirs(upper: string): Promise<Set<string>> {
		const dirs: string[] = [];
		const rec = (d: string) => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(d, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				if (e.isDirectory()) {
					const abs = path.join(d, e.name);
					dirs.push(abs);
					rec(abs);
				}
			}
		};
		try {
			rec(upper);
			rec(upper); // 两遍确保嵌套完整
		} catch {}
		if (dirs.length === 0) return Promise.resolve(new Set());
		return new Promise((resolve) => {
			const py = spawn(
				"python3",
				[
					"-c",
					`import os,sys,json
out={}
for p in sys.argv[1:]:
    try:
        if os.getxattr(p,'user.overlay.opaque')==b'y': out[p]=True
    except OSError: pass
print(json.dumps(list(out)))`,
					...dirs,
				],
				{ windowsHide: true, timeout: 15_000 },
			);
			let buf = "";
			py.stdout?.on("data", (d: Buffer) => (buf += d.toString()));
			py.on("error", () => resolve(new Set()));
			py.on("close", () => {
				try {
					resolve(new Set(JSON.parse(buf) as string[]));
				} catch {
					resolve(new Set());
				}
			});
		});
	}

	async delta(h: SandboxHandle): Promise<Delta> {
		if (h.tier === "copy-bwrap" || h.tier === "copy") {
			return (await gitDelta(h.extra.snapshotDir)) ?? diffByCompare(h.extra.snapshotDir, h.projectDir);
		}
		const upper = path.join(h.sandboxDir, "upper");
		const opaqueDirs = await this.#detectOpaqueDirs(upper); // 绝对路径集合
		const underOpaque = (rel: string): boolean => {
			for (const o of opaqueDirs) {
				const orel = path.relative(upper, o).split(path.sep).join("/");
				if (orel && (rel === orel || rel.startsWith(orel + "/"))) return true;
			}
			return false;
		};
		const inUpper = (rel: string): boolean => fs.existsSync(path.join(upper, rel));
		const delta: Delta = { added: [], modified: [], deleted: [] };
		const seen = new Set<string>();

		// lower 侧：whiteout / opaque 遮蔽 → deleted；upper 同名 → modified
		const walkLower = async (dir: string): Promise<void> => {
			let entries: fs.Dirent[];
			try {
				entries = await fsp.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const abs = path.join(dir, e.name);
				const rel = path.relative(h.projectDir, abs).split(path.sep).join("/");
				if (GIT_SKIP(rel) || seen.has(rel)) continue;
				if (e.isDirectory()) {
					if (underOpaque(rel) && !inUpper(rel)) {
						// 整个目录被 opaque 遮蔽：lower 子树全记删除
						const rec = (dd: string, rr: string) => {
							let es: fs.Dirent[];
							try {
								es = fs.readdirSync(dd, { withFileTypes: true });
							} catch {
								return;
							}
							for (const x of es) {
								const xa = path.join(dd, x.name);
								const xr = path.relative(h.projectDir, xa).split(path.sep).join("/");
								if (x.isDirectory()) rec(xa, xr);
								else {
									delta.deleted.push(xr);
									seen.add(xr);
								}
							}
						};
						rec(abs, rel);
						continue;
					}
					await walkLower(abs);
					continue;
				}
				seen.add(rel);
				const upAbs = path.join(upper, rel);
				let upStat: fs.Stats | null = null;
				try {
					upStat = fs.lstatSync(upAbs);
				} catch {}
				if (upStat?.isCharacterDevice()) delta.deleted.push(rel); // whiteout
				else if (upStat) delta.modified.push(rel);
				else if (underOpaque(rel)) delta.deleted.push(rel); // opaque 目录遮蔽：lower 文件实际已被隐藏/删除
			}
		};
		await walkLower(h.projectDir);

		// whiteout（upper 顶层 char device）
		const walkWhiteouts = async (dir: string): Promise<void> => {
			let entries: fs.Dirent[];
			try {
				entries = await fsp.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const abs = path.join(dir, e.name);
				const rel = path.relative(upper, abs).split(path.sep).join("/");
				if (e.isCharacterDevice()) {
					if (!seen.has(rel) && !GIT_SKIP(rel)) {
						delta.deleted.push(rel);
						seen.add(rel);
					}
				} else if (e.isDirectory()) await walkWhiteouts(abs);
			}
		};
		await walkWhiteouts(upper);

		// upper 侧：added
		const walkUpper = async (dir: string): Promise<void> => {
			let entries: fs.Dirent[];
			try {
				entries = await fsp.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const abs = path.join(dir, e.name);
				const rel = path.relative(upper, abs).split(path.sep).join("/");
				if (GIT_SKIP(rel)) continue;
				if (e.isDirectory()) await walkUpper(abs);
				else if (!seen.has(rel) && !fs.existsSync(path.join(h.projectDir, rel))) {
					delta.added.push(rel);
					seen.add(rel);
				} else if (!seen.has(rel)) {
					delta.modified.push(rel);
					seen.add(rel);
				}
			}
		};
		await walkUpper(upper);
		return delta;
	}

	async accept(h: SandboxHandle, files: string[], deletions: string[]): Promise<AcceptReport> {
		if (h.tier === "copy-bwrap" || h.tier === "copy") return acceptFromView(h.extra.snapshotDir, h.projectDir, files, deletions);
		return acceptFromView(path.join(h.sandboxDir, "upper"), h.projectDir, files, deletions);
	}

	async destroy(h: SandboxHandle): Promise<void> {
		await rmRfSafe(h.sandboxDir);
	}
}

// ---------- macOS ----------

const SEATBELT_PROFILE = (snap: string, tmp: string) => `(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath "${snap}")
  (subpath "${tmp}")
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (subpath "/dev"))
`; // [未验证-macOS] signal 限制暂不启用，避免破坏 shell 作业控制

export class MacProvider implements SandboxProvider {
	readonly name = "macos";
	#useSeatbelt = false;

	async start(projectDir: string): Promise<SandboxHandle> {
		if (process.platform !== "darwin") throw new Error("macos provider on non-darwin");
		projectDir = fs.realpathSync(projectDir);
		const id = newId();
		// 与 Linux provider 一致：沙箱统一落 sandboxBaseDir() 下（findResumable 只扫 base，
		// 之前 mkdtemp 到 $TMPDIR 根导致 macOS 沙箱跨会话 resume 永远识别不到）
		const base = sandboxBaseDir();
		fs.mkdirSync(base, { recursive: true });
		const sandboxDir = path.join(base, id);
		fs.mkdirSync(sandboxDir, { recursive: true });
		const snapshotDir = path.join(sandboxDir, "snapshot");
		const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
		// APFS clonefile 瞬时克隆；失败退普通拷贝。异步执行（2026-09-10）：GB 级项目
		// 降级 cp -R 时同步等待会冻结 pi-web 事件循环数分钟。
		const r = await streamExec("/bin/bash", ["-c", `cp -cR ${q(projectDir)}/. ${q(snapshotDir)}/ || cp -R ${q(projectDir)}/. ${q(snapshotDir)}/`], {
			timeoutSec: 1800,
		});
		if (r.exitCode !== 0) throw new Error(`[plan-sandbox] clone 失败: exit ${r.exitCode}`);
		const seatProfile = path.join(sandboxDir, "seatbelt.sb");
		fs.writeFileSync(seatProfile, SEATBELT_PROFILE(snapshotDir, path.join(sandboxDir, "tmp")));
		fs.mkdirSync(path.join(sandboxDir, "tmp"), { recursive: true });
		this.#useSeatbelt = fs.existsSync("/usr/bin/sandbox-exec") && probe("/usr/bin/sandbox-exec", ["-f", seatProfile, "/usr/bin/true"]);
		return {
			id,
			tier: this.#useSeatbelt ? "clone+seatbelt" : "clone",
			projectDir,
			sandboxDir,
			view: new LocalView(snapshotDir),
			createdAt: Date.now(),
			extra: { snapshotDir, seatProfile },
		};
	}

	async bashExec(h: SandboxHandle, command: string, cwd: string, opts: ExecOptions): Promise<{ exitCode: number | null }> {
		const rel = path.relative(h.extra.snapshotDir, path.resolve(cwd));
		const cwd2 = !rel.startsWith("..") && !path.isAbsolute(rel) ? path.resolve(cwd) : h.extra.snapshotDir;
		const args = this.#useSeatbelt
			? ["/usr/bin/sandbox-exec", "-f", h.extra.seatProfile, "/bin/bash", "-c", command]
			: ["/bin/bash", "-c", command];
		return streamExec(args[0]!, args.slice(1), {
			cwd: cwd2,
			env: envSanitized(opts.env),
			onData: opts.onData,
			signal: opts.signal,
			timeoutSec: opts.timeout,
		});
	}

	async delta(h: SandboxHandle): Promise<Delta> {
		return (await gitDelta(h.extra.snapshotDir)) ?? diffByCompare(h.extra.snapshotDir, h.projectDir);
	}

	async accept(h: SandboxHandle, files: string[], deletions: string[]): Promise<AcceptReport> {
		return acceptFromView(h.extra.snapshotDir, h.projectDir, files, deletions);
	}

	async destroy(h: SandboxHandle): Promise<void> {
		await rmRfSafe(h.sandboxDir);
	}
}

// ---------- Windows ----------

export class WindowsProvider implements SandboxProvider {
	readonly name = "windows"; // [未验证-Windows] C 档：robocopy 快照 + cmd 执行 + pid 树收割
	async start(projectDir: string): Promise<SandboxHandle> {
		projectDir = fs.realpathSync(projectDir);
		const id = newId();
		// 与 Linux provider 一致：沙箱统一落 sandboxBaseDir() 下（findResumable 只扫 base）
		const base = sandboxBaseDir();
		fs.mkdirSync(base, { recursive: true });
		const sandboxDir = path.join(base, id);
		fs.mkdirSync(sandboxDir, { recursive: true });
		const snapshotDir = path.join(sandboxDir, "snapshot");
		const r = spawnSync("robocopy", [projectDir, snapshotDir, "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"], {
			windowsHide: true,
		});
		if ((r.status ?? 99) >= 8) throw new Error(`[plan-sandbox] robocopy 失败 rc=${r.status}`);
		return {
			id,
			tier: "robocopy",
			projectDir,
			sandboxDir,
			view: new LocalView(snapshotDir),
			createdAt: Date.now(),
			extra: { snapshotDir, pids: [] as number[] },
		};
	}

	async bashExec(h: SandboxHandle, command: string, cwd: string, opts: ExecOptions): Promise<{ exitCode: number | null }> {
		const rel = path.relative(h.extra.snapshotDir, path.resolve(cwd));
		const cwd2 = !rel.startsWith("..") && !path.isAbsolute(rel) ? path.resolve(cwd) : h.extra.snapshotDir;
		const child = spawn("cmd.exe", ["/d", "/s", "/c", command], {
			cwd: cwd2,
			env: envSanitized(opts.env),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		h.extra.pids.push(child.pid);
		return new Promise((resolve, reject) => {
			let timedOut = false;
			const timer =
				opts.timeout && opts.timeout > 0
					? setTimeout(() => {
							timedOut = true;
							spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true });
						}, opts.timeout * 1000)
					: undefined;
			const onData = (b: Buffer) => opts.onData?.(b);
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			child.on("error", (e) => {
				clearTimeout(timer);
				reject(e);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (opts.signal?.aborted) reject(new Error("Operation aborted"));
				else if (timedOut) reject(new Error(`timeout after ${opts.timeout}s`));
				else resolve({ exitCode: code });
			});
		});
	}

	async delta(h: SandboxHandle): Promise<Delta> {
		return (await gitDelta(h.extra.snapshotDir)) ?? diffByCompare(h.extra.snapshotDir, h.projectDir);
	}

	async accept(h: SandboxHandle, files: string[], deletions: string[]): Promise<AcceptReport> {
		return acceptFromView(h.extra.snapshotDir, h.projectDir, files, deletions);
	}

	async destroy(h: SandboxHandle): Promise<void> {
		for (const pid of h.extra.pids || []) {
			try {
				spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true });
			} catch {}
		}
		await rmRfSafe(h.sandboxDir);
	}
}

// ---------- 选择 ----------

export function createProvider(): SandboxProvider {
	switch (process.platform) {
		case "linux":
			return new LinuxProvider();
		case "darwin":
			return new MacProvider();
		case "win32":
			return new WindowsProvider();
		default:
			throw new Error(`[plan-sandbox] unsupported platform: ${process.platform}`);
	}
}
