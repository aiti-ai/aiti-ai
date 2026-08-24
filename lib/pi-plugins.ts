import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * 内置 pi 插件扫描（方案：docs/pi-models-respect-builtin-and-apikeys-plan.md §3.3）。
 *
 * 约定：往 <agentDir>/pi-plugins/<name>/ 或 <cwd>/pi-plugins/<name>/ 里放一个含
 * index.ts|js|mjs 的子目录，即成为随包分发的 pi 插件——每个 RPC 会话经 SDK 原生
 * `additionalExtensionPaths` 自动加载，无需写进 settings.json 的 packages。
 *
 * 副本来源由各扩展的 tools/deploy|install 脚本决定（构建产物拷贝 / npm 包解包）；
 * 不把插件源码 commit 进 pi-web 仓。
 *
 * 扫描结果缓存在 globalThis 上：Next.js 多编译会产生多个模块图实例，缓存保证
 * 同进程只扫一次、所有会话共享同一份路径列表。
 */
const g = globalThis as unknown as { __piBundledPiPluginPaths?: string[] };

export function bundledPiPluginPaths(): string[] {
	if (g.__piBundledPiPluginPaths) return g.__piBundledPiPluginPaths;
	const entries = new Set<string>();
	const roots: string[] = [];
	try {
		roots.push(path.join(getAgentDir(), "pi-plugins"));
	} catch {
		/* getAgentDir 不可用时跳过该根 */
	}
	roots.push(path.join(process.cwd(), "pi-plugins"));
	for (const root of roots) {
		let names: string[] = [];
		try {
			names = readdirSync(root);
		} catch {
			continue; // 目录不存在 → 跳过
		}
		for (const name of names.sort()) {
			const dir = path.join(root, name);
			for (const entry of ["index.ts", "index.js", "index.mjs"]) {
				if (existsSync(path.join(dir, entry))) {
					entries.add(path.join(dir, entry));
					break;
				}
			}
		}
	}
	const out = [...entries];
	g.__piBundledPiPluginPaths = out;
	if (out.length) console.log("[pi-web] 内置 pi 插件:", out.map((p) => path.basename(path.dirname(p))).join(", "));
	return out;
}
