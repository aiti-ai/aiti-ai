/**
 * session-manager — Cline-family adapter (Cline / Roo Code / Kilo Code).
 *
 * Storage: VSCode-style globalStorage of any host editor:
 *   <host>/User/globalStorage/<extKey>/tasks/<taskId>/
 *     api_conversation_history.json  OpenAI-style array [{role,
 *       content: string|[{type:"text",text}|{type:"tool_use",name,input}|
 *                {type:"tool_result",content}...], modelInfo:{modelId}}]
 *   ../state/taskHistory.json  [{id, task?, title?, workspace?…}] → title/cwd
 *
 * Hosts scanned (per PSM cline.rs): ~/.config|~/.local/share ×
 * {Code, Code - Insiders, VSCodium, Cursor}. Extension keys cover the family.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import { statFreshList } from "./fresh.ts";
import type { IndexedMessage } from "../session-file.ts";

const EXT_KEYS = [
  ["saoudrizwan.claude-dev", "Cline"],
  ["RooCodeInc.roo-cline", "Roo Code"],
  ["kilocode.kilo-code", "Kilo Code"],
] as const;

const HOSTS = () => {
  const home = homedir();
  return [
    join(home, ".config", "Code"),
    join(home, ".config", "Code - Insiders"),
    join(home, ".config", "VSCodium"),
    join(home, ".config", "Cursor"),
    join(home, ".local", "share", "Code"),
    join(home, ".local", "share", "Code - Insiders"),
    join(home, ".local", "share", "VSCodium"),
  ];
};

function* storageRoots(): Generator<{ root: string; extKey: string }> {
  for (const host of HOSTS()) {
    for (const [extKey] of EXT_KEYS) {
      const r = join(host, "User", "globalStorage", extKey);
      if (existsSync(r)) yield { root: r, extKey };
    }
  }
}

interface HistoryItem {
  role?: string;
  content?: unknown;
  modelInfo?: { modelId?: string };
}

interface TaskHistoryEntry {
  id?: string;
  task?: string;
  title?: string;
  workspace?: string;
  cwd?: string;
}

function blockText(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  const parts: string[] = [];
  let toolName: string | undefined;
  for (const b of v) {
    if (!b || typeof b !== "object") continue;
    const blk = b as Record<string, unknown>;
    if (blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
    else if (blk.type === "tool_use" && typeof blk.name === "string") {
      toolName ??= blk.name;
      const input = typeof blk.input === "string" ? blk.input : JSON.stringify(blk.input ?? "");
      parts.push(`🛠 ${blk.name}${input ? ` ${input.slice(0, 300)}` : ""}`);
    }
  }
  void toolName;
  return parts.join("\n");
}

export function createClineFamilyAdapter(): AgentAdapter {
  return {
    id: "cline",
    label: "Cline",
    roots() {
      return [...storageRoots()].map((r) => r.root);
    },

    probe(): ExtSourceProbe {
      let count = 0;
      let watermarkMs = 0;
      for (const { root } of storageRoots()) {
        const tasks = join(root, "tasks");
        if (!existsSync(tasks)) continue;
        try {
          for (const t of readdirSync(tasks)) {
            const api = join(tasks, t, "api_conversation_history.json");
            if (!existsSync(api)) continue;
            count++;
            watermarkMs = Math.max(watermarkMs, statSync(api).mtimeMs);
          }
        } catch { /* unreadable */ }
      }
      return { ok: count > 0, count, watermarkMs };
    },

    listFresh() { return statFreshList(this.list()); },
    list(): ExtSessionRef[] {
      const out: ExtSessionRef[] = [];
      for (const { root } of storageRoots()) {
        const tasks = join(root, "tasks");
        if (!existsSync(tasks)) continue;
        try {
          for (const tid of readdirSync(tasks)) {
            const api = join(tasks, tid, "api_conversation_history.json");
            if (existsSync(api)) out.push({ sid: tid, path: `${api}#task:${tid}` });
          }
        } catch { /* unreadable */ }
      }
      return out;
    },

    parse(ref) {
      const [realPath, marker] = ref.path.split("#");
      if (!marker?.startsWith("task:")) return null;
      let raw = "";
      try { raw = readFileSync(realPath, "utf8"); } catch { return null; }
      let items: HistoryItem[];
      try { items = JSON.parse(raw) as HistoryItem[]; } catch { return null; }
      if (!Array.isArray(items)) return null;

      // title/cwd from state/taskHistory.json (sibling of tasks/)
      const taskDir = realPath.slice(0, realPath.lastIndexOf(join("tasks") + "/") );
      const storageRoot = taskDir.slice(0, taskDir.lastIndexOf("tasks"));
      let title: string | undefined, cwd: string | undefined;
      const histPath = join(storageRoot, "state", "taskHistory.json");
      if (existsSync(histPath)) {
        try {
          const hist = JSON.parse(readFileSync(histPath, "utf8")) as TaskHistoryEntry[];
          const hit = hist.find((h) => h.id === ref.sid);
          if (hit) {
            title = hit.title || (hit.task ? String(hit.task).slice(0, 80) : undefined);
            cwd = hit.workspace || hit.cwd || undefined;
          }
        } catch { /* corrupt history */ }
      }

      let firstMessage = "", lastMessage = "";
      const messages: IndexedMessage[] = [];
      let seq = 0;
      for (const item of items) {
        const role = item.role === "assistant" ? "assistant" : "user";
        const text = blockText(item.content).trim();
        if (!text) continue;
        seq++;
        if (!firstMessage && role === "user") firstMessage = text.slice(0, 500);
        lastMessage = text;
        messages.push({
          entryId: `${seq}`, role, ts: null,
          model: role === "assistant" ? item.modelInfo?.modelId : undefined,
          text,
        });
      }

      if (!messages.length) return null;
      const mtimeIso = (() => { try { return statSync(realPath).mtime.toISOString(); } catch { return new Date().toISOString(); } })();
      return {
        meta: {
          path: ref.path,
          id: ref.sid,
          cwd: cwd ?? "",
          name: title,
          created: mtimeIso,
          modified: mtimeIso,
          messageCount: messages.length,
          firstMessage: firstMessage || "(no messages)",
          lastMessage,
        },
        messages,
      };
    },
  };
}
