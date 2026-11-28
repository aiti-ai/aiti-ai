/**
 * agent-capability-contract — static cross-check of Agent-class extension capability declarations ↔ handle method existence
 * (debt-list docs/pi-web-ext-agent-authoring-debt.md D2 regression guard).
 *
 * Mechanism: the adapter layer (pi-web lib/session/handle-adapter.ts) handles steer/followUp-style commands as
 * "cap("X") passes → await h.X!()" — declaring true without the method is a runtime TypeError;
 * a wrong getMessages name goes fail-loud as UnsupportedCapability (no crash, but the feature is missing).
 * This test statically scans pi-web-ext/aiti-*-agent *.ts sources (no import, zero side effects):
 *   1. collect line by line the known capability keys declared `true` (comment lines excluded);
 *   2. cross-check against "method definition line patterns" and the exemption table (declarations with no method surface);
 *   3. declared true but found in neither → fail, hinting to add the method or change to false + a fail-loud stub.
 *
 * Run: node --experimental-strip-types --test pi-web-ext/_shared/agent-capability-contract.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** capability key → handle method names (multiple candidates = any one present suffices).
 *  Based on the lookup names in pi-web's handle-adapter.ts command table. */
const CAP_TO_METHODS = {
	prompt: ["prompt"],
	abort: ["abort"],
	steer: ["steer"],
	followUp: ["followUp"],
	getMessages: ["getMessages"],
	getUsage: ["getUsage"],
	contextUsage: ["getContextUsage"],
	getCommands: ["getCommands"],
	respondPermission: ["respondPermission"],
	respondInteraction: ["respondInteraction"],
	queueManage: ["queueManage"],
	setModel: ["setModel"],
	setThinkingLevel: ["setThinkingLevel"],
	setPermissionMode: ["setPermissionMode"],
	fork: ["fork"],
	renameSession: ["setSessionName"], // adapter set_session_name → h.setSessionName!()
	compact: ["compact"],
	executeBash: ["executeBash"],
	setActiveTools: ["setActiveTools"],
	navigateTree: ["navigateTree"],
	deleteSession: ["deleteSession"],
	listModels: ["getAvailableModels"],
	// adapter get_tools goes through the h.send direct channel or the getAllTools snapshot, either suffices
	listTools: ["getAllTools", "getTools", "send"],
};

/** Capabilities with no standalone method surface (declaring true is legal, no method needed): */
const CAP_EXEMPT = new Set([
	"fileAttachments", // prompt images parameter surface; the ACP instance narrows by initialize promptCapabilities
]);

const KNOWN_KEYS = new Set([...Object.keys(CAP_TO_METHODS), ...CAP_EXEMPT]);

/** Method definition line patterns (line by line; excludes calls — calls carry a `.` / `!` prefix or mismatched indentation):
 *   async followUp(text: string): Promise<void> {   /   getUsage() {   /
 *   queueManage = (req: {...}) => ...               /   private steer(): never { */
function methodDefined(src, method) {
	const esc = method.replace(/\$/g, "\\$");
	const reDef = new RegExp(`^\\s*(?:private\\s+|protected\\s+|public\\s+)?(?:readonly\\s+)?(?:async\\s+)?${esc}\\s*[<(]`);
	const reArrow = new RegExp(`^\\s*(?:private\\s+|readonly\\s+)?${esc}\\s*=\\s*(?:async\\s*)?\\(`);
	return src.split(/\r?\n/).some((line) => {
		const t = line.trim();
		if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
		return reDef.test(line) || reArrow.test(line);
	});
}

function listAgentExts() {
	return readdirSync(ROOT)
		.filter((name) => name.startsWith("aiti-") && name.endsWith("-agent"))
		.filter((name) => statSync(join(ROOT, name)).isDirectory())
		// Real extension checkouts only: a stale dir holding just an ignored dist/
		// (removed extension, build artifact left behind) must not enter the matrix —
		// the aiti-opencode-agent removal left exactly such a shell (2026-11-14)
		.filter((name) => existsSync(join(ROOT, name, "package.json")))
		.sort();
}

function listTsFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) {
			if (name === "node_modules" || name === "dist" || name === "tools" || name === "client") continue;
			out.push(...listTsFiles(p));
		} else if (name.endsWith(".ts")) {
			out.push(p);
		}
	}
	return out;
}

for (const ext of listAgentExts()) {
	test(`[${ext}] capability declaration ↔ handle method cross-check (D2 regression guard)`, () => {
		const files = listTsFiles(join(ROOT, ext));
		assert.ok(files.length, `${ext}: no .ts source files found`);
		const src = files.map((p) => readFileSync(p, "utf8")).join("\n");

		// collect known capability keys declared true (pure comment lines excluded)
		const claimed = new Map(); // key -> description of the first declaration site
		for (const file of files) {
			for (const [i, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
				const t = line.trim();
				if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
				const m = t.match(/^([A-Za-z]\w*):\s*true\b/);
				if (m && KNOWN_KEYS.has(m[1]) && !claimed.has(m[1])) {
					claimed.set(m[1], `${file.replace(ROOT + "/", "")}:${i + 1}`);
				}
			}
		}

		const problems = [];
		for (const [key, at] of [...claimed].sort()) {
			if (CAP_EXEMPT.has(key)) continue;
			const candidates = CAP_TO_METHODS[key] ?? [];
			const found = candidates.find((m) => methodDefined(src, m));
			if (!found) {
				problems.push(
					`capabilities.${key}: true (${at}) but no matching method (${candidates.join("/")}) — ` +
					`the adapter call would be a TypeError/UnsupportedCapability; implement the method or change to false + a fail-loud stub`,
				);
			}
		}
		assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
	});
}
