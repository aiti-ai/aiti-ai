import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Bundled pi plugin scanning (design: docs/pi-models-combo-builtin-and-apikeys-plan.md §3.3).
 *
 * Convention: drop a subdirectory containing index.ts|js|mjs into
 * <agentDir>/pi-plugins/<name>/ or <cwd>/pi-plugins/<name>/ and it becomes a
 * pi plugin shipped with the package — each RPC session loads it automatically
 * via the SDK's native `additionalExtensionPaths`, no settings.json packages
 * entry needed.
 *
 * Where the copies come from is decided by each extension's tools/deploy|install
 * scripts (build-output copy / npm package unpack); plugin sources are not
 * committed to the web app repository.
 *
 * Scan results are cached on globalThis: Next.js multi-compilation creates
 * multiple module-graph instances, and the cache guarantees a single scan per
 * process with one shared path list for all sessions.
 */
const g = globalThis as unknown as { __piBundledPiPluginPaths?: string[] };

export function bundledPiPluginPaths(): string[] {
	if (g.__piBundledPiPluginPaths) return g.__piBundledPiPluginPaths;
	const entries = new Set<string>();
	const roots: string[] = [];
	try {
		roots.push(path.join(getAgentDir(), "pi-plugins"));
	} catch {
		/* Skip this root when getAgentDir is unavailable */
	}
	roots.push(path.join(process.cwd(), "pi-plugins"));
	for (const root of roots) {
		let names: string[] = [];
		try {
			names = readdirSync(root);
		} catch {
			continue; // Directory missing → skip
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
	if (out.length) console.log("[pi-web] built-in pi plugins:", out.map((p) => path.basename(path.dirname(p))).join(", "));
	return out;
}
