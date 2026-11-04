/**
 * FsView — project 视图抽象。
 *
 * - LocalView:   单根目录（macOS/Windows 的快照目录），直接落本地 fs
 * - MergedView:  Linux overlay 语义的宿主侧实现：lower=真实项目（只读），upper=沙箱增量，
 *                读取 upper 优先、whiteout（字符设备）视为已删除；写入全部落 upper。
 *
 * 两个视图共同支撑 read/write/edit/ls/find/grep 的宿主侧工具实现，
 * bash 则总是进沙箱执行（内核 overlay 保证与视图一致）。
 */
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";

export interface DirEntry {
	name: string;
	isDirectory: boolean;
}

export interface StatLike {
	isDirectory(): boolean;
	size: number;
	mtimeMs: number;
	mode: number;
}

export interface FsView {
	readonly root: string;
	/** 读取（Buffer，binary 安全）。视图内不存在则 throw ENOENT。视图外路径直读真实 fs（只读无害）。 */
	readFile(abs: string): Promise<Buffer>;
	/** 视图内可见（未被 whiteout）则 true；视图外路径按真实 fs 判断 */
	exists(abs: string): Promise<boolean>;
	isDirectory(abs: string): Promise<boolean>;
	stat(abs: string): Promise<StatLike>;
	readdir(abs: string): Promise<DirEntry[]>;
	/** 写入（仅视图内允许；视图外 throw） */
	writeFile(abs: string, content: string | Buffer): Promise<void>;
	mkdir(abs: string): Promise<void>;
	/** 遍历视图内全部文件（合并语义），rel 为相对 root 的 posix 路径；visit 返回 false 中止 */
	walk(visit: (abs: string, rel: string) => Promise<boolean | void> | boolean | void, skip?: (rel: string) => boolean): Promise<void>;
}

function posixRel(root: string, abs: string): string {
	return path.relative(root, abs).split(path.sep).join("/");
}

/** 视图外路径（escape）判断：返回 null 表示逃逸 */
export function relWithin(root: string, abs: string): string | null {
	const r = path.relative(root, abs);
	if (r === "" ) return "";
	if (r.startsWith("..") || path.isAbsolute(r)) return null;
	return r.split(path.sep).join("/");
}

export class LocalView implements FsView {
	readonly root: string;
	constructor(root: string) {
		this.root = root;
	}

	#outside(abs: string): boolean {
		return relWithin(this.root, abs) === null;
	}

	async readFile(abs: string): Promise<Buffer> {
		return fsp.readFile(abs); // 视图内外都允许读（只读无害）
	}
	async exists(abs: string): Promise<boolean> {
		if (this.#outside(abs)) return fs.existsSync(abs);
		return fs.existsSync(abs);
	}
	async isDirectory(abs: string): Promise<boolean> {
		try {
			return fs.statSync(abs).isDirectory();
		} catch {
			return false;
		}
	}
	async stat(abs: string): Promise<StatLike> {
		return fs.statSync(abs);
	}
	async readdir(abs: string): Promise<DirEntry[]> {
		const dirents = await fsp.readdir(abs, { withFileTypes: true });
		return dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
	}
	async writeFile(abs: string, content: string | Buffer): Promise<void> {
		if (this.#outside(abs)) throw new Error(`[plan-sandbox] blocked: path outside project: ${abs}`);
		await fsp.mkdir(path.dirname(abs), { recursive: true });
		await fsp.writeFile(abs, content);
	}
	async mkdir(abs: string): Promise<void> {
		if (this.#outside(abs)) throw new Error(`[plan-sandbox] blocked: path outside project: ${abs}`);
		await fsp.mkdir(abs, { recursive: true });
	}
	async walk(visit: (abs: string, rel: string) => Promise<boolean | void> | boolean | void, skip?: (rel: string) => boolean): Promise<void> {
		const walkDir = async (dir: string): Promise<boolean> => {
			let entries: DirEntry[];
			try {
				entries = await this.readdir(dir);
			} catch {
				return true;
			}
			for (const e of entries) {
				const abs = path.join(dir, e.name);
				const rel = posixRel(this.root, abs);
				if (skip?.(rel)) continue;
				if (e.isDirectory) {
					if (!(await walkDir(abs))) return false;
				} else {
					if (!(await visit(abs, rel))) return false;
				}
			}
			return true;
		};
		await walkDir(this.root);
	}
}

/** Linux overlay 合并视图：lower=项目（只读） upper=沙箱增量（宿主侧直写 upperdir） */
export class MergedView implements FsView {
	readonly root: string; // = projectDir (= lower)
	readonly upperDir: string;
	constructor(root: string, upperDir: string) {
		this.root = root;
		this.upperDir = upperDir;
	}

	#upper(abs: string): string {
		return path.join(this.upperDir, path.relative(this.root, abs));
	}

	/** overlay whiteout：upper 中同名 char device (0,0) */
	isWhiteout(abs: string): boolean {
		try {
			return fs.lstatSync(this.#upper(abs)).isCharacterDevice();
		} catch {
			return false;
		}
	}

	#inside(abs: string): boolean {
		return relWithin(this.root, abs) !== null;
	}

	async #mergedStat(abs: string): Promise<fs.Stats | null> {
		if (this.isWhiteout(abs)) return null;
		try {
			return await fsp.stat(this.#upper(abs));
		} catch {
			/* fallthrough */
		}
		try {
			return await fsp.stat(abs);
		} catch {
			return null;
		}
	}

	async readFile(abs: string): Promise<Buffer> {
		if (!this.#inside(abs)) return fsp.readFile(abs);
		if (this.isWhiteout(abs)) throw Object.assign(new Error(`ENOENT: ${abs}`), { code: "ENOENT" });
		try {
			return await fsp.readFile(this.#upper(abs));
		} catch (e: any) {
			if (e?.code === "EISDIR") throw e;
			return fsp.readFile(abs);
		}
	}
	async exists(abs: string): Promise<boolean> {
		if (!this.#inside(abs)) return fs.existsSync(abs);
		return (await this.#mergedStat(abs)) !== null;
	}
	async isDirectory(abs: string): Promise<boolean> {
		if (!this.#inside(abs)) {
			try {
				return fs.statSync(abs).isDirectory();
			} catch {
				return false;
			}
		}
		const s = await this.#mergedStat(abs);
		return s?.isDirectory() ?? false;
	}
	async stat(abs: string): Promise<StatLike> {
		const s = await this.#mergedStat(abs);
		if (!s) throw Object.assign(new Error(`ENOENT: ${abs}`), { code: "ENOENT" });
		return s;
	}
	async readdir(abs: string): Promise<DirEntry[]> {
		if (!this.#inside(abs)) return new LocalView("/").readdir(abs);
		const up = this.#upper(abs);
		const lowerEntries: DirEntry[] = [];
		try {
			for (const d of await fsp.readdir(abs, { withFileTypes: true })) {
				lowerEntries.push({ name: d.name, isDirectory: d.isDirectory() });
			}
		} catch {
			/* lower 无此目录 */
		}
		const upperEntries: DirEntry[] = [];
		try {
			for (const d of await fsp.readdir(up, { withFileTypes: true })) {
				upperEntries.push({ name: d.name, isDirectory: d.isDirectory() });
			}
		} catch {
			/* upper 无此目录 */
		}
		const result = new Map<string, DirEntry>();
		for (const e of lowerEntries) {
			if (this.isWhiteout(path.join(abs, e.name))) continue;
			result.set(e.name, e);
		}
		for (const e of upperEntries) {
			if (e.name === ".wh..wh..opq") continue;
			if (this.isWhiteout(path.join(abs, e.name))) continue;
			let isDir = e.isDirectory;
			if (!isDir) {
				try {
					isDir = fs.statSync(path.join(up, e.name)).isDirectory();
				} catch {
					continue;
				}
			}
			result.set(e.name, { name: e.name, isDirectory: isDir });
		}
		return [...result.values()];
	}
	async writeFile(abs: string, content: string | Buffer): Promise<void> {
		if (!this.#inside(abs)) throw new Error(`[plan-sandbox] blocked: path outside project: ${abs}`);
		const up = this.#upper(abs);
		await fsp.mkdir(path.dirname(up), { recursive: true });
		await fsp.writeFile(up, content);
	}
	async mkdir(abs: string): Promise<void> {
		if (!this.#inside(abs)) throw new Error(`[plan-sandbox] blocked: path outside project: ${abs}`);
		await fsp.mkdir(this.#upper(abs), { recursive: true });
	}
	async walk(visit: (abs: string, rel: string) => Promise<boolean | void> | boolean | void, skip?: (rel: string) => boolean): Promise<void> {
		const walkDir = async (dir: string): Promise<boolean> => {
			const entries = await this.readdir(dir);
			for (const e of entries) {
				const abs = path.join(dir, e.name);
				const rel = posixRel(this.root, abs);
				if (skip?.(rel)) continue;
				if (e.isDirectory) {
					if (!(await walkDir(abs))) return false;
				} else {
					if (!(await visit(abs, rel))) return false;
				}
			}
			return true;
		};
		await walkDir(this.root);
	}
}
