/**
 * session-manager — Cursor Agent CLI (cursor-agent / `cursor agent`) adapter.
 *
 * 存储布局与解析逻辑在共享模块 cursor-cli-store.ts（权威源
 * pi-web-ext/_shared/cursor-cli-store.ts，本文件旁持部署副本）——
 * aiti-cursor-agent（resume 历史播种）与本项目共用同一份读取器。
 *
 * adapter id "cursor"：对齐 aiti-cursor-agent 后端 agentKey，All Sessions
 * ⚡打开(接管) 直通 --resume。IDE 适配器（vscdb）见 cursor.ts（cursor-ide）。
 */
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import { statFreshList } from "./fresh.ts";
import type { IndexedMessage } from "../session-file.ts";
import { cursorCliChatsRoot, listCursorCliChats, readCursorCliChat } from "@aiti-ai/ext-shared/cursor-cli-store";
import { artifactPrimitives, artifactCapabilities } from "./archive-artifact.ts";

export function createCursorCliAdapter(): AgentAdapter {
  return {
    id: "cursor",
    label: "Cursor CLI",
    roots() {
      const r = cursorCliChatsRoot();
      return existsSync(r) ? [r] : [];
    },

    probe(): ExtSourceProbe {
      let count = 0;
      let watermarkMs = 0;
      for (const { db, summary } of listCursorCliChats()) {
        count += 1;
        for (const f of [db, summary]) {
          try { watermarkMs = Math.max(watermarkMs, statSync(f).mtimeMs); } catch { /* absent */ }
        }
      }
      return { ok: count > 0 || existsSync(cursorCliChatsRoot()), count, watermarkMs };
    },

    listFresh() { return statFreshList(this.list()); },
    list(): ExtSessionRef[] {
      return listCursorCliChats().map(({ sid, db, dir }) => ({ sid, path: existsSync(db) ? db : dir }));
    },

    parse(ref) {
      const dir = existsSync(ref.path) && statSync(ref.path).isDirectory() ? ref.path : dirname(ref.path);
      const s = readCursorCliChat(ref.sid, dir);
      if (!s) return null;
      const messages: IndexedMessage[] = s.messages.map((m, i) => ({ entryId: `${i + 1}`, role: m.role, ts: m.ts, text: m.text }));
      const firstUser = messages.find((m) => m.role === "user");
      return {
        meta: {
          path: ref.path,
          id: ref.sid,
          cwd: s.cwd,
          name: s.name,
          created: s.createdMs ? new Date(s.createdMs).toISOString() : new Date(s.updatedMs).toISOString(),
          modified: new Date(s.updatedMs).toISOString(),
          messageCount: messages.length,
          firstMessage: (firstUser ?? messages[0]).text.slice(0, 500),
          lastMessage: messages[messages.length - 1].text,
          // 会话真实模型（store.meta.lastUsedModel）：接管恢复/详情展示消费
          ...(s.model ? { model: s.model } : {}),
        },
        messages,
      };
    },
    // ── A03 P2：artifact 粒度真归档——每会话独立目录（store.db 引用图 + summary 全部
    //  contained 在会话目录内，无跨会话共享），整目录打包/删除/原样还原。──
    ...artifactPrimitives((ref) => {
      try {
        return statSync(ref.path).isDirectory() ? ref.path : dirname(ref.path);
      } catch { return null; }
    }),
    capabilities: artifactCapabilities(),
  };
}
