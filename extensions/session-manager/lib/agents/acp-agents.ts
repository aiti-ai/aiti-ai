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
 * hermes covered above (state.db). junie store OBSERVED 2026-11-10 but turn
 * format pending first real conversation: ~/.junie/sessions/session-<id>/
 * transcript.md (markdown, "# Session transcript" header; events.jsonl lands
 * next to it on real turns — junie-cli-docs.md bundled in the release jar).
 * junie (JetBrains) store OBSERVED 2026-11-11: ~/.junie/sessions/index.jsonl
 * ({sessionId, createdAt/updatedAt epoch-ms, projectDir}) + per-session dir
 * (transcript.md markdown turns "## User"/"## Error"; events.jsonl with
 * UserPromptEvent etc). Adapter v1 parses transcript.md defensively — the
 * assistant turn header is unconfirmed (no successful logged-in turn yet).
 * agy (Antigravity CLI) sessions are covered by agents/antigravity.ts (merged
 * CLI face, 2026-11-11 — summaries index + per-session DB wire walk).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, dirname as pathDirname } from "node:path";
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
			// split on both separators: Windows join() paths have no "/" — split("/").pop()
			// would return the whole path as the sid
			out.push({ sid: dir.split(/[\\/]/).pop() ?? "", path: join(dir, "conversation_log.jsonl") });
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
			// dirname: lastIndexOf("/") misses on Windows backslash paths (session.json unreadable → title lost)
			const dir = pathDirname(ref.path);
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

/* ── grok (xAI Grok Build CLI) ──
 * ~/.grok/sessions/<url-encoded-cwd>/<uuid>/ — per-session dir (VERIFIED 2026-11-09,
 * logged-in real sessions):
 *   summary.json    {info:{id,cwd}, created_at, updated_at, num_messages, current_model_id}
 *   updates.jsonl   verbatim ACP session/update frames (user_message_chunk /
 *                   agent_thought_chunk / agent_message_chunk / tool_call …) — text source
 *   chat_history.jsonl  normalized history (system + <user_info>-wrapped user rows) —
 *                   fallback when updates.jsonl is absent (skip type:"system")
 * Grok adapter id "grok" aligns with the aiti-acp-agent backend agentKey (open-live
 * takeover routes to the ACP driver's session/load). */
interface GrokSummary {
	info?: { id?: string; cwd?: string };
	session_summary?: string;
	created_at?: string;
	updated_at?: string;
	current_model_id?: string;
	num_messages?: number;
}

interface GrokHistoryLine { type?: string; content?: unknown }

export function createGrokAdapter(): AgentAdapter {
	const root = () => join(homedir(), ".grok", "sessions");

	function sessionDirs(): Array<{ sid: string; dir: string }> {
		const out: Array<{ sid: string; dir: string }> = [];
		try {
			for (const enc of readdirSync(root())) {
				const encDir = join(root(), enc);
				let ids: string[];
				try { ids = readdirSync(encDir); } catch { continue; }
				for (const id of ids) {
					const dir = join(encDir, id);
					try {
						if (statSync(join(dir, "summary.json")).isFile()) out.push({ sid: id, dir });
					} catch { /* no summary.json — not a session dir */ }
				}
			}
		} catch { /* not installed / unreadable */ }
		return out;
	}

	/** Text messages from updates.jsonl (clean ACP frames); consecutive same-role chunks merge. */
	function messagesFromUpdates(path: string): IndexedMessage[] {
		let raw = ""; try { raw = readFileSync(path, "utf8"); } catch { return []; }
		const messages: IndexedMessage[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let e: { params?: { update?: { sessionUpdate?: string; contentBlock?: { text?: unknown }; content?: { text?: unknown } } } };
			try { e = JSON.parse(line) as typeof e; } catch { continue; }
			const kind = e.params?.update?.sessionUpdate ?? "";
			const role = kind === "user_message_chunk" ? "user" : kind === "agent_message_chunk" ? "assistant" : null;
			if (!role) continue; // thought_chunk / tool_call / tool_call_update 不进文本面
			// ACP content 可以是单 block 对象（{type:"text",text}）或 string/数组 —— textOf 只吃后两种
			const block = e.params?.update?.contentBlock ?? e.params?.update?.content;
			const text = (block && typeof block === "object" && !Array.isArray(block)
				? typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""
				: textOf(block)).trim();
			if (!text) continue;
			// system-reminder 注入帧（grok CLI 把上下文注入当 user chunk 写盘）不进会话文本面（kimi 同款先例）
			if (role === "user" && text.includes("<system-reminder>")) continue;
			const last = messages[messages.length - 1];
			if (last && last.role === role) last.text += (last.text ? "\n" : "") + text;
			else messages.push({ entryId: `${messages.length + 1}`, role, ts: null, text });
		}
		return messages;
	}

	/** Fallback: chat_history.jsonl minus system rows. */
	function messagesFromHistory(path: string): IndexedMessage[] {
		let raw = ""; try { raw = readFileSync(path, "utf8"); } catch { return []; }
		const messages: IndexedMessage[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let e: GrokHistoryLine; try { e = JSON.parse(line) as GrokHistoryLine; } catch { continue; }
			if (e.type === "system") continue;
			const role = e.type === "user" ? "user" : e.type === "assistant" ? "assistant" : null;
			if (!role) continue;
			const text = blocksText(e.content);
			if (!text) continue;
			messages.push({ entryId: `${messages.length + 1}`, role, ts: null, text });
		}
		return messages;
	}

	return {
		id: "grok",
		label: "Grok (xAI)",
		roots() { const r = root(); return existsSync(r) ? [r] : []; },
		probe(): ExtSourceProbe {
			const refs = sessionDirs();
			let wm = 0;
			for (const r of refs) {
				try { wm = Math.max(wm, statSync(join(r.dir, "summary.json")).mtimeMs); } catch { /* raced */ }
			}
			return { ok: refs.length > 0, count: refs.length, watermarkMs: wm };
		},
		listFresh() { return statFreshList(this.list()); },
		list(): ExtSessionRef[] {
			return sessionDirs().map(({ sid, dir }) => {
				const ref: ExtSessionRef = { sid, path: join(dir, "summary.json") };
				try { ref.rev = statSync(join(dir, "summary.json")).mtimeMs; } catch { /* raced */ }
				return ref;
			});
		},
		...artifactPrimitives(),
		capabilities: artifactCapabilities(),
		parse(ref) {
			const dir = pathDirname(ref.path);
			let doc: GrokSummary;
			try { doc = JSON.parse(readFileSync(ref.path, "utf8")) as GrokSummary; } catch { return null; }
			let messages = messagesFromUpdates(join(dir, "updates.jsonl"));
			if (!messages.length) messages = messagesFromHistory(join(dir, "chat_history.jsonl"));
			if (!messages.length) return null;
			const created = doc.created_at;
			const modified = doc.updated_at ?? (() => { try { return statSync(join(dir, "summary.json")).mtime.toISOString(); } catch { return new Date().toISOString(); } })();
			return {
				meta: {
					path: ref.path,
					id: doc.info?.id ?? ref.sid,
					cwd: typeof doc.info?.cwd === "string" ? doc.info.cwd : "",
					name: doc.session_summary || undefined,
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

/* ── hermes (Nous Research) ──
 * ~/.hermes/state.db (SQLite) — VERIFIED 2026-11-09 against real sessions
 * created through the ACP driver (PONG roundtrip):
 *   sessions: id "local-<hash>", source 'acp'|'local', cwd, title, model,
 *             started_at / last_activity_at (epoch-seconds float), message_count
 *   messages: session_id, role ('user'|'assistant'|'system'|tool rows), content
 *             (plain text; tool calls live in tool_calls JSON — not part of the
 *             text face), timestamp (epoch seconds), active/compacted flags.
 * Read-only node:sqlite open (opencode adapter precedent); ref.path is
 * "<db>#<sid>" following the same db-source convention. */
interface HermesSessionRow {
	id?: string;
	cwd?: string | null;
	title?: string | null;
	display_name?: string | null;
	model?: string | null;
	started_at?: number | null;
	last_activity_at?: number | null;
	message_count?: number | null;
}

interface HermesMessageRow { role?: string; content?: unknown; timestamp?: number | null }

export function createHermesAdapter(): AgentAdapter {
	const dbPath = () => join(homedir(), ".hermes", "state.db");

	function openDb(): DatabaseSync | null {
		try { return new DatabaseSync(dbPath(), { readOnly: true }); } catch { return null; }
	}

	function epochMs(v: number | null | undefined): number | null {
		return typeof v === "number" && v > 0 ? Math.round(v * 1000) : null;
	}

	function sessionRows(db: DatabaseSync): HermesSessionRow[] {
		return db.prepare(
			"SELECT id, cwd, title, display_name, model, started_at, last_activity_at, message_count FROM sessions ORDER BY COALESCE(last_activity_at, started_at) DESC",
		).all() as HermesSessionRow[];
	}

	return {
		id: "hermes",
		label: "Hermes",
		roots() { const d = dbPath(); return existsSync(d) ? [d] : []; },
		probe(): ExtSourceProbe {
			const db = openDb();
			if (!db) return { ok: false, count: 0, watermarkMs: 0 };
			try {
				const rows = sessionRows(db);
				let wm = 0;
				for (const r of rows) wm = Math.max(wm, epochMs(r.last_activity_at) ?? epochMs(r.started_at) ?? 0);
				return { ok: rows.length > 0, count: rows.length, watermarkMs: wm };
			} finally { db.close(); }
		},
		listFresh() { return statFreshList(this.list()); },
		list(): ExtSessionRef[] {
			const db = openDb();
			if (!db) return [];
			try {
				const out: ExtSessionRef[] = [];
				for (const r of sessionRows(db)) {
					if (typeof r.id !== "string" || !r.id) continue;
					const rev = epochMs(r.last_activity_at) ?? epochMs(r.started_at) ?? undefined;
					out.push({ sid: r.id, path: `${dbPath()}#${r.id}`, ...(rev ? { rev } : {}) });
				}
				return out;
			} finally { db.close(); }
		},
		...artifactPrimitives(),
		capabilities: artifactCapabilities(),
		parse(ref) {
			const [dbPathPart, sid] = ref.path.split("#");
			if (!sid) return null;
			const db = openDb();
			if (!db) return null;
			try {
				const sess = db.prepare(
					"SELECT id, cwd, title, display_name, model, started_at, last_activity_at FROM sessions WHERE id = ?",
				).get(sid) as HermesSessionRow | undefined;
				if (!sess) return null;
				const msgRows = db.prepare(
					"SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY rowid",
				).all(sid) as HermesMessageRow[];
				const messages: IndexedMessage[] = [];
				for (const m of msgRows) {
					// 文本面只收 user/assistant（system/tool 行带 tool_calls JSON，不是会话文本）
					const role = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : null;
					if (!role) continue;
					const text = typeof m.content === "string" ? m.content.trim() : "";
					if (!text) continue;
					const tsMs = epochMs(m.timestamp);
					messages.push({
						entryId: `${messages.length + 1}`,
						role,
						ts: tsMs ? new Date(tsMs).toISOString() : null,
						text,
					});
				}
				if (!messages.length) return null;
				const createdMs = epochMs(sess.started_at);
				const modifiedMs = epochMs(sess.last_activity_at) ?? createdMs;
				const modifiedIso = modifiedMs ? new Date(modifiedMs).toISOString() : mtimeIso(dbPathPart);
				return {
					meta: {
						path: ref.path,
						id: sess.id ?? sid,
						cwd: typeof sess.cwd === "string" ? sess.cwd : "",
						name: (sess.title || sess.display_name) ?? undefined,
						created: createdMs ? new Date(createdMs).toISOString() : modifiedIso,
						modified: modifiedIso,
						messageCount: messages.length,
						firstMessage: messages.find((m) => m.role === "user")?.text.slice(0, 500) || "(no messages)",
						lastMessage: messages[messages.length - 1]?.text ?? "",
					},
					messages,
				};
			} finally { db.close(); }
		},
	};
}

/* ── junie (JetBrains Junie CLI) ──
 * ~/.junie/sessions/index.jsonl (one {sessionId, createdAt, updatedAt,
 * projectDir} per session, epoch-ms times) + per-session dirs:
 * transcript.md (markdown: "# Session transcript" + "## User"/"## Error"…
 * turns) and events.jsonl (UserPromptEvent{prompt,timestampMs}, TaskStarted…).
 * Verified 2026-11-11 against real (errored) sessions; the assistant turn
 * header is unconfirmed — parsed defensively: "## User" → user, "## Error" →
 * skipped, any other "## <name>" section → assistant best-effort. */
interface JunieIndexRow {
	sessionId?: string;
	createdAt?: number;
	updatedAt?: number;
	projectDir?: string;
}

export function createJunieAdapter(): AgentAdapter {
	const indexFile = () => join(homedir(), ".junie", "sessions", "index.jsonl");

	function indexRows(): JunieIndexRow[] {
		let raw = ""; try { raw = readFileSync(indexFile(), "utf8"); } catch { return []; }
		const out: JunieIndexRow[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try { out.push(JSON.parse(line) as JunieIndexRow); } catch { continue; }
		}
		return out;
	}

	return {
		id: "junie",
		label: "Junie (JetBrains)",
		roots() { const d = join(homedir(), ".junie", "sessions"); return existsSync(d) ? [d] : []; },
		probe(): ExtSourceProbe {
			const rows = indexRows().filter((r) => typeof r.sessionId === "string" && r.sessionId);
			let wm = 0;
			for (const r of rows) wm = Math.max(wm, r.updatedAt ?? r.createdAt ?? 0);
			return { ok: rows.length > 0, count: rows.length, watermarkMs: wm };
		},
		listFresh() { return statFreshList(this.list()); },
		list(): ExtSessionRef[] {
			return indexRows()
				.filter((r) => typeof r.sessionId === "string" && r.sessionId)
				.map((r) => {
					const dir = join(homedir(), ".junie", "sessions", r.sessionId!);
					const rev = r.updatedAt ?? r.createdAt ?? undefined;
					return { sid: r.sessionId!, path: join(dir, "transcript.md"), ...(rev ? { rev } : {}) };
				});
		},
		...artifactPrimitives(),
		capabilities: artifactCapabilities(),
		parse(ref) {
			if (!ref.sid || !ref.sid.startsWith("session-")) return null; // index 只产 session-* 行
			let raw = ""; try { raw = readFileSync(ref.path, "utf8"); } catch { return null; }
			// markdown 轮次切分：^## <name> 分节
			const sections: Array<{ name: string; body: string }> = [];
			for (const block of raw.split(/^## /m)) {
				if (!block.trim() || block.startsWith("# Session transcript")) continue;
				const nl = block.indexOf("\n");
				const name = (nl === -1 ? block : block.slice(0, nl)).trim();
				const body = (nl === -1 ? "" : block.slice(nl + 1)).trim();
				if (name) sections.push({ name, body });
			}
			const messages: IndexedMessage[] = [];
			for (const sec of sections) {
				const lower = sec.name.toLowerCase();
				// Error 节（认证/中断提示）不进会话文本面
				if (lower === "error" || lower.includes("error")) continue;
				const role = lower === "user" ? "user" : "assistant";
				if (!sec.body) continue;
				messages.push({
					entryId: `${messages.length + 1}`,
					role,
					ts: null,
					text: sec.body,
				});
			}
			if (!messages.length) return null;
			// meta：index 行（cwd/时间）
			const idxRow = indexRows().find((r) => r.sessionId === ref.sid);
			const modifiedMs = idxRow?.updatedAt ?? idxRow?.createdAt ?? null;
			const modified = modifiedMs ? new Date(modifiedMs).toISOString() : mtimeIso(ref.path);
			return {
				meta: {
					path: ref.path,
					id: ref.sid,
					cwd: typeof idxRow?.projectDir === "string" ? idxRow.projectDir : "",
					name: messages.find((m) => m.role === "user")?.text.slice(0, 80) || undefined,
					created: idxRow?.createdAt ? new Date(idxRow.createdAt).toISOString() : modified,
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
