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
  version: "0.1.0",
  icon: "icon.svg",
  client: "dist/aiti-models-import.mjs",

  ui: {
    toolbar: [
      { id: "aiti-models-import-open", label: "导入模型配置", title: "aiti-models-import：从 codex / zcode / opencode 等导入 provider 配置（经模型向导落盘）", icon: "icons/import.svg" },
    ],
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
      if (!stateDir) return json({ ok: false, error: "扩展未初始化" }, 500);
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
          try { r = s.scan(ioEnv); } catch (e: any) { r = { available: false, reason: "扫描异常：" + String((e && e.message) || e), drafts: [], notes: [] }; }
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
        if (!wants.length) return json({ ok: false, error: "需要 saves: [{sourceId, key}]" }, 400);

        const svc = ctx.services?.get?.("aiti-model-wizard.saveBatch");
        if (typeof svc !== "function") {
          return json({ ok: false, error: "aiti-model-wizard 未提供 saveBatch 服务（未部署或版本过旧）——请先升级/部署模型向导扩展" }, 503);
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
          if (!entry.adapter) { results.push({ sourceId: w.sourceId, key: w.key, ok: false, error: "未知来源" }); continue; }
          if (!entry.scan.available) { results.push({ sourceId: w.sourceId, key: w.key, ok: false, error: "来源不可用：" + (entry.scan.reason || "") }); continue; }
          const draft = (entry.scan.drafts || []).map((d: any) => importCore.normalizeDraft(d)).find((d: any) => d.key === w.key);
          if (!draft) { results.push({ sourceId: w.sourceId, key: w.key, ok: false, error: "草稿已不存在（来源配置已变化），请重新扫描" }); continue; }
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
          try { batch = await svc({ saves }); } catch (e: any) { return json({ ok: false, error: "saveBatch 异常：" + String((e && e.message) || e) }, 500); }
          if (!batch || batch.ok !== true) {
            return json({ ok: false, error: (batch && batch.error) || "saveBatch 失败", results: batch?.results || [] }, 500);
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
          results.push({ ok: false, error: "已导入但标记未更新：" + String((e && e.message) || e) });
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
