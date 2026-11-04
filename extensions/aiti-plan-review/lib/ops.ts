/**
 * 工具 ops 构建：read/write/edit/ls/find/grep 全部基于 FsView（合并视图或快照视图）。
 * 从 index.ts 抽出以便独立测试（本模块无 pi 运行时依赖，仅类型）。
 */
import path from "node:path";
import type {
	BashOperations,
	ExtensionContext,
	FindOperations,
	GrepToolDetails,
	GrepToolInput,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine } from "@earendil-works/pi-coding-agent";
import type { FsView } from "./fsview.ts";
import type { SandboxHandle, SandboxProvider } from "./providers.ts";

const DEFAULT_GREP_LIMIT = 100;

// ---------------- 路径映射 ----------------

/** copy 档：模型看到的真实项目绝对路径 → 快照路径；Linux 档：恒等 */
export function mapToView(h: SandboxHandle, abs: string): string {
if (h.view.root === h.projectDir) return abs;
const rel = path.relative(h.projectDir, abs);
if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
	return path.join(h.view.root, rel);
}
return abs;
}

export function relWithin(root: string, abs: string): string | null {
const r = path.relative(root, abs);
if (r === "") return "";
if (r.startsWith("..") || path.isAbsolute(r)) return null;
return r.split(path.sep).join("/");
}

// ---------------- 工具 ops 构造 ----------------

export function buildReadOps(h: SandboxHandle): ReadOperations {
const v = h.view;
return {
	readFile: (abs) => v.readFile(mapToView(h, abs)),
	access: async (abs) => {
		await v.stat(mapToView(h, abs));
	},
	detectImageMimeType: async (abs) => {
		const ext = path.extname(abs).toLowerCase();
		return ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"] as const).includes(ext as any)
			? ext === ".jpg"
				? "image/jpeg"
				: ext === ".jpeg"
					? "image/jpeg"
					: ext === ".bmp"
						? "image/bmp"
						: `image/${ext.slice(1)}`
			: null;
	},
};
}

export function buildWriteOps(h: SandboxHandle): WriteOperations {
const v = h.view;
return {
	writeFile: (abs, content) => v.writeFile(mapToView(h, abs), content),
	mkdir: (abs) => v.mkdir(mapToView(h, abs)),
};
}

export function buildEditOps(h: SandboxHandle): EditOperations {
const read = buildReadOps(h);
const write = buildWriteOps(h);
return { readFile: read.readFile, writeFile: write.writeFile, access: read.access };
}

export function buildLsOps(h: SandboxHandle): LsOperations {
const v = h.view;
return {
	exists: (abs) => v.exists(mapToView(h, abs)),
	stat: (abs) => v.stat(mapToView(h, abs)),
	readdir: (abs) => v.readdir(mapToView(h, abs)),
};
}

export function matchesToolGlob(rel: string, pattern: string): boolean {
const p = pattern.split(path.sep).join("/");
if (p.includes("/")) {
	return path.posix.matchesGlob(rel, p) || path.posix.matchesGlob(rel, `**/${p}`);
}
return path.posix.matchesGlob(path.posix.basename(rel), p);
}

export function buildFindOps(h: SandboxHandle): FindOperations {
const v = h.view;
return {
	exists: (abs) => v.exists(mapToView(h, abs)),
	glob: async (pattern, cwd, options) => {
		const searchRoot = mapToView(h, path.resolve(cwd));
		const results: string[] = [];
		await v.walk(
			async (abs) => {
				if (results.length >= options.limit) return false;
				const relToRoot = relWithin(v.root, abs);
				const relToCwd = path.relative(searchRoot, abs).split(path.sep).join("/");
				if (matchesToolGlob(relToCwd, pattern) || (relToRoot && matchesToolGlob(relToRoot, pattern))) {
					results.push(abs);
					return results.length < options.limit;
				}
				return true;
			},
			(rel) => rel === ".git" || rel.startsWith(".git/") || rel === "node_modules" || rel.startsWith("node_modules/"),
		);
		return results;
	},
};
}

export function buildBashOps(h: SandboxHandle, provider: SandboxProvider): BashOperations {
return {
	exec: (command, cwd, { onData, signal, timeout, env }) => {
		const viewCwd = mapToView(h, path.resolve(cwd));
		return provider.bashExec(h, command, viewCwd, { onData, signal, timeout, env });
	},
};
}

// ---------------- grep（遍历式实现，读合并视图） ----------------

export async function executeGrep(
h: SandboxHandle,
params: GrepToolInput,
signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: GrepToolDetails | undefined }> {
const v = h.view;
const rootAbs = path.resolve(h.projectDir, params.path ?? ".");
const searchAbs = mapToView(h, rootAbs);
const searchRel = relWithin(v.root, searchAbs) ?? "";
const matcher = params.literal
	? (line: string) => (params.ignoreCase ? line.toLowerCase() : line).includes(params.ignoreCase ? params.pattern.toLowerCase() : params.pattern)
	: (line: string) => new RegExp(params.pattern, params.ignoreCase ? "i" : undefined).test(line);
const contextLines = params.context && params.context > 0 ? params.context : 0;
const limit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
const outputLines: string[] = [];
const details: GrepToolDetails = {};
let matchCount = 0;
let limitReached = false;
let linesTruncated = false;

const isDir = await v.isDirectory(searchAbs);
const outsideSearch = relWithin(v.root, searchAbs) === null;

const scanFile = async (abs: string, displayPath: string): Promise<boolean> => {
	let content: string;
	try {
		content = (await v.readFile(abs)).toString("utf-8");
	} catch {
		return true;
	}
	const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (signal?.aborted) throw new Error("Operation aborted");
		if (!matcher(lines[i] ?? "")) continue;
		matchCount++;
		const start = Math.max(0, i - contextLines);
		const end = Math.min(lines.length - 1, i + contextLines);
		for (let j = start; j <= end; j++) {
			const { text, wasTruncated } = truncateLine((lines[j] ?? "").replace(/\r/g, ""));
			if (wasTruncated) linesTruncated = true;
			outputLines.push(`${displayPath}${j === i ? ":" : "-"}${j + 1}: ${text}`);
		}
		if (matchCount >= limit) {
			limitReached = true;
			return false;
		}
	}
	return true;
};

if (!isDir) {
	await scanFile(searchAbs, path.basename(searchAbs));
} else if (outsideSearch) {
	return { content: [{ type: "text", text: "No matches found" }], details: undefined }; // 项目外目录不做全库扫描
} else {
	await v.walk(
		async (abs, rel) => {
			const displayPath = searchRel ? path.relative(searchAbs, abs).split(path.sep).join("/") : rel;
			return await scanFile(abs, displayPath);
		},
		(rel) => rel === ".git" || rel.startsWith(".git/") || rel === "node_modules" || rel.startsWith("node_modules/"),
	);
}

if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
let output = outputLines.join("\n");
const notices: string[] = [];
if (limitReached) {
	details.matchLimitReached = limit;
	notices.push(`${limit} matches limit reached`);
}
if (linesTruncated) {
	details.linesTruncated = true;
	notices.push("long lines truncated");
}
const trunc = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
if (trunc.truncated) {
	details.truncation = trunc;
	output = trunc.content;
	notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
}
if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
return { content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined };
}


