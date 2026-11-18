/**
 * aiti-msg-share · share sessions, messages, files and images via pluggable targets.
 *
 * See docs/aiti-msg-share-plan.md for the full design. Core provider engine lives
 * in @aiti-ai/content-share (URL is its terminal output); this extension owns UI,
 * hydration, redaction injection, history and all pi-web host wiring.
 */
import { join, dirname } from "node:path";
// @ts-ignore pure JS core shared with tests
import { ShareStore, makeRedactor, publicTarget, exportSessionMarkdown } from "./lib/share-core.mjs";

let configDir = "";
let stateDir = "";
let cacheDir = "";
let store;
let registry = null;
let redact = (t) => ({ text: t, hits: [] });
let secretEngineReady = false;

/** Published audit catalog (dead markings + bilingual notes); overridable for tests/dev. */
const CATALOG_URL = process.env.AITI_SHARE_TARGETS_URL || "https://aiti.pw/share-targets.json";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

async function ensureRuntime(force = false) {
  if (registry && !force) return registry;
  const cs = await import("@aiti-ai/content-share");
  registry = new cs.Registry({
    // Remote overlay: dead markings, bilingual notes and labels from the
    // published audit doc; falls back to the bundled catalog when unreachable.
    url: CATALOG_URL,
    cacheDir: cacheDir || undefined,
  });
  await registry.init(force);
  const { customProvider } = cs;
  registry.register(customProvider());
  // Re-register user-imported .sxcu configs (persisted on the target record) —
  // otherwise they vanish after a process restart and shares fail with
  // "provider unavailable".
  try {
    for (const t of store.readTargets()) {
      if (!t?.config?.RequestURL || registry.get(t.provider)) continue;
      registry.addEntry({ id: t.provider, name: t.name || t.provider,
        kinds: ["text"], category: "publish", source: "user", auth: "none" }, t.config);
    }
  } catch (e) {
    console.warn("[aiti-msg-share] restoring imported configs failed:", (e as Error).message);
  }
  return registry;
}

async function ensureSecretEngine() {
  if (secretEngineReady) return;
  try {
    const engine = await import("@aiti-ai/secret-mask-core");
    redact = makeRedactor(engine);
  } catch (e) {
    console.warn("[aiti-msg-share] secret-mask-core unavailable, redaction disabled:", (e as Error).message);
  }
  secretEngineReady = true;
}

/** Derive a target's setup state for the UI: anonymous / ready / needs-setup. */
function configState(entry: any, userTarget: any, reg: any): string {
  if (entry.status === "dead") return "dead";
  const provider = reg.get(entry.id) || reg.get(userTarget?.provider);
  const required = (provider?.metaFields || []).filter((f: any) => f.required);
  // A user-created target with all required fields filled → ready.
  if (userTarget) {
    const vals = userTarget.values || {};
    const missing = required.filter((f: any) => !String(vals[f.key] ?? "").trim());
    return missing.length === 0 ? "ready" : "needs-setup";
  }
  // No saved target: anonymous when there are no required fields and no token.
  const needsAuth = entry.auth === "token" || entry.auth === "key" || required.length > 0;
  return needsAuth ? "needs-setup" : "anonymous";
}

/** Fields the target needs the user to fill (for the setup form). */
function targetFields(providerId: string, reg: any): any[] {
  const p = reg.get(providerId);
  return (p?.metaFields || []).map((f: any) => ({
    key: f.key, label: f.label, type: f.type || "text",
    required: !!f.required, hint: f.hint || "", options: f.options || null,
  }));
}

function allTargets(reg) {
  const user = store.readTargets();
  const entries = reg.catalog();
  const userByProvider = new Map(user.map((t) => [t.provider, t]));
  return [
    ...user.map((t) => {
      const entry = entries.find((e) => e.id === t.provider);
      return { ...t, custom: true, auth: entry?.auth ?? (t.provider === "custom" ? "key" : "none"),
        kinds: entry?.kinds ?? ["text"], category: entry?.category ?? "publish",
        fields: targetFields(t.provider, reg),
        configState: configState(entry || { id: t.provider }, t, reg) };
    }),
    ...entries.filter((e) => !userByProvider.has(e.id)).map((e) => ({ id: e.id, name: e.name, provider: e.id,
      kinds: e.kinds, category: e.category, auth: e.auth, recommended: e.recommended, note: e.note,
      status: e.status, source: e.source, values: {},
      fields: targetFields(e.id, reg),
      configState: configState(e, null, reg) })),
  ];
}

function findTarget(reg, id) {
  const user = store.readTargets().find((t) => t.id === id);
  if (user) return user;
  const entry = reg.catalog().find((e) => e.id === id);
  return entry ? { id: entry.id, provider: entry.id, values: {}, name: entry.name, kinds: entry.kinds, category: entry.category } : null;
}

export default {
  id: "aiti-msg-share",
  name: "消息分享",
  icon: "icons/share-2.svg",
  client: "dist/aiti-msg-share-client.mjs",
  // Service provider for aiti-editor/msg-smart entry buttons: must register at
  // boot, otherwise consumers' getExtService() sees undefined and hides buttons.
  clientImmediately: true,

  ai: {
    // manage:true is required for ai-helper to aggregate this extension's skills.
    manage: true,
    intro: "消息分享：AI 帮我配置分享目标（Gitee / 图床 / OSS / Joplin 等）、排查分享失败原因、导入 ShareX .sxcu 配置",
    skills: "skills",
  },

  ui: {
    i18n: {
      "en": {
        "share.err.forbidden": "That path is outside the allowed roots — only session workspaces can be shared.",
        "share.err.endpoint": "「{name}」的 API 端点无响应或不支持该操作（{detail}）。该服务的 API 可能已变更，请在「管理目标」检查端点配置。",
        "share.err.network": "Cannot reach 「{name}」 (network unreachable / blocked / service down). Pick another target in Manage targets, or use local-link.",
        "share.err.timeout": "「{name}」 timed out.",
        "share.err.incomplete": "「{name}」 is not fully configured ({detail}). Fill the required fields in Manage targets.",
        "share.err.auth": "「{name}」 rejected the credentials ({detail}). Check the token/key.",
        "share.err.tooLarge": "Content is too large for 「{name}」 ({detail}). Export a compact version or pick another target.",
        "share.err.unavailable": "Provider for 「{name}」 is unavailable — re-import or reconfigure it.",
        "share.err.disabled": "Target 「{name}」 is disabled.",
        "share.err.unknownTarget": "Unknown target — it may have been deleted.",
        "share.err.noSession": "No session payload to share.",
        "share.err.imageFetch": "Could not load the image ({detail}).",
        "share.err.badRequest": "Request is missing required fields.",
        "share.err.badSxcu": "Invalid .sxcu config (missing RequestURL).",
        "share.err.noProbe": "This target does not support connection testing.",
        "share.err.generic": "Share failed: {detail}",
        "share.fixTarget": "Fix this target",
        "share.pageInfo": "Page info",
        "share.pi.os": "OS",
        "share.pi.browser": "Browser",
        "share.pi.url": "URL",
        "share.pi.sessionId": "Session ID",
        "share.pi.sessionName": "Session name",
        "share.use": "Use",
        "share.useTarget": "Use this target for the current share",
        "share.setup": "Setup",
        "share.setupFirst": "Needs setup first",
        "share.saveUse": "Save & use",
        "share.backToShare": "Back to share",
        "share.noSetup": "No setup needed — this target works anonymously.",
                "share.openInNewTab": "Open in new tab",
                "ext.displayName": "Message Share",
        "share.subtitle": "{kind} · {chars} chars",
        "share.sinks": "Save to",
        "share.sink.copy": "Copy",
        "share.sink.copied": "Copied to clipboard",
        "share.sink.saved": "Saved",
        "share.sink.unsupported": "This content cannot be saved here",
        "share.sink.empty": "Nothing to save — the dialog only carries the page-info header (edit the content or share a message/selection)",
        "share.targets": "Share targets",
        "share.more": "Add more…",
        "share.copy": "Copy link",
        "share.system": "System share",
        "share.raw": "Raw",
        "share.delete": "Delete",
        "share.center": "Share center",
        "share.action": "Share",
        "share.session": "Share session",
        "share.sessionTip": "Share all messages in this session",
        "share.fileTip": "Share this file",
        "share.content": "Share this content",
        "share.preview": "Content preview (editable)",
        "share.redactToggle": "Redact",
        "share.redactAuto": "Auto-redact secrets before sharing (optional)",
        "share.titleField": "Title",
        "share.tagsField": "Tags (comma separated)",
        "share.manage": "Manage targets",
        "share.uploading": "Uploading…",
        "share.search": "Search services…",
        "share.recent": "Recently used",
        "share.recommended": "Recommended (online)",
        "share.allTargets": "All targets ({n})",
        "share.kind.text": "text",
        "share.kind.image": "image",
        "share.kind.file": "file",
        "share.clearRecent": "Clear recent",
        "share.importSxcu": "Import .sxcu",
        "share.importPrompt": "Paste .sxcu JSON:",
        "share.refresh": "Refresh online catalog",
        "share.probeDetected": "Local services detected: {ports} (Joplin / Obsidian / memos / SiYuan)",
        "share.selectTarget": "Select a target on the left to configure it",
        "share.saveTest": "Save & test",
        "share.testOk": "✓ Connection OK",
        "share.testFail": "Test failed: {detail}",
        "share.deleteTarget": "Delete target",
        "share.notSet": "(not set)",
        "share.cfg.anonymous": "Anonymous — no setup",
        "share.cfg.ready": "Configured",
        "share.cfg.needs": "Needs setup",
        "share.cfg.dead": "Unavailable",
      },
      "zh-CN": {
        "share.err.forbidden": "该路径不在允许范围内——只能分享会话工作区内的文件。",
        "share.err.endpoint": "「{name}」的 API 端点无效或已变更（{detail}）。请在「管理目标」检查端点配置。",
        "share.err.network": "无法连接「{name}」的服务端（网络不可达 / 被拦截 / 服务宕机）。可在「管理目标」换一个服务，或用 local-link。",
        "share.err.timeout": "「{name}」响应超时。",
        "share.err.incomplete": "「{name}」配置不完整（{detail}）。请在「管理目标」补齐必填字段。",
        "share.err.auth": "「{name}」认证被拒绝（{detail}）。请检查 token / 密钥。",
        "share.err.tooLarge": "内容超过「{name}」的上限（{detail}）。可导出精简版或换一个目标。",
        "share.err.unavailable": "「{name}」的 provider 不可用——请重新导入或重新配置。",
        "share.err.disabled": "目标「{name}」已被禁用。",
        "share.err.unknownTarget": "目标不存在——可能已被删除。",
        "share.err.noSession": "没有可分享的会话内容。",
        "share.err.imageFetch": "图片加载失败（{detail}）。",
        "share.err.badRequest": "请求缺少必要参数。",
        "share.err.badSxcu": "无效的 .sxcu 配置（缺少 RequestURL）。",
        "share.err.noProbe": "该目标不支持连接测试。",
        "share.err.generic": "分享失败：{detail}",
        "share.fixTarget": "去修复此目标",
        "share.pageInfo": "页面信息",
        "share.pi.os": "系统",
        "share.pi.browser": "浏览器",
        "share.pi.url": "网址",
        "share.pi.sessionId": "会话 ID",
        "share.pi.sessionName": "会话名",
        "share.use": "使用",
        "share.useTarget": "用此目标分享当前内容",
        "share.setup": "配置",
        "share.setupFirst": "需要先配置",
        "share.saveUse": "保存并使用",
        "share.backToShare": "返回分享",
        "share.noSetup": "无需配置，此目标可匿名直接使用。",
                "share.openInNewTab": "在新窗口打开",
                "ext.displayName": "消息分享",
        "share.subtitle": "{kind} · {chars} 字符",
        "share.sinks": "收藏",
        "share.sink.copy": "复制",
        "share.sink.copied": "已复制到剪贴板",
        "share.sink.saved": "已保存",
        "share.sink.unsupported": "该内容不能收藏到这里",
        "share.sink.empty": "没有可收藏的正文——当前只有页信息头（可先编辑正文，或改分享消息/选区）",
        "share.targets": "分享目标",
        "share.more": "加更多…",
        "share.copy": "复制链接",
        "share.system": "系统分享",
        "share.raw": "原文",
        "share.delete": "删除",
        "share.center": "分享中心",
        "share.action": "分享",
        "share.session": "分享会话",
        "share.sessionTip": "分享该会话的全部消息",
        "share.fileTip": "分享该文件",
        "share.content": "分享该内容",
        "share.preview": "内容预览（可编辑）",
        "share.redactToggle": "脱敏",
        "share.redactAuto": "分享前自动脱敏（可选）",
        "share.titleField": "标题",
        "share.tagsField": "Tags（逗号分隔）",
        "share.manage": "管理目标",
        "share.uploading": "上传中…",
        "share.search": "搜索服务…",
        "share.recent": "最近使用",
        "share.recommended": "推荐（在线维护）",
        "share.allTargets": "全部目录（{n}）",
        "share.kind.text": "文本",
        "share.kind.image": "图片",
        "share.kind.file": "文件",
        "share.clearRecent": "清除最近",
        "share.importSxcu": "导入 .sxcu",
        "share.importPrompt": "粘贴 .sxcu JSON：",
        "share.refresh": "刷新在线目录",
        "share.probeDetected": "检测到本机服务: {ports}（Joplin / Obsidian / memos / 思源）",
        "share.selectTarget": "从左侧选一个目标进行配置",
        "share.saveTest": "保存并测试",
        "share.testOk": "✓ 测试通过",
        "share.testFail": "测试失败: {detail}",
        "share.deleteTarget": "删除目标",
        "share.notSet": "（未设置）",
        "share.cfg.anonymous": "匿名可用",
        "share.cfg.ready": "已配置",
        "share.cfg.needs": "需配置",
        "share.cfg.dead": "不可用",
      },
      "zh-TW": {
        "share.err.forbidden": "該路徑不在允許範圍內——只能分享工作階段工作區內的檔案。",
        "share.err.endpoint": "「{name}」的 API 端點無效或已變更（{detail}）。請在「管理目標」檢查端點設定。",
        "share.err.network": "無法連線「{name}」的伺服端（網路不可達 / 被封鎖 / 服務當機）。可在「管理目標」換一個服務，或用 local-link。",
        "share.err.timeout": "「{name}」回應逾時。",
        "share.err.incomplete": "「{name}」設定不完整（{detail}）。請在「管理目標」補齊必填欄位。",
        "share.err.auth": "「{name}」認證被拒絕（{detail}）。請檢查 token / 金鑰。",
        "share.err.tooLarge": "內容超過「{name}」的上限（{detail}）。可匯出精簡版或換一個目標。",
        "share.err.unavailable": "「{name}」的 provider 無法使用——請重新匯入或重新設定。",
        "share.err.disabled": "目標「{name}」已被停用。",
        "share.err.unknownTarget": "目標不存在——可能已被刪除。",
        "share.err.noSession": "沒有可分享的工作階段內容。",
        "share.err.imageFetch": "圖片載入失敗（{detail}）。",
        "share.err.badRequest": "請求缺少必要參數。",
        "share.err.badSxcu": "無效的 .sxcu 設定（缺少 RequestURL）。",
        "share.err.noProbe": "該目標不支援連線測試。",
        "share.err.generic": "分享失敗：{detail}",
        "share.fixTarget": "去修復此目標",
        "share.pageInfo": "頁面資訊",
        "share.pi.os": "系統",
        "share.pi.browser": "瀏覽器",
        "share.pi.url": "網址",
        "share.pi.sessionId": "工作階段 ID",
        "share.pi.sessionName": "工作階段名稱",
        "share.use": "使用",
        "share.useTarget": "用此目標分享目前內容",
        "share.setup": "設定",
        "share.setupFirst": "需要先設定",
        "share.saveUse": "儲存並使用",
        "share.backToShare": "返回分享",
        "share.noSetup": "無需設定，此目標可匿名直接使用。",
                "share.openInNewTab": "在新視窗開啟",
                "ext.displayName": "訊息分享",
        "share.subtitle": "{kind} · {chars} 字元",
        "share.sinks": "收藏",
        "share.sink.copy": "複製",
        "share.sink.copied": "已複製到剪貼簿",
        "share.sink.saved": "已儲存",
        "share.sink.unsupported": "此內容無法收藏到這裡",
        "share.sink.empty": "沒有可收藏的正文——目前只有頁資訊標頭（可先編輯正文，或改分享訊息/選取區）",
        "share.targets": "分享目標",
        "share.more": "加更多…",
        "share.copy": "複製連結",
        "share.system": "系統分享",
        "share.raw": "原文",
        "share.delete": "刪除",
        "share.center": "分享中心",
        "share.action": "分享",
        "share.session": "分享工作階段",
        "share.sessionTip": "分享此工作階段的全部訊息",
        "share.fileTip": "分享此檔案",
        "share.content": "分享此內容",
        "share.preview": "內容預覽（可編輯）",
        "share.redactToggle": "脫敏",
        "share.redactAuto": "分享前自動脫敏（選用）",
        "share.titleField": "標題",
        "share.tagsField": "Tags（逗號分隔）",
        "share.manage": "管理目標",
        "share.uploading": "上傳中…",
        "share.search": "搜尋服務…",
        "share.recent": "最近使用",
        "share.recommended": "推薦（線上維護）",
        "share.allTargets": "全部目錄（{n}）",
        "share.kind.text": "文字",
        "share.kind.image": "圖片",
        "share.kind.file": "檔案",
        "share.clearRecent": "清除最近",
        "share.importSxcu": "導入 .sxcu",
        "share.importPrompt": "貼上 .sxcu JSON：",
        "share.refresh": "重新整理線上目錄",
        "share.probeDetected": "偵測到本機服務: {ports}（Joplin / Obsidian / memos / 思源）",
        "share.selectTarget": "從左側選一個目標進行設定",
        "share.saveTest": "儲存並測試",
        "share.testOk": "✓ 測試通過",
        "share.testFail": "測試失敗: {detail}",
        "share.deleteTarget": "刪除目標",
        "share.notSet": "（未設定）",
        "share.cfg.anonymous": "匿名可用",
        "share.cfg.ready": "已設定",
        "share.cfg.needs": "需設定",
        "share.cfg.dead": "不可用",
      },
    },
    dialogs: [{ id: "aiti-msg-share-dialog", label: "aiti-msg-share" }],
    commands: [{ id: "aiti-msg-share.open", label: "i18n:share.center", icon: "icons/share-2.svg" }],
    userMessageActions: [{ id: "aiti-msg-share-user", label: "i18n:share.action" }],
    assistantMessageActions: [{ id: "aiti-msg-share-assistant", label: "i18n:share.action" }],
    // sessionRow share is registered into session-manager's ⋯ menu via the
    // session-row-menu-action topic (no bare row button — too many row actions).
  },

  server: {
  async api(req: any, ctx: any) {
    const p = ctx.path || [];
    if (!configDir) {
      configDir = ctx.configDir || "";
      stateDir = ctx.stateDir || join(dirname(configDir), "state", "aiti-msg-share");
      cacheDir = ctx.cacheDir || join(dirname(configDir), "cache", "aiti-msg-share");
      store = new ShareStore(configDir, stateDir);
    }
    const reg = await ensureRuntime();
    await ensureSecretEngine();

    // POST /refresh — force-reload the remote catalog overlay (bypasses TTL).
    if (p[0] === "refresh" && req.method === "POST") {
      const fresh = await ensureRuntime(true);
      return json({ ok: true, count: fresh.catalog().length });
    }

    // GET /catalog — all targets + metadata
    if (p[0] === "catalog" && req.method === "GET") {
      return json({ ok: true, targets: allTargets(reg), count: reg.catalog().length });
    }

    // GET /targets — persisted user targets
    if (p[0] === "targets" && req.method === "GET") {
      return json({ ok: true, targets: store.readTargets().map((t) => publicTarget(t, reg.get(t.provider))) });
    }

    // POST /targets — upsert a target (secrets stored raw, 0600; masked in responses)
    if (p[0] === "targets" && req.method === "POST") {
      const body = await req.json();
      if (!body?.id || !body?.provider) return json({ ok: false, error: "id and provider required", errorCode: "badRequest" }, 400);
      const saved = store.upsertTarget({ id: body.id, provider: body.provider, name: body.name || body.id,
        values: body.values || {}, tags: body.tags || "", pathPrefix: body.pathPrefix || "", enabled: body.enabled !== false });
      return json({ ok: true, target: publicTarget(saved, reg.get(saved.provider)) });
    }

    // DELETE /targets/:id  (also accepts ?id= for client convenience)
    if (p[0] === "targets" && req.method === "DELETE") {
      const id = p[1] || ctx.searchParams?.get("id");
      if (!id) return json({ ok: false, error: "id required", errorCode: "badRequest" }, 400);
      store.deleteTarget(id);
      return json({ ok: true });
    }

    // POST /targets/test — probe target connectivity
    if (p[0] === "targets" && p[1] === "test" && req.method === "POST") {
      const body = await req.json();
      const provider = reg.get(body?.provider);
      if (!provider?.probe) return json({ ok: false, error: "target does not support probe", errorCode: "noProbe" }, 400);
      return json(await provider.probe({ provider: body.provider, values: body.values || {} }));
    }

    // POST /import-sxcu — register a config at runtime + persist as a target
    if (p[0] === "import-sxcu" && req.method === "POST") {
      const body = await req.json();
      const config = typeof body?.config === "string" ? JSON.parse(body.config) : body?.config;
      if (!config?.RequestURL) return json({ ok: false, error: "invalid .sxcu: missing RequestURL", errorCode: "badSxcu" }, 400);
      const id = body.id || `user-${config.Name || "sxcu"}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      reg.addEntry({ id, name: config.Name || id, kinds: ["text"], category: "publish", source: "user", auth: "none" }, config);
      store.upsertTarget({ id, provider: id, name: config.Name || id, values: {}, enabled: true, custom: true, config });
      return json({ ok: true, id });
    }

    // POST /share — redact then upload via content-share; history to stateDir
    if (p[0] === "share" && req.method === "POST") {
      const body = await req.json();
      const target = findTarget(reg, body?.targetId);
      if (!target) return json({ ok: false, error: "unknown target", errorCode: "unknownTarget" }, 404);
      if (target.enabled === false) return json({ ok: false, error: "target disabled", errorCode: "disabled", errorTarget: target.id }, 403);
      const provider = reg.get(target.provider);
      if (!provider) return json({ ok: false, error: "provider unavailable", errorCode: "unavailable", errorTarget: target.id }, 500);

      const kind = body.kind || "message";
      let content;
      let meta = { title: body.title || "", tags: body.tags || "" };
      if (kind === "session") {
        const session = body.session;
        if (!session) return json({ ok: false, error: "session payload required", errorCode: "noSession" }, 400);
        const text = body.rawText || exportSessionMarkdown(session, { full: !!body.full, title: meta.title,
          tags: String(meta.tags).split(",").map((s) => s.trim()).filter(Boolean) });
        content = { text };
      } else if (body.imageSrc) {
        // Same-origin only: image previews are served by pi-web itself
        // (`/api/sessions/.../tool-result-image`). Blocks SSRF to arbitrary hosts.
        const url = new URL(body.imageSrc, "http://localhost");
        const sameOrigin = url.host === "localhost" || url.host === (typeof location !== "undefined" ? location.host : "")
          || url.hostname === "127.0.0.1";
        if (!sameOrigin) return json({ ok: false, errorCode: "badRequest",
          error: "imageSrc must be a pi-web relative path or 127.0.0.1 URL", detail: url.host }, 400);
        const r = await fetch(url);
        if (!r.ok) return json({ ok: false, error: `image fetch ${r.status}`, errorCode: "imageFetch", detail: String(r.status) }, 502);
        content = { buffer: new Uint8Array(await r.arrayBuffer()), filename: body.filename || "image.png", mime: r.headers.get("content-type") || "image/png" };
      } else if (body.filePath) {
        // Respect pi-web allowed-roots (session cwds): never read arbitrary
        // server files on behalf of the caller.
        const fa = ctx.core?.fileAccess;
        if (fa?.isAllowed) {
          let allowed = false;
          try { allowed = await fa.isAllowed(body.filePath); } catch { allowed = false; }
          if (!allowed) return json({ ok: false, errorCode: "forbidden",
            error: "path is outside the allowed roots", detail: body.filePath }, 403);
        }
        const { readFile } = await import("node:fs/promises");
        const buffer = await readFile(body.filePath);
        const ext = body.filePath.split(".").pop()?.toLowerCase() || "txt";
        const mime = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "text/plain";
        content = ext === "png" || ext === "jpg" || ext === "jpeg"
          ? { buffer, filename: body.filename || body.filePath.split("/").pop(), mime }
          : { text: buffer.toString("utf8"), filename: body.filename || body.filePath.split("/").pop() };
      } else {
        content = { text: body.text || "" };
      }

      const doRedact = body.redact !== false && "text" in content;
      const hooks = doRedact ? { transformText: redact } : undefined;
      const cs = await import("@aiti-ai/content-share");
      let result;
      try {
        result = await cs.share(provider, content,
          { provider: target.provider, values: target.values || {}, tags: meta.tags, pathPrefix: target.pathPrefix },
          meta, hooks);
      } catch (err: any) {
        // Turn a bare "fetch failed" into an actionable message (target + cause + hint).
        const raw = String(err?.message || err);
        const cause = raw.includes("fetch failed") || raw.includes("ECONN")
          ? `无法连接 ${provider.label} 的服务端（网络不可达 / 被拦截 / 服务宕机）`
          : raw.includes("timeout") || raw.includes("Timeout")
            ? `${provider.label} 响应超时`
            : raw;
        // Return a stable errorCode; the client renders localized text.
        const code = /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/.test(raw) ? "network"
          : /timeout|Timeout|ETIMEDOUT/.test(raw) ? "timeout"
          : /incomplete|required|missing/i.test(raw) ? "incomplete"
          : /401|403|Unauthorized|Forbidden|invalid.{0,10}(token|key)/i.test(raw) ? "auth"
          : /413|too large|Content too/i.test(raw) ? "tooLarge"
          : /404|No such service|no URL in response|not found/i.test(raw) ? "endpoint"
          : "provider";
        return json({ ok: false, error: raw, errorCode: code,
          errorTarget: target.id, providerLabel: provider.label, detail: raw }, 502);
      }
      store.appendHistory({ at: new Date().toISOString(), targetId: target.id, kind,
        title: meta.title, url: result.url, extra: result.extra, hits: result.hits,
        redacted: doRedact, bytes: "text" in content ? Buffer.byteLength(content.text) : content.buffer.byteLength });
      return json({ ok: true, ...result });
    }

    // POST /preview-redact — preview redaction on the share text without uploading.
    if (p[0] === "preview-redact" && req.method === "POST") {
      const body = await req.json();
      const original = typeof body?.text === "string" ? body.text : "";
      if (body?.redact === false) return json({ ok: true, text: original, hits: [] });
      const r = redact(original);
      return json({ ok: true, text: r.text, hits: r.hits });
    }

    // GET /history
    if (p[0] === "history" && req.method === "GET") {
      return json({ ok: true, items: store.readHistory() });
    }

    // POST /probe — localhost service detection (Joplin/Obsidian/etc.)
    if (p[0] === "probe" && req.method === "POST") {
      const ports = [41184, 27123, 5230, 6806];
      const found = [];
      await Promise.all(ports.map(async (port) => {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(600) });
          found.push({ port, alive: true, status: r.status });
        } catch {}
      }));
      return json({ ok: true, services: found });
    }

    return json({ ok: false, error: "not found", errorCode: "notFound" }, 404);
  },
  },
};
