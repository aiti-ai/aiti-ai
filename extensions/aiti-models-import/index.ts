/**
 * aiti-models-import · 其他 agent models 配置导入（server 端）
 *
 * 方案：docs/aiti-models-import-plan.md
 * 职责：
 *   - 来源扫描（sources/ 适配器注册表：codex/zcode/opencode M1；cursor/qoder 灰显说明）
 *   - 导入标记（stateDir/import-state.json：首启判定 + 逐源指纹/草稿快照）
 *   - 导入执行：ctx.services 调 aiti-model-wizard saveBatch —— key 明文全程不出 server，
 *     本扩展绝不直写 models.json（红线）
 *   - API：GET /status /scan、POST /import /dismiss /reset
 *
 * 无轮询：/status 由 client register 时拉一次（首启判定）；/scan 仅在弹窗打开/手动刷新时触发。
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

/** 热重载后拿新逻辑（照 aiti-model-wizard loadCore 范式：清原生 require 缓存）。 */
function createModuleLoader() {
  const nativeRequire = createRequire(import.meta.url);
  const bust = () => {
    const cache = nativeRequire.cache || {};
    for (const k of Object.keys(cache)) {
      if (k.includes("aiti-models-import") && (k.endsWith(".cjs"))) delete cache[k];
    }
  };
  return () => {
    bust();
    return {
      core: nativeRequire("./core.cjs"),
      registry: nativeRequire("./sources/registry.cjs"),
    };
  };
}
const loadModules = createModuleLoader();
// 模块加载时 bust 一次 require 缓存并取定实例（热重载 = index.ts 重新 import → 自然拿到新逻辑；
// 与 aiti-model-wizard loadCore 同理，不必逐请求重读文件）
const { core: importCore, registry: sourceRegistry } = loadModules();

/** Server message envelope (see core.msg): adapters/API emit keys, the client resolves them via tsrv(). */
const imsg: (key: string, params?: Record<string, unknown>) => string = importCore.msg;

let configDir = "";
let stateDir = "";

function io() {
  return {
    home: homedir(),
    exists: (p: string) => existsSync(p),
    readText: (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/** 草稿 → UI 视图（脱 key：hasKey + keyHint，明文不出 server；模型清单全量 + 预览元数据）。 */
function draftView(d: any, conflicts: Map<string, { conflict: string; overrideFields: string[] }>, knownIds: Set<string>) {
  const cf = conflicts.get(d.key) || { conflict: "none", overrideFields: [] };
  const meta = d.modelMeta || {};
  const models = (d.models || []).map((m: any) => {
    const mmeta = meta[m.id] || {};
    return {
      id: m.id,
      name: m.name || mmeta.name || m.id,
      contextWindow: m.contextWindow ?? mmeta.contextWindow ?? null,
      maxTokens: m.maxTokens ?? mmeta.maxTokens ?? null,
      reasoning: mmeta.reasoning ?? null,
      input: mmeta.input || null,
      existing: knownIds.has(String(m.id)),
    };
  });
  return {
    key: d.key,
    label: d.label,
    baseUrl: d.baseUrl,
    api: d.api,
    apiKeyEnv: d.apiKeyEnv,
    hasKey: !!d.apiKey,
    keyHint: d.apiKey ? "…" + d.apiKey.slice(-4) : "",
    modelsCount: models.length,
    newModelsCount: models.filter((m: any) => !m.existing).length,
    models,
    warnings: d.warnings || [],
    conflict: cf.conflict,
    overrideFields: cf.overrideFields,
  };
}

export default {
  id: "aiti-models-import",
  name: "模型配置导入（从其他 agent）",
  icon: "icon.svg",
  client: "dist/aiti-models-import.mjs",

  ui: {
    toolbar: [
      { id: "aiti-models-import-open", label: "i18n:mi.open.label", title: "i18n:mi.open.title", icon: "icons/import.svg" },
    ],
    i18n: {
      "zh-CN": {
        "ext.displayName": "模型导入",
        "n": "模型配置导入",
        "it.import.label": "模型配置导入",
        "mi.open.label": "导入模型配置",
        "mi.open.title": "aiti-models-import：从 codex / zcode / opencode 等导入 provider 配置（经模型向导落盘）",

        "mi.shell.title": "从其他 Agent 导入模型配置（codex / zcode / opencode…）",
        "mi.shell.intro": "扫描本机各 agent 的 provider / baseUrl / key / 模型配置，勾选后经 🧙 模型向导合并写入（不覆盖已有 key，可一步撤销）。",
        "mi.shell.rescanTitle": "重新扫描本机 agent 配置",
        "mi.shell.scanning": "扫描中…",
        "mi.shell.rescan": "重新扫描",
        "mi.shell.close": "关闭",
        "mi.shell.scanningList": "正在扫描本机 agent 配置…",
        "mi.shell.firstRunHint": "首次启动引导：关闭后可从工具条「导入模型配置」再次打开",

        "mi.act.wizard": "🧙 配置模型",
        "mi.act.wizardTitle": "打开 🧙 模型向导（添加 / 管理 provider、模型、聚合与多 key）",
        "mi.act.later": "暂不",
        "mi.act.importing": "导入中…",
        "mi.act.importCount": "导入勾选项（{count}）",

        "mi.state.available": "可导入",
        "mi.state.changed": "有更新",
        "mi.state.unchanged": "无变化",
        "mi.state.gone": "源已消失",

        "mi.list.scanFailedDetail": "扫描失败：{error}",
        "mi.list.empty": "未发现可导入的 agent 配置（codex / zcode / opencode 均未安装或无 provider 配置）。",
        "mi.list.otherRow": "· {label}：不可导入 —— {reason}",
        "mi.src.noProviders": "无可导入 provider",
        "mi.src.listSep": "；",

        "mi.row.noKey": "无 key",
        "mi.row.previewTitle": "点击查看待带入的模型清单",
        "mi.row.models": "👁 {count} 模型",
        "mi.row.overrideTitle": "将覆盖字段：{fields}",
        "mi.row.override": "覆盖 {fields}",
        "mi.row.mergeTitle": "同名 provider 已存在且 baseUrl 一致，将合并字段",
        "mi.row.merge": "合并",

        "mi.prev.noModels": "来源配置不带模型清单——导入后在 🧙 向导「拉取 /models」补齐",
        "mi.prev.intro": "将带入 {count} 个模型",
        "mi.prev.introKnown": "（新增 {added} · 已有 {known}，同 id 合并字段不重复）",
        "mi.prev.colModel": "模型",
        "mi.prev.colContext": "上下文",
        "mi.prev.colOutput": "输出",
        "mi.prev.colStatus": "能力 / 状态",
        "mi.prev.reasoning": "推理",
        "mi.prev.new": "新增",
        "mi.prev.existing": "已有",
        "mi.prev.noMeta": "来源配置未提供模型参数——上下文 / 输出上限由 🧙 向导保存时反填（本表「—」即待反填）。",
        "mi.modality.text": "文本",
        "mi.modality.image": "图像",
        "mi.modality.video": "视频",
        "mi.modality.audio": "音频",

        "mi.ok.imported": "已导入 {count} 个 provider，模型选择器已可刷新查看",
        "mi.ok.importedWithWarnings": "已导入 {count} 个 provider（注意：{warn}），模型选择器已可刷新查看",
        "mi.err.unknown": "未知错误",
        "mi.err.importFailed": "导入失败",
        "mi.err.wizardMissing": "未找到模型向导（aiti-model-wizard 扩展未加载）——请先在扩展管理部署/启用 aiti-model-wizard。",

        "mi.srv.notInitialized": "扩展未初始化",
        "mi.srv.scanThrew": "扫描异常：{detail}",
        "mi.srv.badSaves": "需要 saves: [{sourceId, key}]",
        "mi.srv.noSaveBatch": "aiti-model-wizard 未提供 saveBatch 服务（未部署或版本过旧）——请先升级/部署模型向导扩展",
        "mi.srv.unknownSource": "未知来源",
        "mi.srv.sourceUnavailable": "来源不可用：{reason}",
        "mi.srv.draftGone": "草稿已不存在（来源配置已变化），请重新扫描",
        "mi.srv.saveBatchThrew": "saveBatch 异常：{detail}",
        "mi.srv.saveBatchFailed": "saveBatch 失败",
        "mi.srv.markerWriteFailed": "已导入但标记未更新：{detail}",

        "mi.srv.codex.notInstalled": "未安装（无 ~/.codex/config.toml）",
        "mi.srv.codex.readFailed": "config.toml 读取失败",
        "mi.srv.codex.tomlDepMissing": "TOML 解析依赖未就绪（smol-toml），等扩展依赖 reconcile 完成后重试",
        "mi.srv.codex.parseFailed": "config.toml 解析失败：{detail}",
        "mi.srv.codex.empty": "config.toml 为空",
        "mi.srv.codex.authNote": "~/.codex/auth.json 为官方 OAuth 登录态，不在导入范围（与 pi models.json 型互斥）",
        "mi.srv.codex.noBaseUrl": "model_providers.{key} 无 base_url（官方内置），跳过",
        "mi.srv.codex.envKey": "key 走环境变量 {env}（需 pi-web 进程可见；导入后可在向导改为直填）",
        "mi.srv.codex.noKey": "未声明 env_key，导入后需在 🧙 向导补 key",
        "mi.srv.codex.noModels": "codex 配置不携带模型清单，导入后可在向导里拉取 /models",
        "mi.srv.codex.noProviders": "config.toml 未配置自定义 model_providers（仅官方登录），无可导入 provider",

        "mi.srv.zcode.notInstalled": "未安装（无 ~/.zcode/v2/config.json）",
        "mi.srv.zcode.readFailed": "config.json 读取失败",
        "mi.srv.zcode.parseFailed": "config.json 解析失败：{detail}",
        "mi.srv.zcode.planChannel": "通道 {channel} 为套餐（start-plan）通道：验证码只能桌面端产生，pi-web 无法驱动，跳过",
        "mi.srv.zcode.noPlan": "通道 {channel} 无有效套餐授权，跳过",
        "mi.srv.zcode.noBaseUrl": "通道 {channel} 无 baseURL，跳过",
        "mi.srv.zcode.encryptedKey": "key 在 ZCode 桌面端加密存储（credentials.json），导入后请在 🧙 向导给该 provider 补 key",
        "mi.srv.zcode.noProviders": "config.json 未配置可导入的 provider 通道",

        "mi.srv.opencode.notInstalled": "未安装（无 ~/.config/opencode/opencode.json）",
        "mi.srv.opencode.fileReadFailed": "{file} 读取失败",
        "mi.srv.opencode.fileParseFailed": "{file} 解析失败：{detail}",
        "mi.srv.opencode.authParseFailed": "auth.json 解析失败，忽略其中的 key",
        "mi.srv.opencode.noBaseUrl": "provider {provider} 无 options.baseURL，跳过",
        "mi.srv.opencode.unknownSdk": "SDK 包 {npm} 未识别，按 openai-completions 导入，请在向导确认协议",
        "mi.srv.opencode.noModels": "本地无模型清单（opencode 依赖 models.dev 远端补全），导入后可在向导拉取 /models",
        "mi.srv.opencode.noKey": "未找到 API key（options.apiKey / auth.json 均无），导入后需在向导补",
        "mi.srv.opencode.noProviders": "配置里未发现带 baseURL 的 provider",

        "mi.srv.cursor.reason": "无文件化模型配置——登录态在 auth.json（加密），模型为会话内 lastUsedModel，无可导入项",
        "mi.srv.qoder.reason": "凭据 WASM 加密、端点为区域常量，模型清单来自服务端 API 而非本地配置文件",
      },
      en: {
        "ext.displayName": "Model Import",
        "n": "Model Config Import",
        "it.import.label": "Model config import",
        "mi.open.label": "Import model configs",
        "mi.open.title": "aiti-models-import: import provider configs from codex / zcode / opencode etc. (lands via model wizard)",

        "mi.shell.title": "Import model configs from other agents (codex / zcode / opencode…)",
        "mi.shell.intro": "Scans the provider / baseUrl / key / model configs of the agents installed on this machine. Checked entries are merged in through the 🧙 model wizard (existing keys are kept, undo in one step).",
        "mi.shell.rescanTitle": "Rescan local agent configs",
        "mi.shell.scanning": "Scanning…",
        "mi.shell.rescan": "Rescan",
        "mi.shell.close": "Close",
        "mi.shell.scanningList": "Scanning local agent configs…",
        "mi.shell.firstRunHint": "First-run guide: after closing, reopen it from the toolbar (\"Import model configs\")",

        "mi.act.wizard": "🧙 Configure models",
        "mi.act.wizardTitle": "Open the 🧙 model wizard (add / manage providers, models, aggregation and multi-key)",
        "mi.act.later": "Not now",
        "mi.act.importing": "Importing…",
        "mi.act.importCount": "Import selected ({count})",

        "mi.state.available": "Importable",
        "mi.state.changed": "Update available",
        "mi.state.unchanged": "No changes",
        "mi.state.gone": "Source removed",

        "mi.list.scanFailedDetail": "Scan failed: {error}",
        "mi.list.empty": "No importable agent configs found (codex / zcode / opencode are either not installed or have no provider configs).",
        "mi.list.otherRow": "· {label}: not importable — {reason}",
        "mi.src.noProviders": "No importable providers",
        "mi.src.listSep": "; ",

        "mi.row.noKey": "no key",
        "mi.row.previewTitle": "Click to preview the models that will be imported",
        "mi.row.models": "👁 {count} models",
        "mi.row.overrideTitle": "Fields to overwrite: {fields}",
        "mi.row.override": "overwrite {fields}",
        "mi.row.mergeTitle": "A provider with the same name and an identical baseUrl exists; fields will be merged",
        "mi.row.merge": "merge",

        "mi.prev.noModels": "This source carries no model list — after importing, fill it in via \"Fetch /models\" in the 🧙 wizard",
        "mi.prev.intro": "{count} models will be imported",
        "mi.prev.introKnown": " ({added} new · {known} existing; same id merges fields instead of duplicating)",
        "mi.prev.colModel": "Model",
        "mi.prev.colContext": "Context",
        "mi.prev.colOutput": "Output",
        "mi.prev.colStatus": "Capabilities / status",
        "mi.prev.reasoning": "reasoning",
        "mi.prev.new": "new",
        "mi.prev.existing": "existing",
        "mi.prev.noMeta": "This source provides no model parameters — context / output limits are backfilled when the 🧙 wizard saves (\"—\" here means pending).",
        "mi.modality.text": "text",
        "mi.modality.image": "image",
        "mi.modality.video": "video",
        "mi.modality.audio": "audio",

        "mi.ok.imported": "Imported {count} provider(s); the model selector can refresh now",
        "mi.ok.importedWithWarnings": "Imported {count} provider(s) (note: {warn}); the model selector can refresh now",
        "mi.err.unknown": "Unknown error",
        "mi.err.importFailed": "Import failed",
        "mi.err.wizardMissing": "Model wizard not found (the aiti-model-wizard extension is not loaded) — deploy/enable aiti-model-wizard in the extension manager first.",

        "mi.srv.notInitialized": "Extension is not initialized",
        "mi.srv.scanThrew": "Scan error: {detail}",
        "mi.srv.badSaves": "Expected saves: [{sourceId, key}]",
        "mi.srv.noSaveBatch": "aiti-model-wizard does not provide the saveBatch service (not installed or outdated) — upgrade/deploy the model wizard extension first",
        "mi.srv.unknownSource": "Unknown source",
        "mi.srv.sourceUnavailable": "Source unavailable: {reason}",
        "mi.srv.draftGone": "The draft no longer exists (the source config changed); please rescan",
        "mi.srv.saveBatchThrew": "saveBatch error: {detail}",
        "mi.srv.saveBatchFailed": "saveBatch failed",
        "mi.srv.markerWriteFailed": "Imported, but the marker was not updated: {detail}",

        "mi.srv.codex.notInstalled": "Not installed (no ~/.codex/config.toml)",
        "mi.srv.codex.readFailed": "Failed to read config.toml",
        "mi.srv.codex.tomlDepMissing": "TOML parser dependency not ready (smol-toml); retry once the extension dependency reconcile finishes",
        "mi.srv.codex.parseFailed": "Failed to parse config.toml: {detail}",
        "mi.srv.codex.empty": "config.toml is empty",
        "mi.srv.codex.authNote": "~/.codex/auth.json holds the official OAuth session and is out of scope (mutually exclusive with pi models.json providers)",
        "mi.srv.codex.noBaseUrl": "model_providers.{key} has no base_url (official built-in); skipped",
        "mi.srv.codex.envKey": "The key comes from env var {env} (it must be visible to the pi-web process; switch to a literal key in the wizard after importing)",
        "mi.srv.codex.noKey": "No env_key declared; add the key in the 🧙 wizard after importing",
        "mi.srv.codex.noModels": "The codex config carries no model list; fetch /models in the wizard after importing",
        "mi.srv.codex.noProviders": "config.toml declares no custom model_providers (official login only); nothing to import",

        "mi.srv.zcode.notInstalled": "Not installed (no ~/.zcode/v2/config.json)",
        "mi.srv.zcode.readFailed": "Failed to read config.json",
        "mi.srv.zcode.parseFailed": "Failed to parse config.json: {detail}",
        "mi.srv.zcode.planChannel": "Channel {channel} is a plan (start-plan) channel: the verification code can only be produced by the desktop app and pi-web cannot drive it; skipped",
        "mi.srv.zcode.noPlan": "Channel {channel} has no valid plan entitlement; skipped",
        "mi.srv.zcode.noBaseUrl": "Channel {channel} has no baseURL; skipped",
        "mi.srv.zcode.encryptedKey": "The key is stored encrypted by the ZCode desktop app (credentials.json); add the key for this provider in the 🧙 wizard after importing",
        "mi.srv.zcode.noProviders": "config.json declares no importable provider channel",

        "mi.srv.opencode.notInstalled": "Not installed (no ~/.config/opencode/opencode.json)",
        "mi.srv.opencode.fileReadFailed": "Failed to read {file}",
        "mi.srv.opencode.fileParseFailed": "Failed to parse {file}: {detail}",
        "mi.srv.opencode.authParseFailed": "Failed to parse auth.json; its keys are ignored",
        "mi.srv.opencode.noBaseUrl": "provider {provider} has no options.baseURL; skipped",
        "mi.srv.opencode.unknownSdk": "SDK package {npm} is unrecognized; importing as openai-completions — confirm the protocol in the wizard",
        "mi.srv.opencode.noModels": "No local model list (opencode relies on the remote models.dev catalog); fetch /models in the wizard after importing",
        "mi.srv.opencode.noKey": "No API key found (neither options.apiKey nor auth.json); add it in the wizard after importing",
        "mi.srv.opencode.noProviders": "No provider with a baseURL found in the configs",

        "mi.srv.cursor.reason": "No file-backed model config — the session lives in auth.json (encrypted) and the model is the in-session lastUsedModel; nothing to import",
        "mi.srv.qoder.reason": "Credentials are WASM-encrypted and endpoints are regional constants; the model list comes from a server API rather than a local config file",
      },
      "zh-TW": {
        "ext.displayName": "模型匯入",
        "n": "模型設定匯入",
        "it.import.label": "模型設定匯入",
        "mi.open.label": "匯入模型設定",
        "mi.open.title": "aiti-models-import：從 codex / zcode / opencode 等匯入 provider 設定（經模型精靈寫入）",

        "mi.shell.title": "從其他 Agent 匯入模型設定（codex / zcode / opencode…）",
        "mi.shell.intro": "掃描本機各 agent 的 provider / baseUrl / key / 模型設定，勾選後經 🧙 模型精靈合併寫入（不覆蓋既有 key，可一步復原）。",
        "mi.shell.rescanTitle": "重新掃描本機 agent 設定",
        "mi.shell.scanning": "掃描中…",
        "mi.shell.rescan": "重新掃描",
        "mi.shell.close": "關閉",
        "mi.shell.scanningList": "正在掃描本機 agent 設定…",
        "mi.shell.firstRunHint": "首次啟動引導：關閉後可從工具列「匯入模型設定」再次開啟",

        "mi.act.wizard": "🧙 設定模型",
        "mi.act.wizardTitle": "開啟 🧙 模型精靈（新增 / 管理 provider、模型、聚合與多 key）",
        "mi.act.later": "暫不",
        "mi.act.importing": "匯入中…",
        "mi.act.importCount": "匯入勾選項（{count}）",

        "mi.state.available": "可匯入",
        "mi.state.changed": "有更新",
        "mi.state.unchanged": "無變化",
        "mi.state.gone": "來源已消失",

        "mi.list.scanFailedDetail": "掃描失敗：{error}",
        "mi.list.empty": "未發現可匯入的 agent 設定（codex / zcode / opencode 均未安裝或無 provider 設定）。",
        "mi.list.otherRow": "· {label}：不可匯入 —— {reason}",
        "mi.src.noProviders": "無可匯入 provider",
        "mi.src.listSep": "；",

        "mi.row.noKey": "無 key",
        "mi.row.previewTitle": "點擊查看待帶入的模型清單",
        "mi.row.models": "👁 {count} 模型",
        "mi.row.overrideTitle": "將覆寫欄位：{fields}",
        "mi.row.override": "覆寫 {fields}",
        "mi.row.mergeTitle": "同名 provider 已存在且 baseUrl 一致，將合併欄位",
        "mi.row.merge": "合併",

        "mi.prev.noModels": "來源設定不帶模型清單——匯入後在 🧙 精靈「拉取 /models」補齊",
        "mi.prev.intro": "將帶入 {count} 個模型",
        "mi.prev.introKnown": "（新增 {added} · 已有 {known}，同 id 合併欄位不重複）",
        "mi.prev.colModel": "模型",
        "mi.prev.colContext": "上下文",
        "mi.prev.colOutput": "輸出",
        "mi.prev.colStatus": "能力 / 狀態",
        "mi.prev.reasoning": "推理",
        "mi.prev.new": "新增",
        "mi.prev.existing": "已有",
        "mi.prev.noMeta": "來源設定未提供模型參數——上下文 / 輸出上限由 🧙 精靈儲存時反填（本表「—」即待反填）。",
        "mi.modality.text": "文字",
        "mi.modality.image": "圖像",
        "mi.modality.video": "影片",
        "mi.modality.audio": "音訊",

        "mi.ok.imported": "已匯入 {count} 個 provider，模型選擇器已可重新整理檢視",
        "mi.ok.importedWithWarnings": "已匯入 {count} 個 provider（注意：{warn}），模型選擇器已可重新整理檢視",
        "mi.err.unknown": "未知錯誤",
        "mi.err.importFailed": "匯入失敗",
        "mi.err.wizardMissing": "找不到模型精靈（aiti-model-wizard 擴充未載入）——請先在擴充管理部署/啟用 aiti-model-wizard。",

        "mi.srv.notInitialized": "擴充未初始化",
        "mi.srv.scanThrew": "掃描例外：{detail}",
        "mi.srv.badSaves": "需要 saves: [{sourceId, key}]",
        "mi.srv.noSaveBatch": "aiti-model-wizard 未提供 saveBatch 服務（未部署或版本過舊）——請先升級/部署模型精靈擴充",
        "mi.srv.unknownSource": "未知來源",
        "mi.srv.sourceUnavailable": "來源不可用：{reason}",
        "mi.srv.draftGone": "草稿已不存在（來源設定已變更），請重新掃描",
        "mi.srv.saveBatchThrew": "saveBatch 例外：{detail}",
        "mi.srv.saveBatchFailed": "saveBatch 失敗",
        "mi.srv.markerWriteFailed": "已匯入但標記未更新：{detail}",

        "mi.srv.codex.notInstalled": "未安裝（無 ~/.codex/config.toml）",
        "mi.srv.codex.readFailed": "config.toml 讀取失敗",
        "mi.srv.codex.tomlDepMissing": "TOML 解析相依套件未就緒（smol-toml），等擴充相依 reconcile 完成後重試",
        "mi.srv.codex.parseFailed": "config.toml 解析失敗：{detail}",
        "mi.srv.codex.empty": "config.toml 為空",
        "mi.srv.codex.authNote": "~/.codex/auth.json 為官方 OAuth 登入態，不在匯入範圍（與 pi models.json 型互斥）",
        "mi.srv.codex.noBaseUrl": "model_providers.{key} 無 base_url（官方內建），略過",
        "mi.srv.codex.envKey": "key 走環境變數 {env}（需 pi-web 程序可見；匯入後可在精靈改為直接填寫）",
        "mi.srv.codex.noKey": "未宣告 env_key，匯入後需在 🧙 精靈補 key",
        "mi.srv.codex.noModels": "codex 設定不帶模型清單，匯入後可在精靈裡拉取 /models",
        "mi.srv.codex.noProviders": "config.toml 未設定自訂 model_providers（僅官方登入），無可匯入 provider",

        "mi.srv.zcode.notInstalled": "未安裝（無 ~/.zcode/v2/config.json）",
        "mi.srv.zcode.readFailed": "config.json 讀取失敗",
        "mi.srv.zcode.parseFailed": "config.json 解析失敗：{detail}",
        "mi.srv.zcode.planChannel": "通道 {channel} 為套餐（start-plan）通道：驗證碼只能桌面端產生，pi-web 無法驅動，略過",
        "mi.srv.zcode.noPlan": "通道 {channel} 無有效套餐授權，略過",
        "mi.srv.zcode.noBaseUrl": "通道 {channel} 無 baseURL，略過",
        "mi.srv.zcode.encryptedKey": "key 在 ZCode 桌面端加密儲存（credentials.json），匯入後請在 🧙 精靈給該 provider 補 key",
        "mi.srv.zcode.noProviders": "config.json 未設定可匯入的 provider 通道",

        "mi.srv.opencode.notInstalled": "未安裝（無 ~/.config/opencode/opencode.json）",
        "mi.srv.opencode.fileReadFailed": "{file} 讀取失敗",
        "mi.srv.opencode.fileParseFailed": "{file} 解析失敗：{detail}",
        "mi.srv.opencode.authParseFailed": "auth.json 解析失敗，忽略其中的 key",
        "mi.srv.opencode.noBaseUrl": "provider {provider} 無 options.baseURL，略過",
        "mi.srv.opencode.unknownSdk": "SDK 套件 {npm} 未識別，按 openai-completions 匯入，請在精靈確認協定",
        "mi.srv.opencode.noModels": "本機無模型清單（opencode 依賴 models.dev 遠端補全），匯入後可在精靈拉取 /models",
        "mi.srv.opencode.noKey": "未找到 API key（options.apiKey / auth.json 均無），匯入後需在精靈補",
        "mi.srv.opencode.noProviders": "設定裡未發現帶 baseURL 的 provider",

        "mi.srv.cursor.reason": "無檔案化模型設定——登入態在 auth.json（加密），模型為會話內 lastUsedModel，無可匯入項",
        "mi.srv.qoder.reason": "憑證以 WASM 加密、端點為區域常量，模型清單來自服務端 API 而非本機設定檔",
      },
    },

    dialogs: [{ id: "aiti-models-import-dialog", label: "aiti-models-import" }],
  },

  server: {
    startup(ctx: any) {
      configDir = ctx.configDir || "";
      stateDir = ctx.stateDir || (configDir ? pathJoin(configDir, "state") : "");

      const marker = importCore.readMarker(stateDir);
      console.log("[aiti-models-import] 就绪 · stateDir=" + stateDir + " · 来源 " + sourceRegistry.listSources().length + " 个 · 首启=" + importCore.isFirstRun(marker));
    },

    async api(req: any, ctx: any) {
      const p = ctx.path || [];
      if (!stateDir) return json({ ok: false, error: imsg("mi.srv.notInitialized") }, 500);
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });


      // GET /status —— 轻量（只看文件存在性，不解析）：首启判定数据源 + 各源可用性
      if (p[0] === "status" && req.method === "GET") {
        const marker = importCore.readMarker(stateDir);
        const home = homedir();
        const sources = sourceRegistry.listSources().map((s: any) => {
          const files = (s.homeFiles ? s.homeFiles(home) : []).map((f: any) => ({ path: f.path, label: f.label, exists: existsSync(f.path) }));
          const available = s.kind === "importable" && files.some((f: any) => f.exists);
          const record = marker.sources[s.id];
          return {
            id: s.id,
            label: s.label,
            kind: s.kind,
            reason: s.reason || null,
            files,
            available,
            notImportable: s.kind !== "importable",
            recorded: !!record,
            lastImportedAt: record?.importedAt || null,
          };
        });
        return json({
          ok: true,
          firstRun: importCore.isFirstRun(marker),
          completed: !!marker.completedAt,
          dismissed: !!marker.dismissedAt,
          sources,
        });
      }

      // GET /scan —— 全量扫描：解析 → 草稿（脱 key）→ 源级状态 + 冲突检测
      if (p[0] === "scan" && req.method === "GET") {
        const marker = importCore.readMarker(stateDir);
        const ioEnv = io();
        let providersMap: any = {};
        try { providersMap = (await ctx.core.readModelsConfig())?.providers || {}; } catch { /* 读不到按空处理 */ }
        const sources: any[] = [];
        for (const s of sourceRegistry.listSources()) {
          const base: any = { id: s.id, label: s.label, kind: s.kind, reason: s.reason || null, notes: [] as string[] };
          if (s.kind !== "importable") { sources.push({ ...base, available: false, notImportable: true, state: null, drafts: [] }); continue; }
          let r: any;
          try { r = s.scan(ioEnv); } catch (e: any) { r = { available: false, reason: imsg("mi.srv.scanThrew", { detail: String((e && e.message) || e) }), drafts: [], notes: [] }; }
          if (!r.available) {
            const record = marker.sources[s.id];
            sources.push({ ...base, available: false, state: record ? "source-gone" : null, drafts: [], notes: r.notes || [] });
            continue;
          }
          const drafts = (r.drafts || []).map((d: any) => importCore.normalizeDraft(d));
          const fingerprint = importCore.sourceFingerprint(drafts);
          const state = importCore.sourceState({ available: true, record: marker.sources[s.id], fingerprint });
          const conflicts = importCore.detectConflicts(drafts, providersMap);
          sources.push({
            ...base,
            available: true,
            state,
            fingerprint,
            drafts: drafts.map((d: any) => draftView(d, conflicts, new Set(importCore.knownModelIds(providersMap, d.key)))),
            notes: r.notes || [],
          });
        }
        return json({ ok: true, scannedAt: Date.now(), firstRun: importCore.isFirstRun(marker), completed: !!marker.completedAt, sources });
      }

      // POST /import —— 勾选草稿 → saveBatch（service）→ 更新标记；key 明文不出 server
      if (p[0] === "import" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const seen = new Set<string>();
        const wants: Array<{ sourceId: string; key: string }> = Array.isArray(body?.saves)
          ? body.saves.map((x: any) => ({ sourceId: String(x?.sourceId || ""), key: String(x?.key || "") })).filter((x: any) => {
            if (!x.sourceId || !x.key) return false;
            const k = x.sourceId + ":" + x.key;
            if (seen.has(k)) return false; // 重复勾选去重（upsert 幂等，但结果/快照会重复）
            seen.add(k);
            return true;
          })
          : [];
        if (!wants.length) return json({ ok: false, error: imsg("mi.srv.badSaves") }, 400);

        const svc = ctx.services?.get?.("aiti-model-wizard.saveBatch");
        if (typeof svc !== "function") {
          return json({ ok: false, error: imsg("mi.srv.noSaveBatch") }, 503);
        }

        // 逐源新鲜扫描（不用 /scan 缓存——来源文件可能已变；以导入瞬间为准）
        const ioEnv = io();
        const bySource = new Map<string, { adapter: any; scan: any }>();
        const saves: any[] = [];
        const results: any[] = [];
        const importedBySource = new Map<string, any[]>();

        for (const w of wants) {
          if (!bySource.has(w.sourceId)) {
            const adapter = sourceRegistry.listSources().find((s: any) => s.id === w.sourceId && s.kind === "importable");
            if (!adapter) { bySource.set(w.sourceId, { adapter: null, scan: null }); continue; }
            let sc: any;
            try { sc = adapter.scan(ioEnv); } catch (e: any) { sc = { available: false, reason: String((e && e.message) || e), drafts: [] }; }
            bySource.set(w.sourceId, { adapter, scan: sc });
          }
          const entry = bySource.get(w.sourceId)!;
          if (!entry.adapter) { results.push({ sourceId: w.sourceId, key: w.key, ok: false, error: imsg("mi.srv.unknownSource") }); continue; }
          if (!entry.scan.available) { results.push({ sourceId: w.sourceId, key: w.key, ok: false, error: imsg("mi.srv.sourceUnavailable", { reason: entry.scan.reason || "" }) }); continue; }
          const draft = (entry.scan.drafts || []).map((d: any) => importCore.normalizeDraft(d)).find((d: any) => d.key === w.key);
          if (!draft) { results.push({ sourceId: w.sourceId, key: w.key, ok: false, error: imsg("mi.srv.draftGone") }); continue; }
          saves.push({
            provider: draft.key,
            baseUrl: draft.baseUrl,
            api: draft.api,
            apiKey: draft.apiKey || undefined,
            apiKeyEnv: draft.apiKeyEnv || undefined,
            models: draft.models,
            keepKey: true, // 同名 provider 已有 key 不被清掉
          });
          const arr = importedBySource.get(w.sourceId) || [];
          arr.push(draft);
          importedBySource.set(w.sourceId, arr);
        }

        let batch: any = null;
        if (saves.length) {
          try { batch = await svc({ saves }); } catch (e: any) { return json({ ok: false, error: imsg("mi.srv.saveBatchThrew", { detail: String((e && e.message) || e) }) }, 500); }
          if (!batch || batch.ok !== true) {
            return json({ ok: false, error: (batch && batch.error) || imsg("mi.srv.saveBatchFailed"), results: batch?.results || [] }, 500);
          }
        }

        // saveBatch 逐条结果回填（失败条目不进标记）
        const okKeys = new Set<string>((batch?.results || []).filter((r: any) => r.ok).map((r: any) => r.provider));
        const marker = importCore.readMarker(stateDir);
        for (const [sourceId, drafts] of importedBySource) {
          const succeeded = drafts.filter((d: any) => okKeys.has(d.key));
          for (const d of succeeded) results.push({ sourceId, key: d.key, ok: true, modelCount: (d.models || []).length });
          if (!succeeded.length) continue;
          const entry = bySource.get(sourceId)!;
          const allDrafts = (entry.scan.drafts || []).map((d: any) => importCore.normalizeDraft(d));
          const full = succeeded.length === allDrafts.length && allDrafts.every((d: any) => succeeded.some((s: any) => s.key === d.key));
          marker.sources[sourceId] = {
            fingerprint: full ? importCore.sourceFingerprint(allDrafts) : null,
            importedAt: Date.now(),
            scannedAt: Date.now(),
            providers: succeeded.map((d: any) => importCore.snapshotDraft(d)),
          };
        }
        // completedAt 仅在确有导入成功时记录——全失败的「导入」不算完成，首启引导还要再弹
        if (body?.completed === true && okKeys.size > 0 && marker.completedAt == null) marker.completedAt = Date.now();
        try { importCore.writeMarker(stateDir, marker); } catch (e: any) {
          results.push({ ok: false, error: imsg("mi.srv.markerWriteFailed", { detail: String((e && e.message) || e) }) });
        }
        const failed = results.filter((r: any) => r.ok === false);
        return json({ ok: true, imported: okKeys.size, results, warnings: failed.length ? failed.map((f: any) => f.error) : [] });
      }

      // POST /dismiss —— 首启弹窗被关（不再自动弹，可手动打开）；已完成导入时无意义，跳过
      if (p[0] === "dismiss" && req.method === "POST") {
        const marker = importCore.readMarker(stateDir);
        if (!marker.completedAt && !marker.dismissedAt) marker.dismissedAt = Date.now();
        importCore.writeMarker(stateDir, marker);
        return json({ ok: true });
      }

      // POST /reset —— 清标记（调试/重测）
      if (p[0] === "reset" && req.method === "POST") {
        importCore.writeMarker(stateDir, { version: importCore.MARKER_VERSION, completedAt: null, dismissedAt: null, sources: {} });
        return json({ ok: true });
      }

      return json({ ok: false, error: "not found" }, 404);
    },
  },
};
