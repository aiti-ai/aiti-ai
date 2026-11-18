/**
 * aiti-secret-vault · pi-web management surface for the encrypted secret vault.
 *
 * Pairs with the `@aiti-ai/pi-secret-vault` pi extension (which owns the hooks,
 * the AI tools and the session registry). This extension only manages the
 * library from the web UI: list / add / rotate / reveal / remove aliases,
 * lock/unlock, and switch the unlock mode between a keyfile and the OS
 * keychain. It never touches the AI conversation and never logs values.
 *
 * Storage (same files as the pi extension):
 *   ~/.pi/agent/secret-vault/{global.json, vault.<cwdHash8>.json, config.json, master.key?}
 *   ~/.pi/agent/secret-vault/session-state.json   (alias names only)
 *
 * API (mounted by the host under /api/extensions/aiti-secret-vault/):
 *   GET    /status                  store status + mounted session overview
 *   GET    /entries                 alias metadata (zero values)
 *   POST   /entries                 {alias, value, desc?, tags?, project?}  add/rotate
 *   DELETE /entries/:alias          remove
 *   POST   /entries/:alias/reveal   {value} — human action, no-store
 *   POST   /lock | /unlock
 *   POST   /mode                    {mode: "keyfile"|"keychain"} rekey + re-encrypt
 *   GET    /sessions                zero-value session records
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  VaultError,
  VaultStore,
  readSessionState,
  type VaultKeyMode,
} from "@aiti-ai/secret-vault-core";

const VAULT_DIR = process.env.PI_SECRET_VAULT_DIR || join(homedir(), ".pi", "agent", "secret-vault");
const SESSION_STATE_PATH = join(VAULT_DIR, "session-state.json");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export interface VaultApiDeps {
  store: VaultStore;
  sessionStatePath: string;
}

function errorResponse(e: unknown): Response {
  if (e instanceof VaultError) return json({ ok: false, code: e.code, error: e.message }, 400);
  return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
}

function parseTags(input: unknown): string[] | undefined {
  if (Array.isArray(input)) return input.map((t) => String(t).trim()).filter(Boolean);
  if (typeof input === "string") return input.split(",").map((t) => t.trim()).filter(Boolean);
  return undefined;
}

/** API dispatcher (exported for tests; the host calls it with `ctx.path`). */
export function createVaultApi(deps: VaultApiDeps) {
  return async function api(req: Request, ctx: { path?: string[] }): Promise<Response> {
    const path = Array.isArray(ctx?.path) ? ctx.path : [];
    const [head, second, third] = path;
    const store = deps.store;
    try {
      if (req.method === "GET" && head === "status" && !second) {
        const sessions = readSessionState(deps.sessionStatePath);
        return json({ ok: true, status: store.status(), sessions: sessions.sessions });
      }

      if (req.method === "GET" && head === "entries" && !second) {
        return json({ ok: true, entries: store.list() });
      }

      if (req.method === "POST" && head === "entries" && !second) {
        const body = (await req.json().catch(() => null)) as
          | { alias?: string; value?: string; desc?: string; tags?: unknown; project?: boolean }
          | null;
        const alias = String(body?.alias ?? "").trim();
        const value = String(body?.value ?? "");
        if (!alias || !value) return json({ ok: false, error: "alias and value are required" }, 400);
        const res = store.add(alias, value, {
          desc: body?.desc ? String(body.desc).trim() : undefined,
          tags: parseTags(body?.tags),
          project: body?.project === true,
        });
        return json({ ok: true, result: res });
      }

      if (req.method === "DELETE" && head === "entries" && second) {
        const removed = store.remove(String(second));
        return removed > 0 ? json({ ok: true, removed }) : json({ ok: false, error: `no entry named "${second}"` }, 404);
      }

      if (req.method === "POST" && head === "entries" && second && third === "reveal") {
        const entry = store.get(String(second));
        return json({ ok: true, alias: entry.alias, scope: entry.scope, value: entry.value });
      }

      if (req.method === "POST" && head === "lock" && !second) {
        store.lock();
        return json({ ok: true, status: store.status() });
      }

      if (req.method === "POST" && head === "unlock" && !second) {
        const res = store.unlock();
        return res.ok ? json({ ok: true, status: store.status() }) : json({ ok: false, error: res.error }, 400);
      }

      if (req.method === "POST" && head === "mode" && !second) {
        const body = (await req.json().catch(() => null)) as { mode?: string } | null;
        const mode = body?.mode;
        if (mode !== "keyfile" && mode !== "keychain") return json({ ok: false, error: 'mode must be "keyfile" or "keychain"' }, 400);
        const res = store.rekeyTo(mode as VaultKeyMode);
        return json({ ok: true, result: res, status: store.status() });
      }

      if (req.method === "GET" && head === "sessions" && !second) {
        return json({ ok: true, sessions: readSessionState(deps.sessionStatePath).sessions });
      }

      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

let store: VaultStore | null = null;
let apiHandler: ((req: Request, ctx: { path?: string[] }) => Promise<Response>) | null = null;

export default {
  id: "aiti-secret-vault",
  name: "Secret Vault",
  icon: "icons/key-round.svg",
  client: "dist/aiti-secret-vault-client.mjs",

  ui: {
    clientImmediately: false,
    toolbar: [
      {
        id: "aiti-secret-vault-open",
        label: "i18n:sv.open.label",
        title: "i18n:sv.open.title",
        icon: "icons/key-round.svg",
      },
    ],
    dialogs: [{ id: "aiti-secret-vault-panel", label: "i18n:sv.panel.label" }],
    i18n: {
      "zh-CN": {
        "sv.open.label": "密钥库",
        "sv.open.title": "加密密钥库：别名 / 轮换 / 查看 / 删除 / 解锁模式",
        "sv.panel.label": "密钥库",
        "sv.tab.vault": "密钥库",
        "sv.tab.sessions": "会话挂载",
        "sv.lock": "锁定",
        "sv.unlock": "解锁",
        "sv.refresh": "刷新",
        "sv.add": "新增 / 轮换",
        "sv.alias": "别名",
        "sv.desc": "说明",
        "sv.tags": "标签（逗号分隔）",
        "sv.value": "值（仅写入本机加密库）",
        "sv.project": "项目桶",
        "sv.reveal": "查看",
        "sv.delete": "删除",
        "sv.deleteConfirm": "确认删除",
        "sv.hide": "隐藏",
        "sv.copy": "复制",
        "sv.copied": "已复制",
        "sv.empty": "暂无条目",
        "sv.locked": "已锁定",
        "sv.unlocked": "已解锁",
        "sv.mode": "解锁模式",
        "sv.mode.keyfile": "keyfile（密钥文件）",
        "sv.mode.keychain": "keychain（系统钥匙串）",
        "sv.mode.switch": "切换",
        "sv.mode.confirm": "切换解锁模式会重新生成主密钥并重新加密整个库，继续？",
        "sv.saved": "已保存",
        "sv.removed": "已删除",
        "sv.failed": "操作失败：",
        "sv.session.mounted": "挂载别名",
        "sv.session.landing": "落盘策略",
        "sv.session.empty": "暂无会话记录",
        "sv.updated": "更新于",
        "sv.entries": "条目",
        "sv.keychain": "钥匙串后端",
        "sv.hint": "值只存本机加密库（AES-256-GCM）；AI 只能拿到占位令牌，看不到明文。",
      },
      en: {
        "sv.open.label": "Secret Vault",
        "sv.open.title": "Encrypted secret vault: aliases / rotate / reveal / remove / unlock mode",
        "sv.panel.label": "Secret Vault",
        "sv.tab.vault": "Vault",
        "sv.tab.sessions": "Sessions",
        "sv.lock": "Lock",
        "sv.unlock": "Unlock",
        "sv.refresh": "Refresh",
        "sv.add": "Add / rotate",
        "sv.alias": "Alias",
        "sv.desc": "Description",
        "sv.tags": "Tags (comma separated)",
        "sv.value": "Value (written to the local encrypted vault only)",
        "sv.project": "Project bucket",
        "sv.reveal": "Reveal",
        "sv.delete": "Delete",
        "sv.deleteConfirm": "Confirm delete",
        "sv.hide": "Hide",
        "sv.copy": "Copy",
        "sv.copied": "Copied",
        "sv.empty": "No entries",
        "sv.locked": "locked",
        "sv.unlocked": "unlocked",
        "sv.mode": "Unlock mode",
        "sv.mode.keyfile": "keyfile",
        "sv.mode.keychain": "keychain (OS credential store)",
        "sv.mode.switch": "Switch",
        "sv.mode.confirm": "Switching the unlock mode regenerates the master key and re-encrypts the whole vault. Continue?",
        "sv.saved": "Saved",
        "sv.removed": "Removed",
        "sv.failed": "Failed: ",
        "sv.session.mounted": "Mounted aliases",
        "sv.session.landing": "Landing",
        "sv.session.empty": "No session records yet",
        "sv.updated": "updated",
        "sv.entries": "entries",
        "sv.keychain": "keychain backend",
        "sv.hint": "Values are stored only in the local encrypted vault (AES-256-GCM). The AI sees placeholders, never plaintext.",
      },
    },
  },

  server: {
    startup(_ctx: { configDir?: string }) {
      store = new VaultStore({ dir: VAULT_DIR, cwd: process.cwd() });
      apiHandler = createVaultApi({ store, sessionStatePath: SESSION_STATE_PATH });
      console.log(`[aiti-secret-vault] ready · vault=${VAULT_DIR} · mode=${store.mode}`);
    },
    async api(req: Request, ctx: { path?: string[] }) {
      if (!apiHandler) {
        store = new VaultStore({ dir: VAULT_DIR, cwd: process.cwd() });
        apiHandler = createVaultApi({ store, sessionStatePath: SESSION_STATE_PATH });
      }
      return apiHandler(req, ctx);
    },
  },
};
