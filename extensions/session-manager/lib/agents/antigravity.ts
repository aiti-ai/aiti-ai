/**
 * session-manager — Google Antigravity adapter.
 *
 * Verified against a real install (2026-08-24): conversations persist under
 *   ~/.gemini/antigravity/brain/<convId>/.system_generated/logs/transcript.jsonl
 * with lines {step_index, source, type:"USER_INPUT"|"PLANNER_RESPONSE"|"CHECKPOINT",
 * status, created_at, content}. USER_INPUT content is wrapped in
 * <USER_REQUEST>…</USER_REQUEST> plus metadata blocks — only the request body is
 * shown. CHECKPOINT/system steps are skipped.
 * Older builds also write ~/.gemini/tmp/<slug>/chats/*.jsonl (cc-connect reads
 * those); both layouts are scanned.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import { artifactPrimitives, artifactCapabilities } from "./archive-artifact.ts";
import { statFreshList } from "./fresh.ts";
import type { IndexedMessage } from "../session-file.ts";

const BRAIN = () => join(homedir(), ".gemini", "antigravity", "brain");

interface TranscriptLine {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
}

function cleanUserInput(content: string): string {
  const m = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content);
  return (m ? m[1] : content).trim();
}

function* brainTranscripts(): Generator<{ sid: string; path: string }> {
  const root = BRAIN();
  if (!existsSync(root)) return;
  let convs: string[] = [];
  try { convs = readdirSync(root); } catch { return; }
  for (const conv of convs) {
    const f = join(root, conv, ".system_generated", "logs", "transcript.jsonl");
    if (existsSync(f)) yield { sid: conv, path: f };
  }
}

/** legacy/alternate layout: ~/.gemini/tmp/<slug>/chats/*.jsonl */
function* tmpChats(): Generator<{ sid: string; path: string }> {
  const root = join(homedir(), ".gemini", "tmp");
  if (!existsSync(root)) return;
  let slugs: string[] = [];
  try { slugs = readdirSync(root); } catch { return; }
  for (const slug of slugs) {
    const dir = join(root, slug, "chats");
    if (!existsSync(dir)) continue;
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      // gemini-cli's own sessions are session-*.json; antigravity writes .jsonl
      if (f.endsWith(".jsonl")) yield { sid: `${slug}-${f.replace(/\.jsonl$/, "")}`, path: join(dir, f) };
    }
  }
}

/* ── Antigravity CLI (agy acp) store — added 2026-11-11 ──
 * ~/.gemini/antigravity-cli/conversation_summaries.db (index: title/preview/
 * step_count/workspace_uris/last_modified_time) + per-session
 * conversations/<conversation_id>.db whose `steps.step_payload` is protobuf
 * WITHOUT a public schema — message text recovered by a generic wire walk
 * (length-delimited leaf strings reading as natural language; UUID/hex/
 * path/base64 noise filtered). step_type 14 = user turn, 15 = assistant turn
 * (verified against a logged-in PONG roundtrip). Meta face from the summaries
 * DB is authoritative. Refinement possible once a proto schema surfaces. */
const CLI_DIR = () => join(homedir(), ".gemini", "antigravity-cli");
const CLI_SUMMARIES = () => join(CLI_DIR(), "conversation_summaries.db");

interface AgSummaryRow {
	conversation_id?: string;
	title?: string | null;
	preview?: string | null;
	step_count?: number | null;
	last_modified_time?: string | null;
	workspace_uris?: string | null;
	status?: string | null;
}

/** ISO-with-nanoseconds ("2026-11-10 16:44:17.6358045+00:00") → epoch ms. */
function agyTimeMs(v: string | null | undefined): number | null {
	if (!v) return null;
	const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{1,6})/.exec(v.trim());
	if (!m) { const d = Date.parse(v.trim()); return Number.isNaN(d) ? null : d; }
	return Date.parse(m[1].replace(" ", "T") + "+00:00");
}

function agyWorkspaceCwd(urisJson: string | null | undefined): string {
	try {
		const arr = JSON.parse(urisJson ?? "[]") as string[];
		const first = arr.find((u) => typeof u === "string" && u.startsWith("file://"));
		return first ? first.slice("file://".length) : "";
	} catch { return ""; }
}

/** Generic protobuf wire walk — collect natural-language leaf strings. */
function agyWalkStrings(b: Uint8Array, out: string[], seen: Set<string>): void {
	const readVarint = (buf: Uint8Array, i: number): [number, number] => {
		let v = 0, shift = 0;
		while (i < buf.length) {
			const c = buf[i]!; i += 1;
			v += (c & 0x7f) * Math.pow(2, shift);
			if (!(c & 0x80)) return [v, i];
			shift += 7;
		}
		return [v, i];
	};
	// 噪声判定：UUID 十六进制串（含包裹符）/ 无空格大小写数字混杂（base64 指纹）/ 工具与路径标记 / snake_case 常量
	const isJunk = (s: string): boolean => {
		const hexish = s.replace(/[^0-9a-fA-F]/g, "");
		if (hexish.length >= 24 && hexish.length / s.length > 0.7) return true;
		if (!s.includes(" ") && /[0-9]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s) && s.length >= 12) return true;
		if (/^(bot-|sessionID|com\.|file:\/\/|skills)/.test(s)) return true;
		if (/antigravity-cli|\(bot-/.test(s)) return true;
		if (/read_file\(|write_file\(|-customizations/.test(s)) return true;
		if (/^\/?home\//.test(s) || s.startsWith("/")) return true;
		if (/^['"$]/.test(s)) return true;
		if (/^\w+(_\w+)+$/.test(s)) return true;
		return false;
	};
	const walk = (buf: Uint8Array, i: number, end: number, depth: number): void => {
		while (i < end) {
			const [tag, ni] = readVarint(buf, i);
			if (ni >= end) return;
			const wt = tag & 7;
			i = ni;
			if (wt === 0) { [, i] = readVarint(buf, i); continue; }
			if (wt === 1) { i += 8; continue; }
			if (wt === 5) { i += 4; continue; }
			if (wt !== 2) return;
			const [ln, di] = readVarint(buf, i);
			if (di + ln > end) return;
			const chunk = buf.subarray(di, di + ln);
			i = di + ln;
			if (depth < 14) {
				try { walk(chunk, 0, chunk.length, depth + 1); } catch { /* malformed — leaf fallback below */ }
			}
			let s0 = Buffer.from(chunk).toString("utf8").trim();
			if (/^[!'"$]/.test(s0)) s0 = s0.slice(1); // 长度前缀字节残留
			const str = s0.trim();
			if (str.length >= 4 && !seen.has(str) && !isJunk(str) &&
				/[a-zA-Z]/.test(str) && /^[\x20-\x7e]+$/.test(str)) {
				const norm = str.toLowerCase().replace(/[^a-z0-9]/g, "");
				if (norm.length >= 4 && !seen.has(norm)) {
					seen.add(norm);
					out.push(str);
				}
			}
		}
	};
	walk(b, 0, b.length, 0);
}

interface AgStepRow { step_type?: number; step_payload?: unknown }

function agyCliSessions(): AgSummaryRow[] {
	let db: DatabaseSync | null;
	try { db = new DatabaseSync(CLI_SUMMARIES(), { readOnly: true }); } catch { return []; }
	try {
		return db.prepare(
			"SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status FROM conversation_summaries ORDER BY last_modified_time DESC",
		).all() as AgSummaryRow[];
	} catch { return []; }
	finally { db.close(); }
}

/** CLI face parse — per-session DB wire walk. path convention: "<summaries.db>#<sid>". */
function agyCliParse(ref: ExtSessionRef): import("../session-file.ts").ParsedSessionFile | null {
	const [dbPath, sid] = ref.path.split("#");
	if (!sid) return null;
	let metaRow: AgSummaryRow | undefined;
	{
		let db: DatabaseSync | null;
		try { db = new DatabaseSync(CLI_SUMMARIES(), { readOnly: true }); } catch { return null; }
		try {
			metaRow = db.prepare("SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris FROM conversation_summaries WHERE conversation_id = ?").get(sid) as AgSummaryRow | undefined;
		} finally { db.close(); }
	}
	let cdb: DatabaseSync | null;
	try { cdb = new DatabaseSync(join(CLI_DIR(), "conversations", `${sid}.db`), { readOnly: true }); } catch { return null; }
	const messages: IndexedMessage[] = [];
	try {
		const steps = cdb.prepare("SELECT step_type, step_payload FROM steps ORDER BY idx").all() as AgStepRow[];
		const seen = new Set<string>();
		let pendingRole: "user" | "assistant" | null = null;
		for (const st of steps) {
			const role = st.step_type === 14 ? "user" : st.step_type === 15 ? "assistant" : null;
			if (!role || !(st.step_payload instanceof Uint8Array) || !st.step_payload.length) continue;
			const out: string[] = [];
			agyWalkStrings(st.step_payload, out, seen);
			// 消息文本选取：user 取最长候选（prompt 通常最长）；assistant 优先带空格自然句，退最长
			const text = (role === "user"
				? out.slice().sort((a, b) => b.length - a.length)[0]
				: out.find((t) => t.includes(" ")) ?? out.slice().sort((a, b) => b.length - a.length)[0]) ?? "";
			const textClean = text.trim();
			if (!textClean) continue;
			if (messages.length && messages[messages.length - 1].role === role && pendingRole === role) {
				messages[messages.length - 1].text += (messages[messages.length - 1].text ? "\n" : "") + textClean;
			} else {
				messages.push({ entryId: `${messages.length + 1}`, role, ts: null, text: textClean });
			}
			pendingRole = role;
		}
	} finally { cdb.close(); }
	if (!messages.length) return null;
	const modifiedMs = agyTimeMs(metaRow?.last_modified_time);
	const modified = modifiedMs ? new Date(modifiedMs).toISOString() : mtimeIso(dbPath);
	const createdIso = modifiedMs ? new Date(modifiedMs).toISOString() : modified;
	return {
		meta: {
			path: ref.path,
			id: sid,
			cwd: agyWorkspaceCwd(metaRow?.workspace_uris),
			name: (metaRow?.title || metaRow?.preview) ?? undefined,
			created: createdIso,
			modified,
			messageCount: messages.length,
			firstMessage: messages.find((m) => m.role === "user")?.text.slice(0, 500) || "(no messages)",
			lastMessage: messages[messages.length - 1]?.text ?? "",
		},
		messages,
	};
}

function mtimeIso(path: string): string {
	try { return statSync(path).mtime.toISOString(); } catch { return new Date().toISOString(); }
}

export function createAntigravityAdapter(): AgentAdapter {
  return {
    id: "antigravity",
    label: "Antigravity",
    roots() {
      const root = join(homedir(), ".gemini");
      return existsSync(root) ? [root] : [];
    },

    probe(): ExtSourceProbe {
      let count = 0;
      let watermarkMs = 0;
      for (const { path } of [...brainTranscripts(), ...tmpChats()]) {
        count++;
        try { watermarkMs = Math.max(watermarkMs, statSync(path).mtimeMs); } catch { /* raced */ }
      }
      for (const r of agyCliSessions()) {
        if (!(r.step_count ?? 0)) continue;
        count++;
        watermarkMs = Math.max(watermarkMs, agyTimeMs(r.last_modified_time) ?? 0);
      }
      return { ok: existsSync(BRAIN()) || count > 0, count, watermarkMs };
    },

    listFresh() { return statFreshList(this.list()); },
    list(): ExtSessionRef[] {
      const cliRefs: ExtSessionRef[] = [];
      for (const r of agyCliSessions()) {
        if (!(r.step_count ?? 0)) continue;
        if (typeof r.conversation_id !== "string" || !r.conversation_id) continue;
        const rev = agyTimeMs(r.last_modified_time) ?? undefined;
        cliRefs.push({ sid: r.conversation_id, path: `${CLI_SUMMARIES()}#${r.conversation_id}`, ...(rev ? { rev } : {}) });
      }
      return [
        ...[...brainTranscripts()].map(({ sid, path }) => ({ sid, path })),
        ...[...tmpChats()],
        ...cliRefs,
      ];
    },

    parse(ref) {
      // CLI face（agy acp 会话）：path 带 "#<sid>" 标记 → 走 per-session DB wire walk
      if (ref.path.includes("#")) return agyCliParse(ref);
      let raw = "";
      try { raw = readFileSync(ref.path, "utf8"); } catch { return null; }

      let firstMessage = "", lastMessage = "";
      let createdIso = "", modifiedIso = "";
      const messages: IndexedMessage[] = [];
      let seq = 0;

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let e: TranscriptLine;
        try { e = JSON.parse(line) as TranscriptLine; } catch { continue; }
        if (e.type === "USER_INPUT") {
          const text = cleanUserInput(e.content ?? "");
          if (!text) continue;
          seq++;
          if (!firstMessage) firstMessage = text.slice(0, 500);
          lastMessage = text;
          messages.push({ entryId: `${seq}`, role: "user", ts: e.created_at ?? null, text });
          if (!createdIso && e.created_at) createdIso = e.created_at;
          if (e.created_at) modifiedIso = e.created_at;
        } else if (e.type === "PLANNER_RESPONSE") {
          const text = (e.content ?? "").trim();
          if (!text) continue;
          seq++;
          lastMessage = text;
          messages.push({ entryId: `${seq}`, role: "assistant", ts: e.created_at ?? null, text });
          if (e.created_at) modifiedIso = e.created_at;
        }
        // CHECKPOINT / system / tool steps skipped
      }

      if (!messages.length) return null;
      const mtimeIso = (() => { try { return statSync(ref.path).mtime.toISOString(); } catch { return new Date().toISOString(); } })();
      return {
        meta: {
          path: ref.path,
          id: ref.sid,
          cwd: "",
          created: createdIso || mtimeIso,
          modified: modifiedIso || mtimeIso,
          messageCount: messages.length,
          firstMessage: firstMessage || "(no messages)",
          lastMessage,
        },
        messages,
      };
    },
    ...artifactPrimitives(),
    capabilities: artifactCapabilities(),
  };
}
