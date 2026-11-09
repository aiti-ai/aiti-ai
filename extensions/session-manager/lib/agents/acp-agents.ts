/**
 * session-manager — ACP-family CLI adapters (2026-11-08 batch).
 *
 * Covers session stores of ACP-driver agents (aiti-acp-agent 25-family list)
 * that had no session-manager resolver yet. Store layouts verified against
 * local installs where marked; the rest follow binary-extracted/bundle-extracted
 * evidence and parse defensively (simple-cli.ts precedent) — re-verify on
 * first login:
 *
 *   omp    ~/.omp/agent/sessions/<cwd-enc>/<ts>_<sid>.jsonl  (oh-my-pi pi-fork wire; VERIFIED on 18.x)
 *   kiro   ~/.kiro/sessions/<depth>/conversation_log.jsonl        (Kiro CLI = Q-CLI rebrand; binary strings)
 *   auggie ~/.augment/sessions/<sid>.json                    (turns/chunks doc; auggie bundle strings)
 *   vibe   ~/.vibe/logs/session/**                           (SESSION_LOG_DIR from vibe source; line shape unverified)
 *
 * qwen rides createGeminiAdapter(".qwen") (gemini-cli fork, same store shape).
 * grok / junie / hermes stay unadapted until a real store is observable
 * (CLIs blocked/unlogged on the dev machine) — see registry.ts note.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import { artifactPrimitives, artifactCapabilities } from "./archive-artifact.ts";
import { statFreshList } from "./fresh.ts";
import type { IndexedMessage } from "../session-file.ts";

function textOf(v: unknown): string {
	if (typeof v === "string") return v;
	if (Array.isArray(v)) {
		return v
			.filter((c) => c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string")
			.map((c) => (c as { text: string }).text)
			.join("\n");
	}
	return "";
}

/** Content-block arrays may carry thinking/toolCall blocks — text only, other shapes skipped. */
function blocksText(content: unknown): string {
	const s = textOf(content);
	return s.trim();
}

function mtimeIso(path: string): string {
	try { return statSync(path).mtime.toISOString(); } catch { return new Date().toISOString(); }
}

/* ── omp (Oh My Pi, pi fork) ──
 * ~/.omp/agent/sessions/<cwd-enc>/<ISO-ts>_<uuid>.jsonl
 * pi-wire lines: {type:"session", id, cwd, timestamp} / {type:"title", title} /
 *   {type:"message", timestamp, message:{role, content:[{type:"text"|"thinking"|"toolCall",...}]}}
 * cwd-enc = absolute path with "/" folded to "-" ("/tmp" → "-tmp"); opaque to us. */
interface OmpLine {
	type?: string;
	id?: string;
	cwd?: string;
	timestamp?: string;
	title?: string;
	message?: { role?: string; content?: unknown };
}

const OMP_FILE_RE = /_(.+)\.jsonl$/;

export function createOmpAdapter(): AgentAdapter {
	const root = () => join(homedir(), ".omp", "agent", "sessions");

	function sessionFiles(): ExtSessionRef[] {
		const out: ExtSessionRef[] = [];
		try {
			for (const d of readdirSync(root())) {
				const dir = join(root(), d);
				let entries: string[];
				try { entries = readdirSync(dir); } catch { continue; } // file (future layout) or raced
				for (const f of entries) {
					const m = OMP_FILE_RE.exec(f);
					if (m) out.push({ sid: m[1], path: join(dir, f) });
				}
			}
		} catch { /* not installed / unreadable */ }
		return out;
	}

	return {
		id: "omp",
		label: "Oh My Pi (omp)",
		roots() { const r = root(); return existsSync(r) ? [r] : []; },
		probe(): ExtSourceProbe {
			const refs = sessionFiles();
			let wm = 0;
			for (const r of refs) {
				try { wm = Math.max(wm, statSync(r.path).mtimeMs); } catch { /* raced */ }
			}
			return { ok: refs.length > 0, count: refs.length, watermarkMs: wm };
		},
		listFresh() { return statFreshList(this.list()); },
		list: sessionFiles,
		...artifactPrimitives(),
		capabilities: artifactCapabilities(),
		parse(ref) {
			let raw = ""; try { raw = readFileSync(ref.path, "utf8"); } catch { return null; }
			const messages: IndexedMessage[] = [];
			let cwd = "", name: string | undefined, created: string | undefined;
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				let e: OmpLine; try { e = JSON.parse(line) as OmpLine; } catch { continue; }
				if (e.type === "session") {
					cwd = typeof e.cwd === "string" ? e.cwd : "";
					if (!created && typeof e.timestamp === "string") created = e.timestamp;
					continue;
				}
				if (e.type === "title") {
					name = typeof e.title === "string" && e.title.trim() ? e.title : name;
					continue;
				}
				if (e.type !== "message") continue;
				const role = e.message?.role === "assistant" ? "assistant" : e.message?.role === "user" ? "user" : null;
				if (!role) continue;
				const text = blocksText(e.message?.content);
				if (!text) continue;
				messages.push({ entryId: `${messages.length + 1}`, role, ts: e.timestamp ?? null, text });
			}
			if (!messages.length) return null;
			const modified = mtimeIso(ref.path);
			return {
				meta: {
					path: ref.path,
					id: ref.sid,
					cwd,
					name,
					created: created ?? modified,
					modified,
					messageCount: messages.length,
					firstMessage: messages.find((m) => m.role === "user")?.text.slice(0, 500) || "(no messages)",
					lastMessage: messages[messages.length - 1]?.text ?? "",
				},
				messages,
			};
		},
	};
}

/* ── kiro (Kiro CLI = Amazon Q CLI rebrand) ──
 * ~/.kiro/sessions/**\u200b/conversation_log.jsonl — per-session dir holds
 * conversation_log.jsonl (+ session.json / session_metadata.json in exports).
 * Log lines are Q-CLI-style JSON events; user/assistant text extracted
 * defensively (toolUse/toolResult/reasoning shapes skipped). KIRO_HOME env
 * relocates the whole .kiro dir (binary strings evidence). */
interface KiroLine {
	type?: string;
	role?: string;
	message?: { role?: string; content?: unknown };
	content?: unknown;
	text?: unknown;
	timestamp?: string;
}

function kiroSessionFiles(): ExtSessionRef[] {
	const home = process.env.KIRO_HOME || join(homedir(), ".kiro");
	const root = join(home, "sessions");
	const out: ExtSessionRef[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 5) return;
		let entries: string[];
		try { entries = readdirSync(dir); } catch { return; }
		if (entries.includes("conversation_log.jsonl")) {
			// session id = enclosing directory name (Q-CLI convention)
			out.push({ sid: dir.split("/").pop() ?? "", path: join(dir, "conversation_log.jsonl") });
			return;
		}
		for (const e of entries) {
			const p = join(dir, e);
			try { if (statSync(p).isDirectory()) walk(p, depth + 1); } catch { /* raced */ }
		}
	};
	walk(root, 0);
	return out;
}

export function createKiroAdapter(): AgentAdapter {
	return {
		id: "kiro",
		label: "Kiro CLI",
		roots() {
			const root = join(process.env.KIRO_HOME || join(homedir(), ".kiro"), "sessions");
			return existsSync(root) ? [root] : [];
		},
		probe(): ExtSourceProbe {
			const refs = kiroSessionFiles();
			let wm = 0;
			for (const r of refs) {
				try { wm = Math.max(wm, statSync(r.path).mtimeMs); } catch { /* raced */ }
			}
			return { ok: refs.length > 0, count: refs.length, watermarkMs: wm };
		},
		listFresh() { return statFreshList(this.list()); },
		list: kiroSessionFiles,
		...artifactPrimitives(),
		capabilities: artifactCapabilities(),
		parse(ref) {
			let raw = ""; try { raw = readFileSync(ref.path, "utf8"); } catch { return null; }
			const messages: IndexedMessage[] = [];
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				let e: KiroLine; try { e = JSON.parse(line) as KiroLine; } catch { continue; }
				const role = (() => {
					const r = e.message?.role ?? e.role ?? e.type ?? "";
					return r === "user" ? "user" : r === "assistant" ? "assistant" : null;
				})();
				if (!role) continue;
				const text = blocksText(e.message?.content ?? e.content ?? e.text);
				if (!text) continue;
				messages.push({ entryId: `${messages.length + 1}`, role, ts: e.timestamp ?? null, text });
			}
			if (!messages.length) return null;
			// sibling session.json / session_metadata.json → created/title best-effort
			const dir = ref.path.slice(0, ref.path.lastIndexOf("/"));
			let created: string | undefined, name: string | undefined;
			for (const meta of ["session.json", "session_metadata.json"]) {
				try {
					const doc = JSON.parse(readFileSync(join(dir, meta), "utf8")) as { createdAt?: string; created?: string; title?: string; conversation_id?: string };
					created ??= doc.createdAt ?? doc.created;
					name ??= doc.title;
				} catch { /* absent */ }
			}
			const modified = mtimeIso(ref.path);
			return {
				meta: {
					path: ref.path,
					id: ref.sid,
					cwd: "",
					name,
					created: created ?? modified,
					modified,
					messageCount: messages.length,
					firstMessage: messages.find((m) => m.role === "user")?.text.slice(0, 500) || "(no messages)",
					lastMessage: messages[messages.length - 1]?.text ?? "",
				},
				messages,
			};
		},
	};
}

/* ── auggie (Augment Code) ──
 * ~/.augment/sessions/<session-uuid>.json — single JSON document with
 * turns[].chunks[] ("renders the conversation as a sequence of turns. Each
 * turn..." — auggie bundle strings) and/or a chatHistory[] array (session
 * replay code searches for `"chatHistory": [`). Shapes parsed defensively. */
interface AuggieChunk {
	role?: string;
	type?: string;
	text?: unknown;
	content?: unknown;
	message?: { role?: string; content?: unknown };
}

interface AuggieDoc {
	sessionId?: string;
	workspaceId?: string;
	createdAt?: string;
	created?: string;
	title?: string;
	turns?: Array<{ role?: string; type?: string; chunks?: AuggieChunk[]; message?: AuggieChunk }>;
	chatHistory?: AuggieChunk[];
	messages?: AuggieChunk[];
}

function auggieRoleOf(...hints: Array<string | undefined>): "user" | "assistant" | null {
	for (const h of hints) {
		const s = (h ?? "").toLowerCase();
		if (s === "user" || s.includes("user")) return "user";
		if (s === "assistant" || s === "agent" || s.includes("assistant") || s.includes("agent")) return "assistant";
	}
	return null;
}

export function createAuggieAdapter(): AgentAdapter {
	const root = () => join(homedir(), ".augment", "sessions");

	function sessionFiles(): ExtSessionRef[] {
		const out: ExtSessionRef[] = [];
		try {
			for (const f of readdirSync(root())) {
				if (f.endsWith(".json")) out.push({ sid: f.replace(/\.json$/, ""), path: join(root(), f) });
			}
		} catch { /* not installed / unreadable */ }
		return out;
	}

	/** Flatten the three known container shapes (turns[].chunks[] / chatHistory[] / messages[]) into role-tagged entries. */
	function entriesOf(doc: AuggieDoc): Array<{ role: "user" | "assistant"; text: string; ts: string | null }> {
		const out: Array<{ role: "user" | "assistant"; text: string; ts: string | null }> = [];
		const pushChunk = (c: AuggieChunk | undefined, turnRole?: string): void => {
			if (!c || typeof c !== "object") return;
			// 非消息块（工具调用/推理/系统注入）不进会话文本面
			const ct = typeof c.type === "string" ? c.type.toLowerCase() : "";
			if (ct.includes("tool") || ct.includes("thinking") || ct.includes("reasoning") || ct === "system") return;
			const role = auggieRoleOf(c.role, c.type, turnRole, c.message?.role);
			if (!role) return;
			const text = blocksText(c.text ?? c.content ?? c.message?.content);
			if (!text) return;
			out.push({ role, text, ts: null });
		};
		for (const t of doc.turns ?? []) {
			if (!t || typeof t !== "object") continue;
			if (Array.isArray(t.chunks)) for (const c of t.chunks) pushChunk(c, t.role ?? t.type);
			else pushChunk(t.message ?? (t as AuggieChunk), t.role ?? t.type);
		}
		for (const c of doc.chatHistory ?? []) pushChunk(c);
		for (const c of doc.messages ?? []) pushChunk(c);
		return out;
	}

	return {
		id: "auggie",
		label: "Auggie (Augment)",
		roots() { const r = root(); return existsSync(r) ? [r] : []; },
		probe(): ExtSourceProbe {
			const refs = sessionFiles();
			let wm = 0;
			for (const r of refs) {
				try { wm = Math.max(wm, statSync(r.path).mtimeMs); } catch { /* raced */ }
			}
			return { ok: refs.length > 0, count: refs.length, watermarkMs: wm };
		},
		listFresh() { return statFreshList(this.list()); },
		list: sessionFiles,
		...artifactPrimitives(),
		capabilities: artifactCapabilities(),
		parse(ref) {
			let doc: AuggieDoc;
			try { doc = JSON.parse(readFileSync(ref.path, "utf8")) as AuggieDoc; } catch { return null; }
			const entries = entriesOf(doc);
			if (!entries.length) return null;
			const messages: IndexedMessage[] = entries.map((e, i) => ({ entryId: `${i + 1}`, role: e.role, ts: e.ts, text: e.text }));
			const modified = mtimeIso(ref.path);
			return {
				meta: {
					path: ref.path,
					id: doc.sessionId ?? ref.sid,
					cwd: "",
					name: doc.title,
					created: doc.createdAt ?? doc.created ?? modified,
					modified,
					messageCount: messages.length,
					firstMessage: messages.find((m) => m.role === "user")?.text.slice(0, 500) || "(no messages)",
					lastMessage: messages[messages.length - 1]?.text ?? "",
				},
				messages,
			};
		},
	};
}

/* ── vibe (Mistral Vibe) ──
 * SESSION_LOG_DIR = ~/.vibe/logs/session (vibe source, core/paths/_vibe_home.py).
 * Line/document shape unverified pre-login (vibe writes only a 12-byte
 * vibehistory placeholder until authenticated) — parse defensively as JSONL
 * events with role/content-ish fields; single-JSON documents with messages[]
 * also accepted. */
function vibeSessionFiles(): ExtSessionRef[] {
	const root = join(homedir(), ".vibe", "logs", "session");
	const out: ExtSessionRef[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 4) return;
		let entries: string[];
		try { entries = readdirSync(dir); } catch { return; }
		for (const e of entries) {
			const p = join(dir, e);
			let isDir = false;
			try { isDir = statSync(p).isDirectory(); } catch { continue; }
			if (isDir) walk(p, depth + 1);
			else if (/\.(jsonl|json)$/i.test(e)) out.push({ sid: e.replace(/\.(jsonl|json)$/i, ""), path: p });
		}
	};
	walk(root, 0);
	return out;
}

export function createVibeAdapter(): AgentAdapter {
	return {
		id: "mistral",
		label: "Mistral Vibe",
		roots() {
			const r = join(homedir(), ".vibe", "logs", "session");
			return existsSync(r) ? [r] : [];
		},
		probe(): ExtSourceProbe {
			const refs = vibeSessionFiles();
			let wm = 0;
			for (const r of refs) {
				try { wm = Math.max(wm, statSync(r.path).mtimeMs); } catch { /* raced */ }
			}
			return { ok: refs.length > 0, count: refs.length, watermarkMs: wm };
		},
		listFresh() { return statFreshList(this.list()); },
		list: vibeSessionFiles,
		...artifactPrimitives(),
		capabilities: artifactCapabilities(),
		parse(ref) {
			let raw = ""; try { raw = readFileSync(ref.path, "utf8"); } catch { return null; }
			const messages: IndexedMessage[] = [];
			const pushEntry = (e: { role?: unknown; content?: unknown; message?: { role?: unknown; content?: unknown }; text?: unknown; timestamp?: unknown }): void => {
				const roleHint = String(e.role ?? e.message?.role ?? "");
				const role = roleHint === "user" ? "user" : roleHint === "assistant" || roleHint === "agent" ? "assistant" : null;
				if (!role) return;
				const text = blocksText(e.message?.content ?? e.content ?? e.text);
				if (!text) return;
				messages.push({
					entryId: `${messages.length + 1}`,
					role,
					ts: typeof e.timestamp === "string" ? e.timestamp : null,
					text,
				});
			};
			let docSingle = false;
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				let e: Parameters<typeof pushEntry>[0];
				try { e = JSON.parse(line) as Parameters<typeof pushEntry>[0]; } catch { continue; }
				docSingle = false;
				pushEntry(e);
			}
			if (!messages.length) {
				// single JSON document (messages[] / turns[]) — reuse the auggie shape defensively
				try {
					const doc = JSON.parse(raw) as AuggieDoc;
					docSingle = true;
					for (const t of doc.turns ?? []) {
						for (const c of t.chunks ?? []) pushEntry(c);
						pushEntry((t as unknown as Parameters<typeof pushEntry>[0]));
					}
					for (const c of doc.chatHistory ?? []) pushEntry(c);
					for (const c of doc.messages ?? []) pushEntry(c);
				} catch { /* not JSON either */ }
			}
			void docSingle;
			if (!messages.length) return null;
			const modified = mtimeIso(ref.path);
			return {
				meta: {
					path: ref.path,
					id: ref.sid,
					cwd: "",
					name: undefined,
					created: modified,
					modified,
					messageCount: messages.length,
					firstMessage: messages.find((m) => m.role === "user")?.text.slice(0, 500) || "(no messages)",
					lastMessage: messages[messages.length - 1]?.text ?? "",
				},
				messages,
			};
		},
	};
}

// docSingle is reserved for future per-document metadata extraction (createdAt/title)
void 0 as unknown as boolean extends typeof docSingle ? never : never;
