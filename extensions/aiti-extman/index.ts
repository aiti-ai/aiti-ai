/**
 * aiti-extman · pi-web 扩展管理器
 *
 * 把扩展管理从 pi-web 内置 UI 迁出为扩展（业务在扩展，core 只留挂载点/契约）：
 *   - 状态：GET /api/extensions/aiti-extman/status（registry 全量状态，含禁用/失败条目）
 *   - 在线注册表：GET /api/extensions/aiti-extman/registry（代理 aiti.pw/extensions.json，短缓存）
 *   - 操作：POST /api/extensions/aiti-extman/ops
 *       { action: "install", source: "git:…|npm:…|/path", id?, docsUrl?, publisherHint?, trust? }
 *         · trust 门控（VSCode 式）：安装前解析发行者（npm registry / github owner / package.json），
 *           未信任 → 回 needsTrust 不安装，前端弹信任确认后带 trust:true 重发；已信任直接装。
 *       { action: "remove", id } · { action: "enable"|"disable", id } · { action: "reload" }
 *       { action: "set-feature", id, featureId, enabled }   ← 功能管理（逐项启停扩展声明的 feature）
 *       { action: "trust"|"untrust", name, url?, source? }  ← 信任管理（增/撤发行者）
 *       { action: "reconcile-deps", source? }               ← 共享依赖手动 reconcile
 *     安装/卸载走本扩展的 installer（文件级，不执行代码）；启停/重载直调进程内 registry。
 *     共享依赖：安装/卸载后自动把全部扩展声明的运行时依赖 reconcile 进
 *     <webRoot>/node_modules（jiti 向上解析自动命中；详见 shared-deps.ts），
 *     deploy.mjs 亦可在拷完文件后 POST 本 op 通知对齐（_shared/reconcile-deps.mjs）。
 *     功能管理：扩展在 entry 声明 features（能力清单，如 aiti-devtools 的 aiti_* 工具），
 *     用户在此逐项启用/禁用——core 在注入 agent 会话工具时自动过滤（无需 reload，即时生效）。
 *   - 已信任发行者：GET /api/extensions/aiti-extman/publishers（管理 UI）
 *
 * UI（client bundle）：
 *   - toolbar 🧩 按钮 → dialogs 管理面板（左列表/右详情 + 添加面板 + 在线注册表）
 *   - 变更后 ctx.reloadExtensions() 刷新宿主 manifest/client bundles（optional 兼容旧宿主）
 *
 * 参照 pi 基础插件安装语义保留来源安装：git:<url>[#branch] / git@… / github 链接 /
 * npm:@scope/pkg[@version] / 本地目录路径。
 *
 * 用法：部署到 ~/.pi/web/extensions/aiti-extman/（tools/deploy.mjs）后 reload。
 */
import { installExtension, removeExtension, installFromZipBuffer, extractZipToTemp, writePublisher, parseInstallSource } from "./installer.js";
import { reconcile, depsState, extDepStates, collectDeps, extensionsRootPath } from "./shared-deps.js";
import {
  resolvePublisherForSource,
  publisherFromZipBuffer,
  publisherFromPackageJson,
  isTrusted,
  addTrusted,
  removeTrusted,
  listTrusted,
  type Publisher,
} from "./publisher.js";
import { rmSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { EXT_PROTOCOL_VERSION, EXT_PROTOCOL_MIN_MAJOR, extProtocolInfo } from "./ext-protocol.mjs";
import { screenAndMigrateOnInstall } from "./protocol-screen.mjs";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

/** 进程内扩展 registry（instrumentation 建立的 globalThis.__piWebExt 单例）。 */
function registry(): any {
  return (globalThis as any).__piWebExt;
}

/** 全量状态：新宿主直接 statusPayload；旧宿主（无该方法）用基础接口拼装降级。 */
function statusPayload(): any {
  const reg = registry();
  if (reg && typeof reg.statusPayload === "function") return reg.statusPayload();
  const exts = reg?.status?.() ?? {};
  for (const id of Object.keys(exts)) exts[id].enabled = reg?.isEnabled?.(id) ?? true;
  return {
    loaded: reg?.isLoaded?.() ?? false,
    extensionsRoot: reg?.extensionsRoot?.() ?? "",
    extraExtensionsRoots: reg?.extraExtensionsRoots?.() ?? [],
    devExtensionsRoot: null,
    bundledExtensionsRoot: reg?.bundledExtensionsRoot?.() ?? "",
    dataRoot: reg?.dataRoot?.() ?? "",
    extensions: exts,
  };
}

/** 给每个本地扩展条目补充发行者信息（读扩展目录 package.json，不执行代码）。 */
function withPublishers(payload: any): any {
  const extensions = payload?.extensions;
  if (!extensions) return payload;
  for (const id of Object.keys(extensions)) {
    const e = extensions[id];
    if (e && typeof e.dir === "string" && e.dir) {
      try {
        e.publisher = publisherFromPackageJson(e.dir);
      } catch {
        e.publisher = undefined;
      }
    }
  }
  return payload;
}

/** 读一个扩展目录的协议声明并计算兼容状态（安装结果 / status 富化共用）。 */
function protocolOfDir(dir: string | undefined, opts?: { current?: string; minMajor?: number }): any {
  let declared: unknown;
  try {
    declared = dir ? JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).aitiExtProtocol : undefined;
  } catch {
    declared = undefined;
  }
  return extProtocolInfo(declared, opts ?? {});
}

/**
 * 给每个扩展条目补充协议声明与兼容状态（docs/pi-web-ext-protocol.md）。
 * 当前版本优先取宿主 P4 下发的 `payload.protocol`（current/minMajor），旧宿主回退本地常量；
 * 声明读部署目录 package.json（不执行代码）；`needsUpgrade` → 前端出 🤖 AI 升级入口。
 */
function withProtocol(payload: any): any {
  const extensions = payload?.extensions;
  if (!extensions) return payload;
  const host = payload?.protocol && typeof payload.protocol === "object" ? payload.protocol : null;
  const opts = {
    current: typeof host?.current === "string" ? host.current : EXT_PROTOCOL_VERSION,
    minMajor: Number.isInteger(host?.minMajor) ? host.minMajor : EXT_PROTOCOL_MIN_MAJOR,
  };
  for (const id of Object.keys(extensions)) {
    const e = extensions[id];
    if (!e || typeof e !== "object") continue;
    e.protocol = { ...protocolOfDir(typeof e.dir === "string" ? e.dir : undefined, opts), source: host ? "host" : "local" };
  }
  return payload;
}

/** 插槽上下文分类：global=不依赖会话上下文可直接触发；context=需在特定上下文操作。 */
const SLOT_CONTEXT: Record<string, { context: "global" | "context"; where: string }> = {
  toolbar: { context: "global", where: "顶部工具条" },
  sidebar: { context: "global", where: "左侧栏" },
  sidebarFooter: { context: "global", where: "侧栏底部" },
  sessionTopbar: { context: "global", where: "顶部工具条" },
  dialogs: { context: "global", where: "弹窗（由扩展自身入口触发）" },
  banners: { context: "global", where: "页面顶部横幅（常驻）" },
  pages: { context: "global", where: "主区域页面面板（常驻）" },
  sessionRowActions: { context: "context", where: "左侧会话列表·会话行操作按钮" },
  chatInputTop: { context: "context", where: "聊天输入框上方" },
};

/** 给扩展条目补充插槽条目详情（label/title/context/位置）——从 entry ui 定义读取。 */
function withSlotDetails(payload: any): any {
  const reg = registry();
  const extensions = payload?.extensions;
  if (!reg || !extensions) return payload;
  // DI 方案 P1：core.registry 服务优先（ui 只读视图），旧 registry.byId 直调兜底（生产旧 core 过渡期）
  const coreReg = reg?.services?.get?.("core.registry") ?? null;
  for (const id of Object.keys(extensions)) {
    const e = extensions[id];
    const ui = coreReg && typeof coreReg.ui === "function" ? coreReg.ui(id)
      : typeof reg.byId === "function" ? reg.byId(id)?.ext?.ui : null;
    if (!e || !ui || typeof ui !== "object") continue;
    const detail: Record<string, Array<{ id: string; label?: string; title?: string; context: string; where: string }>> = {};
    for (const [slot, items] of Object.entries(ui)) {
      if (!Array.isArray(items) || items.length === 0) continue;
      const ctx = SLOT_CONTEXT[slot] ?? { context: "context", where: slot };
      detail[slot] = items
        .filter((it) => it !== null && typeof it === "object" && typeof (it as { id?: unknown }).id === "string")
        .map((it) => {
          const item = it as { id: string; label?: unknown; title?: unknown };
          return {
            id: item.id,
            ...(typeof item.label === "string" && item.label ? { label: item.label } : {}),
            ...(typeof item.title === "string" && item.title ? { title: item.title } : {}),
            context: ctx.context,
            where: ctx.where,
          };
        });
      if (detail[slot].length === 0) delete detail[slot];
    }
    if (Object.keys(detail).length > 0) e.slotsDetail = detail;
  }
  return payload;
}

/**
 * 给禁用扩展条目补依赖声明边：pi-web core 对禁用扩展不加载（status 条目无 ui/声明信息），
 * 但「被依赖」反向视图需要禁用依赖者声明的边（如 demo-lazy→demo）。从 index.ts 源码
 * 尽力提取五个声明（clientDependsOn + 依赖与能力模型四字段；单行数组；行首锚定避开注释）；
 * 失败静默（informational 字段，不阻塞）。
 */
function withDisabledDeps(payload: any): any {
  const extensions = payload?.extensions;
  if (!extensions || typeof extensions !== "object") return payload;
  const FIELDS = ["clientDependsOn", "dependsOn", "optionalDependsOn", "provides", "takeover"] as const;
  for (const id of Object.keys(extensions)) {
    const e = extensions[id];
    if (!e || e.loaded !== false || typeof e.dir !== "string") continue;
    try {
      const src = readFileSync(resolve(e.dir, "index.ts"), "utf8");
      for (const field of FIELDS) {
        if (e[field]) continue;
        const m = src.match(new RegExp("^\\s*" + field + "\\s*:\\s*\\[([^\\]]*)\\]", "m"));
        if (!m) continue;
        const ids = [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]).filter((s: string) => s.length > 0);
        if (ids.length > 0) e[field] = ids;
      }
    } catch {}
  }
  return payload;
}
/**
 * 扩展 markdown 描述（DESC.md 约定）：给每个本地条目附 descriptionMd——
 * 优先读扩展目录 DESC.md，回落 package.json 的 descriptionMd 字段。
 * 仅静态读文件不执行代码；超 48KB 截断（防超大文件拖垮 status 响应）。
 * 客户端渲染时支持约定变量（{{aiti-url}}/{{ext-id}}/…，见 client/src/md-desc.tsx）。
 */
const DESC_MD_MAX = 48 * 1024;
function readDescMd(dir?: string): string | undefined {
  if (!dir) return undefined;
  try {
    const p = resolve(dir, "DESC.md");
    if (existsSync(p)) {
      const s = readFileSync(p, "utf8");
      if (s.trim()) return s.length > DESC_MD_MAX ? s.slice(0, DESC_MD_MAX) + "\n\n<!-- (DESC.md 超 48KB 已截断) -->" : s;
    }
  } catch {}
  try {
    const parsed = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as { descriptionMd?: unknown };
    if (typeof parsed.descriptionMd === "string" && parsed.descriptionMd.trim()) {
      const s = parsed.descriptionMd;
      return s.length > DESC_MD_MAX ? s.slice(0, DESC_MD_MAX) + "\n\n<!-- (descriptionMd 超 48KB 已截断) -->" : s;
    }
  } catch {}
  return undefined;
}
function withDescription(payload: any): any {
  const extensions = payload?.extensions;
  if (!extensions || typeof extensions !== "object") return payload;
  for (const id of Object.keys(extensions)) {
    const e = extensions[id];
    if (e && typeof e.dir === "string" && e.dir) e.descriptionMd = readDescMd(e.dir);
  }
  return payload;
}

/** 共享依赖视图：payload.sharedDeps（根/并集/上次 reconcile 结果）+ 用户根扩展逐依赖标注 local/shared/missing。 */
function withSharedDeps(payload: any): any {
  try {
    payload.sharedDeps = depsState();
    const root = extensionsRootPath();
    const { byExt } = collectDeps(root);
    const extensions = payload?.extensions;
    if (extensions && typeof extensions === "object") {
      for (const id of Object.keys(extensions)) {
        const e = extensions[id];
        const mine = byExt[id];
        if (!e || typeof e.dir !== "string" || !mine) continue;
        e.npmDepStates = extDepStates(e.dir, Object.keys(mine));
      }
    }
  } catch {} // 纯信息增强，任何异常不阻塞 status
  return payload;
}

/** 全量状态（含发行者 + 协议 + 插槽条目详情 + markdown 描述 + 共享依赖视图）。 */
function enrichedStatus(): any {
  return withProtocol(withSharedDeps(withDescription(withDisabledDeps(withPublishers(withSlotDetails(statusPayload()))))));
}

/** 检查发行者是否需 trust（VSCode 式）：未信任 → 返回 needsTrust 响应，不安装。 */
function needsTrustResponse(publisher: Publisher, extra: Record<string, unknown> = {}) {
  return json({
    ok: false,
    needsTrust: true,
    trusted: false,
    publisher,
    ...extra,
  });
}

/** 规范化前端回传的发行者（校验字段；无效返回 null 让服务端重新解析）。 */
function normalizePublisher(p: unknown): Publisher | null {
  if (!p || typeof p !== "object") return null;
  const o = p as { name?: unknown; url?: unknown; source?: unknown; fingerprint?: unknown };
  if (typeof o.fingerprint !== "string" || !o.fingerprint.trim()) return null;
  return {
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : null,
    url: typeof o.url === "string" && o.url.trim() ? o.url.trim() : undefined,
    source: typeof o.source === "string" && o.source.trim() ? o.source.trim() : "unknown",
    fingerprint: o.fingerprint.trim(),
  };
}

// ── 在线注册表代理（aiti-docs 编译产物；浏览器直连跨域，这里代取 + 短缓存） ──
const DEFAULT_REGISTRY_URL = "https://aiti.pw/extensions.json";
const REGISTRY_TTL_MS = 5 * 60_000;
let registryCache: { at: number; body: string } | null = null;

async function fetchRegistry(): Promise<Response> {
  if (registryCache && Date.now() - registryCache.at < REGISTRY_TTL_MS) {
    return new Response(registryCache.body, { headers: { "content-type": "application/json; charset=utf-8" } });
  }
  const res = await fetch(process.env.PI_WEB_EXT_REGISTRY_URL || DEFAULT_REGISTRY_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
  const body = await res.text();
  JSON.parse(body); // validate before caching / returning
  registryCache = { at: Date.now(), body };
  return new Response(body, { headers: { "content-type": "application/json; charset=utf-8" } });
}

export default {
  id: "aiti-extman",
  name: "aiti 扩展管理器",
  version: "0.1.0",
  icon: "icon.svg",
  client: "dist/aiti-extman-client.mjs",

  // AI 自管理清单：AI 能帮我推荐/体检/安装/启停扩展，乃至直接新建、修改、发布扩展
  ai: {
    manage: true,
    intro: "AI 能帮我推荐/体检/安装/启停扩展，乃至直接新建、修改、发布扩展",
    skills: "skills",
  },

  ui: {
    // [懒加载 v2] 纯面板扩展：开页不拉 client bundle（126KB）。sidebarFooter 静态入口由
    // 宿主声明式渲染（pi-web components/AppShell.tsx sidebarFooterStaticItems），点击经
    // meta.onClick → openExtmanPanel 物化并打开。
    // ⚠ 依赖宿主改动同步到 prod（未同步时 prod 会缺「扩展」入口）。
    clientImmediately: false,
    // 侧栏底部快捷操作行（与 模型/技能/插件 同一排）——扩展管理的原始入口位置。
    sidebarFooter: [{ id: "aiti-extman-open", label: "扩展", title: "aiti-extman：扩展管理（启停/安装/在线注册表）", icon: "icons/wrench.svg" }],
    dialogs: [{ id: "aiti-extman-panel", label: "aiti-extman 扩展管理面板" }],
    i18n: {
      en: {
        "ext.title": "Extensions",
        "ext.shortLabel": "Extensions",
        "ext.reload": "Reload all",
        "ext.refresh": "Refresh",
        "ext.close": "Close",
        "ext.prevExt": "Previous extension",
        "ext.nextExt": "Next extension",
        "ext.list": "Extensions",
        "ext.expand": "Expand",
        "ext.collapse": "Collapse",
        "ext.expandList": "Expand extension list",
        "ext.collapseList": "Collapse extension list",
        "ext.maximize": "Expand to full screen",
        "ext.restore": "Restore window",
        "ext.none": "No extensions",
        "ext.enable": "Enable",
        "ext.disable": "Disable",
        "ext.disabled": "disabled",
        "ext.clientLoaded": "client loaded",
        "ext.prefetched": "prefetched",
        "ext.notLoaded": "not loaded",
        "ext.noClient": "no client",
        "ext.add": "Add extension",
        "ext.searchHint": "Search installed & online…",
        "ext.clearSearch": "Clear",
        "ext.onlineResults": "Online",
        "ext.installFromSource": "Install from source",
        "ext.type": "Type",
        "ext.category": "Category",
        "ext.author": "Author",
        "ext.license": "License",
        "ext.select": "Select an extension",
        "ext.summary": "{total} extensions · {on} on · {off} off",
        "ext.status": "Status",
        "ext.name": "Name",
        "ext.version": "Version",
        "ext.protocol": "Protocol",
        "ext.protocolCurrent": "current",
        "ext.protocolOk": "compatible",
        "ext.protocolStale": "needs upgrade",
        "ext.protocolIncompatible": "incompatible",
        "ext.protocolTooNew": "too new (upgrade host)",
        "ext.protocolMissing": "not declared",
        "ext.protocolInvalid": "invalid",
        "ext.protocolUpgradeAi": "AI upgrade",
        "ext.protocolUpgradeTitle": "Upgrade {id} protocol {from} → {to} via AI",
        "ext.protocolMinorAhead": "host can upgrade",
        "ext.protocolInstallWarn": "installed; protocol {declared} → {current} ({state}) — open detail to AI-upgrade",
        "ext.protocolInstallTooNew": "installed; extension protocol {declared} is newer than host {current} — please upgrade pi-web",
        "ext.slots": "Insertion points",
        "ext.slotSummary": "{slots} slots · {items} items",
        "ext.noSlots": "No UI slots",
        "ext.slotsOpenHint": "click an item to open it",
        "ext.open": "Open",
        "ext.global": "Global",
        "ext.context": "Context",
        "ext.where": "Where",
        "ext.slotContextHint": "Used in {where}",
        "ext.slotOpened": "Opened: {label}",
        "ext.raiseToTop": "Raise to top",
        "ext.slotLocated": "Located at {where}",
        "ext.slotNeedSession": "Needs a session ({where})",
        "ext.slotNoDirect": "No direct trigger ({where}); open it manually there",
        "ext.clientBundle": "Client bundle",
        "ext.clientState": "Client state",
        "ext.dir": "Directory",
        "ext.configDir": "Config dir",
        "ext.sourceUrl": "Source",
        "ext.deps": "Dependencies",
        "ext.clientDeps": "client inject",
        "ext.depsBy": "depended on by",
        "ext.depsByHint": "Extensions whose client bundle declares a dependency on this one (informational: affects client prefetch scheduling, not load correctness). Click to open.",
        "ext.dependentsTitle": "Dependency impact",
        "ext.dependentsBodyDisable": "The following enabled extensions declare a client-inject dependency on {id}. Disabling it may affect their client prefetch and cooperation:",
        "ext.dependentsBodyRemove": "Uninstalling deletes the extension code directory (data directory is kept). The following enabled extensions declare a client-inject dependency on {id} and may be affected:",
        "ext.dependentsConfirmDisable": "Disable anyway",
        "ext.dependentsHardBlocked": "Hard dependency — cannot be disabled while the extensions above are enabled. Disable them first (they declare a hard dependsOn).",
        "ext.dependentsConfirmRemove": "Uninstall anyway",
        "ext.pkgDeps": "npm deps",
        "ext.noDeps": "none",
        "ext.depShared": "shared root",
        "ext.depLocal": "local node_modules",
        "ext.sharedDepsRoot": "Shared deps root",
        "ext.serverCaps": "Server capabilities",
        "ext.provides": "Takes over",
        "ext.services": "Services",
        "ext.features": "Feature management",
        "ext.featuresHint": "Toggle which features of this extension are available. Disabled agent tools are not injected into new sessions; toggling off during a session refuses calls on already-injected tools immediately.",
        "ext.featuresOn": "{on} on",
        "ext.featuresOff": "{off} off",
        "ext.featuresNone": "No manageable features declared",
        "ext.msgFeatureSet": "Feature setting updated.",
        "ext.selfProtected": "manager itself — cannot be disabled/removed",
        "ext.registry": "Online registry",
        "ext.registryHint": "browse & install from aiti.pw",
        "ext.registryEmpty": "Registry is empty",
        "ext.registryFailed": "Failed to load registry",
        "ext.installed": "installed",
        "ext.updateTo": "update to v{version}",
        "ext.noSource": "no online source",
        "ext.detail": "Details",
        "ext.docs": "Docs",
        "ext.update": "Update",
        "ext.install": "Install",
        "ext.installing": "Installing…",
        "ext.remove": "Remove",
        "ext.publisher": "Publisher",
        "ext.publisherUnknown": "Unknown publisher",
        "ext.trusted": "Trusted",
        "ext.notTrusted": "Not trusted",
        "ext.trustPublisher": "Trust Publisher",
        "ext.untrustPublisher": "Revoke trust",
        "ext.trustDialogTitle": "Trust publisher",
        "ext.trustDialogBody": "This extension is published by a publisher you haven't trusted yet. Only install if you trust this publisher.",
        "ext.trustAndInstall": "Trust Publisher & Install",
        "ext.cancel": "Cancel",
        "ext.copy": "Copy",
        "ext.copied": "Copied",
        "ext.trustedPublishers": "Trusted publishers",
        "ext.trustedEmpty": "No trusted publishers yet",
        "ext.fingerprint": "fingerprint",
        "ext.msgTrusted": "Publisher trusted.",
        "ext.msgUntrusted": "Trust revoked.",
        "ext.fromSource": "Install from source",
        "ext.uploadZip": "Upload zip",
        "ext.chooseZip": "Choose zip…",
        "ext.zipHint": "Pack the extension directory as .zip (entry index.ts at root or one level down; node_modules excluded)",
        "ext.installTo": "Install to",
        "ext.removeConfirm": "Removing deletes the extension code directory (data is kept). Continue?",
        "ext.msgEnabled": "Extension enabled.",
        "ext.msgDisabled": "Extension disabled.",
        "ext.applying": "Applying changes… reloading extensions",
        "ext.msgInstalled": "Extension installed.",
        "ext.msgRemoved": "Extension removed.",
        "ext.msgReloaded": "Extensions reloaded.",
        "ext.back": "Back",
        "ext.view.exts": "Extensions",
        "ext.view.caps": "Capabilities",
        "ext.view.conflicts": "Conflicts",
        "ext.deps.hard": "Dependencies (hard)",
        "ext.deps.optional": "Optional dependencies",
        "ext.capProvide": "Provides (capabilities)",
        "ext.takeoverCaps": "Exclusive takeover",
        "ext.depMissing": "unmet",
        "ext.depInactive": "inactive",
        "ext.depViaPin": "pinned",
        "ext.takeoverEffective": "effective",
        "ext.takeoverShadowed": "superseded",
        "ext.cap.title": "Capability",
        "ext.cap.providers": "Providers",
        "ext.cap.effective": "effective",
        "ext.cap.consumers": "Consumers",
        "ext.cap.none": "No capability declarations or references",
        "ext.cap.pick": "Effective provider",
        "ext.conflict.multiSource": "Same id · multiple sources",
        "ext.conflict.takeover": "Takeover conflicts",
        "ext.conflict.none": "No multi-source or takeover conflicts",
        "ext.conflict.winner": "active",
        "ext.conflict.shadowed": "shadowed",
        "ext.conflict.pick": "Source",
        "ext.pin.auto": "Auto",
        "ext.msgPinned": "Pin updated.",
        "ext.devPriority": "Dev-priority",
        "ext.devPriorityHint": "dev-root candidate wins over version arbitration (for development)",
        "ext.dependentsHardDisable": "The following enabled extensions hard-depend on {id} (directly or via a capability it effectively provides). Disabling it leaves their dependency unmet:",
        "ext.dependentsHardRemove": "Uninstalling deletes the extension code directory (data is kept). The following enabled extensions hard-depend on {id} (directly or via a capability it provides):",
      },
      "zh-CN": {
        "ext.title": "扩展管理",
        "ext.shortLabel": "扩展",
        "ext.reload": "全部重载",
        "ext.refresh": "刷新",
        "ext.close": "关闭",
        "ext.prevExt": "上一个扩展",
        "ext.nextExt": "下一个扩展",
        "ext.list": "扩展列表",
        "ext.expand": "展开",
        "ext.collapse": "收起",
        "ext.expandList": "展开扩展列表",
        "ext.collapseList": "收起扩展列表",
        "ext.maximize": "全屏展开",
        "ext.restore": "还原窗口",
        "ext.none": "暂无扩展",
        "ext.enable": "启用",
        "ext.disable": "禁用",
        "ext.disabled": "已禁用",
        "ext.clientLoaded": "client 已加载",
        "ext.prefetched": "已预取（未注册）",
        "ext.notLoaded": "未加载",
        "ext.noClient": "无 client",
        "ext.add": "添加扩展",
        "ext.searchHint": "搜索已安装与在线扩展…",
        "ext.clearSearch": "清空",
        "ext.onlineResults": "在线",
        "ext.installFromSource": "从来源安装",
        "ext.type": "类型",
        "ext.category": "分类",
        "ext.author": "作者",
        "ext.license": "许可",
        "ext.select": "选择左侧扩展查看详情",
        "ext.summary": "{total} 个扩展 · {on} 启用 · {off} 禁用",
        "ext.status": "状态",
        "ext.name": "名称",
        "ext.version": "版本",
        "ext.protocol": "协议",
        "ext.protocolCurrent": "当前",
        "ext.protocolOk": "兼容",
        "ext.protocolStale": "待升级",
        "ext.protocolIncompatible": "不兼容",
        "ext.protocolTooNew": "过新（需升级宿主）",
        "ext.protocolMissing": "未声明",
        "ext.protocolInvalid": "非法",
        "ext.protocolUpgradeAi": "AI 升级",
        "ext.protocolUpgradeTitle": "用 AI 把 {id} 的协议从 {from} 升级到 {to}",
        "ext.protocolMinorAhead": "宿主可升级",
        "ext.protocolInstallWarn": "安装完成；协议 {declared} → 当前 {current}（{state}）——详情页可 🤖 AI 升级",
        "ext.protocolInstallTooNew": "安装完成；扩展协议 {declared} 高于宿主 {current}——请升级 pi-web",
        "ext.slots": "插入点",
        "ext.slotSummary": "{slots} 个插槽 · {items} 项",
        "ext.noSlots": "未声明 UI 插入点",
        "ext.slotsOpenHint": "点击条目可直接打开",
        "ext.open": "打开",
        "ext.global": "全局",
        "ext.context": "需上下文",
        "ext.where": "在哪操作",
        "ext.slotContextHint": "该功能在「{where}」中操作",
        "ext.slotOpened": "已打开：{label}",
        "ext.raiseToTop": "置于顶层",
        "ext.slotLocated": "已定位到「{where}」",
        "ext.slotNeedSession": "该功能需在会话中操作（{where}）",
        "ext.slotNoDirect": "无独立触发入口（{where}），请在对应位置手动操作",
        "ext.clientBundle": "client 包",
        "ext.clientState": "client 状态",
        "ext.dir": "目录",
        "ext.configDir": "配置目录",
        "ext.sourceUrl": "来源地址",
        "ext.deps": "依赖",
        "ext.clientDeps": "client 注入依赖",
        "ext.depsBy": "被依赖",
        "ext.depsByHint": "以下扩展在其 client bundle 里声明依赖本扩展（informational：影响 client 预取调度，不参与加载正确性）。点击可跳转。",
        "ext.dependentsTitle": "依赖影响提示",
        "ext.dependentsBodyDisable": "以下已启用扩展声明 client 注入依赖 {id}。禁用后它们的 client 预取与协作功能可能受影响：",
        "ext.dependentsBodyRemove": "卸载将删除扩展代码目录（数据目录保留）。以下已启用扩展声明 client 注入依赖 {id}，可能受影响：",
        "ext.dependentsConfirmDisable": "仍要禁用",
        "ext.dependentsHardBlocked": "存在硬依赖——上方启用中的扩展 dependsOn 本扩展，不能单独禁用；请先禁用它们（或改声明为 optionalDependsOn）。",
        "ext.dependentsConfirmRemove": "仍要卸载",
        "ext.pkgDeps": "npm 依赖",
        "ext.noDeps": "无",
        "ext.depShared": "共享根",
        "ext.depLocal": "扩展本地",
        "ext.sharedDepsRoot": "共享依赖根",
        "ext.serverCaps": "服务端能力",
        "ext.provides": "接管能力",
        "ext.services": "服务出口",
        "ext.features": "功能管理",
        "ext.featuresHint": "逐项开关本扩展开放的功能：禁用的 agent 工具在新会话中不再注入；会话运行中关闭，已注入工具的调用会立即被拒绝。",
        "ext.featuresOn": "启用 {on}",
        "ext.featuresOff": "禁用 {off}",
        "ext.featuresNone": "未声明可管理功能",
        "ext.msgFeatureSet": "功能设置已更新。",
        "ext.selfProtected": "管理器自身，不可禁用/卸载",
        "ext.registry": "在线扩展注册表",
        "ext.registryHint": "从 aiti.pw 在线浏览并安装",
        "ext.registryEmpty": "注册表为空",
        "ext.registryFailed": "注册表获取失败",
        "ext.installed": "已安装",
        "ext.updateTo": "可更新到 v{version}",
        "ext.noSource": "暂无在线安装源",
        "ext.detail": "详情",
        "ext.docs": "文档",
        "ext.update": "更新",
        "ext.install": "安装",
        "ext.installing": "安装中…",
        "ext.remove": "移除",
        "ext.publisher": "发行者",
        "ext.publisherUnknown": "未知发行者",
        "ext.trusted": "已信任",
        "ext.notTrusted": "未信任",
        "ext.trustPublisher": "信任此发行者",
        "ext.untrustPublisher": "撤销信任",
        "ext.trustDialogTitle": "信任发行者",
        "ext.trustDialogBody": "此扩展的发行者尚未被信任。仅在你信任该发行者时继续安装。",
        "ext.trustAndInstall": "信任并安装",
        "ext.cancel": "取消",
        "ext.copy": "复制",
        "ext.copied": "已复制",
        "ext.trustedPublishers": "已信任发行者",
        "ext.trustedEmpty": "暂无已信任的发行者",
        "ext.fingerprint": "指纹",
        "ext.msgTrusted": "发行者已信任。",
        "ext.msgUntrusted": "已撤销信任。",
        "ext.fromSource": "从来源安装",
        "ext.uploadZip": "上传 zip 安装",
        "ext.chooseZip": "选择 zip…",
        "ext.zipHint": "把扩展目录打包成 .zip（入口 index.ts 在根或单层子目录；node_modules 自动剔除）",
        "ext.installTo": "安装位置",
        "ext.removeConfirm": "卸载将删除扩展代码目录（数据目录保留），确定继续？",
        "ext.msgEnabled": "扩展已启用。",
        "ext.msgDisabled": "扩展已禁用。",
        "ext.applying": "正在应用变更…（重载扩展中）",
        "ext.msgInstalled": "扩展已安装。",
        "ext.msgRemoved": "扩展已卸载。",
        "ext.msgReloaded": "扩展已重载。",
        "ext.back": "返回",
        "ext.view.exts": "扩展",
        "ext.view.caps": "能力",
        "ext.view.conflicts": "冲突",
        "ext.deps.hard": "依赖（硬）",
        "ext.deps.optional": "可选依赖",
        "ext.capProvide": "能力提供",
        "ext.takeoverCaps": "独占接管",
        "ext.depMissing": "未满足",
        "ext.depInactive": "未生效",
        "ext.depViaPin": "已 pin",
        "ext.takeoverEffective": "生效中",
        "ext.takeoverShadowed": "被取代",
        "ext.cap.title": "能力",
        "ext.cap.providers": "提供者",
        "ext.cap.effective": "生效",
        "ext.cap.consumers": "消费方",
        "ext.cap.none": "暂无能力声明或引用",
        "ext.cap.pick": "生效提供者",
        "ext.conflict.multiSource": "同 id 多来源",
        "ext.conflict.takeover": "接管冲突",
        "ext.conflict.none": "暂无多来源/接管冲突",
        "ext.conflict.winner": "生效",
        "ext.conflict.shadowed": "被遮蔽",
        "ext.conflict.pick": "来源",
        "ext.pin.auto": "自动",
        "ext.msgPinned": "pin 已更新。",
        "ext.devPriority": "dev 调试优先",
        "ext.devPriorityHint": "开启后 dev 根扩展在同 id 裁决中优先于版本（开发调试用）",
        "ext.dependentsHardDisable": "以下已启用扩展硬依赖 {id}（直接依赖，或依赖它生效提供的能力）。禁用后其依赖声明将未满足：",
        "ext.dependentsHardRemove": "卸载将删除扩展代码目录（数据目录保留）。以下已启用扩展硬依赖 {id}（直接依赖，或经能力解析依赖它）：",
      },
    },
  },

  server: {
    startup(ctx) {
      // 帮助点已声明在 ai.helpers，由 ai-helper 主动聚合，无需在此注册
    },
    async api(req, ctx) {
      const [route] = ctx.path;

      // GET status — 全量状态（含禁用/失败条目、插入点/钩子/依赖细节 + 发行者信息）。
      if (route === "status" && ctx.method === "GET") return json(enrichedStatus());

      // GET publishers — 已信任发行者列表（管理 UI）。
      if (route === "publishers" && ctx.method === "GET") return json({ trusted: listTrusted() });

      // GET registry — aiti.pw/extensions.json 代理（短缓存）。
      if (route === "registry" && ctx.method === "GET") {
        try {
          return await fetchRegistry();
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 502);
        }
      }

      // POST install-zip — multipart 文件上传安装（file=<zip>，可选 id / docsUrl / trust / publisherHint）。
      if (route === "install-zip" && ctx.method === "POST") {
        const form = await req.formData().catch(() => null);
        const file = form?.get("file");
        if (!form || !(file instanceof File)) return json({ error: "multipart file required" }, 400);
        if (file.size > 64 * 1024 * 1024) return json({ error: "zip 过大（>64MB）" }, 413);
        const buf = Buffer.from(await file.arrayBuffer());
        const id = typeof form.get("id") === "string" ? String(form.get("id")) : undefined;
        const docsUrl = typeof form.get("docsUrl") === "string" ? String(form.get("docsUrl")) : undefined;
        const trust = form.get("trust") === "1" || form.get("trust") === "true";
        const reg = registry();
        if (!reg) return json({ error: "extension registry unavailable" }, 500);

        // 发行者预检（解包读 package.json）：未信任 → needsTrust，不安装。
        let publisher: Publisher | null = null;
        let tmp: string | null = null;
        try {
          tmp = await extractZipToTemp(buf);
          publisher = publisherFromZipBuffer(buf, tmp);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        } finally {
          if (tmp) {
            try {
              rmSync(tmp, { recursive: true, force: true });
            } catch {}
          }
        }
        if (!trust && !isTrusted(publisher)) {
          return needsTrustResponse(publisher, { zipName: file.name });
        }
        if (trust) addTrusted(publisher);

        try {
          const result = await installFromZipBuffer(buf, id, docsUrl);
          try {
            writePublisher(result.dir, publisher);
          } catch {}
          // 共享依赖 reconcile（非致命）：zip 来源声明的运行时依赖同样进共享根
          const deps = await reconcile(`install-zip:${result.id}`);
          await reg.reload();
          // 协议检查 + 安装时筛查占位（方案 §7；当前 skipped，不影响行为）
          const protocolCheck = protocolOfDir(result.dir);
          const screening = await screenAndMigrateOnInstall({ id: result.id, dir: result.dir, kind: "zip", fromProtocol: protocolCheck.declared, toProtocol: protocolCheck.current });
          return json({ ok: true, id: result.id, deps, protocolCheck, screening, ...enrichedStatus() });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }

      // POST ops — install / remove / enable / disable / reload / set-feature。
      if (route === "ops" && ctx.method === "POST") {
        let body: {
          action?: string;
          source?: string;
          id?: string;
          docsUrl?: string;
          featureId?: string;
          enabled?: boolean;
          value?: boolean | string;
          /** set-pin：capability | source */
          scope?: string;
          /** set-pin：能力名或扩展 id */
          key?: string;
          /** set-dev-priority：开关值 */
          trust?: boolean;
          publisherHint?: string;
          fingerprint?: string;
          publisher?: {
            name?: string;
            url?: string;
            source?: string;
            fingerprint: string;
          };
          name?: string;
          url?: string;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return json({ error: "invalid json" }, 400);
        }
        // 自我保护：管理器不允许禁用/卸载自己（否则失去管理入口，只能手改文件恢复）。
        if ((body.action === "disable" || body.action === "remove") && body.id === ctx.id) {
          return json({ error: "扩展管理器不允许禁用/卸载自己（否则将失去扩展管理入口）" }, 400);
        }
        const reg = registry();
        if (!reg) return json({ error: "extension registry unavailable" }, 500);

        try {
          // 信任管理：trust=把发行者加入可信名单；untrust=撤销。
          if (body.action === "trust" || body.action === "untrust") {
            const name = body.name?.trim();
            const fingerprint = body.fingerprint?.trim();
            const key = name || fingerprint;
            if (!key) return json({ error: "name or fingerprint required" }, 400);
            if (body.action === "trust") {
              addTrusted({ name: name || null, url: body.url, source: body.source || "manual", fingerprint: key });
            } else {
              removeTrusted(key);
            }
            return json({ ok: true, trusted: listTrusted() });
          }

          if (body.action === "install") {
            if (!body.source?.trim()) return json({ error: "source required" }, 400);
            const plan = parseInstallSource(body.source);
            if (!plan) return json({ error: `无法识别的扩展来源：${body.source}` }, 400);
            // VSCode 式 trust：先解析发行者（npm registry / github owner / package.json）。
            // 前端信任确认后会把解析出的 publisher 回传（保证信任键与展示一致），否则服务端解析。
            const publisher =
              (body.publisher && normalizePublisher(body.publisher)) ||
              (await resolvePublisherForSource(plan.kind, plan.ref, body.publisherHint));
            if (body.trust !== true && !isTrusted(publisher)) {
              return needsTrustResponse(publisher, {
                source: body.source,
                docsUrl: body.docsUrl,
                id: body.id?.trim() || plan.id,
              });
            }
            if (body.trust === true) addTrusted(publisher);
            const result = await installExtension(body.source, body.id, body.docsUrl);
            try {
              writePublisher(result.dir, publisher);
            } catch {}
            // 共享依赖 reconcile（非致命：失败只随响应告警，安装不回滚）；先对齐依赖再 reload 装载
            const deps = await reconcile(`install:${result.id}`);
            await reg.reload();
            // 协议检查 + 安装时筛查占位（方案 §7；当前 skipped，不影响行为）
            const protocolCheck = protocolOfDir(result.dir);
            const screening = await screenAndMigrateOnInstall({ id: result.id, dir: result.dir, kind: plan.kind, fromProtocol: protocolCheck.declared, toProtocol: protocolCheck.current });
            return json({ ok: true, id: result.id, deps, protocolCheck, screening, ...enrichedStatus() });
          }
          if (body.action === "remove") {
            if (!body.id?.trim()) return json({ error: "id required" }, 400);
            removeExtension(body.id);
            // pin 清理（P2）：卸载后 source/capability pin 失效——core 提供方法时顺手清（旧 core 无此方法则跳过，解析时软校验兜底）
            try { reg.clearExtPins?.(body.id); } catch {}
            // 依赖并集已变小 → reconcile 让 npm 裁剪共享根里不再被任何扩展引用的包（非致命）
            const deps = await reconcile(`remove:${body.id}`);
            await reg.reload();
            return json({ ok: true, id: body.id, deps, ...enrichedStatus() });
          }
          if (body.action === "enable" || body.action === "disable") {
            if (!body.id?.trim()) return json({ error: "id required" }, 400);
            reg.setEnabled(body.id, body.action === "enable");
            await reg.reload();
            return json({ ok: true, id: body.id, enabled: reg.isEnabled(body.id), ...enrichedStatus() });
          }
          if (body.action === "reload") {
            await reg.reload();
            return json({ ok: true, ...enrichedStatus() });
          }
          // 依赖与能力模型 P2：pin（能力生效提供者 / 同 id 多来源）与 dev 调试优先开关。
          // 变更后 reload 让裁决生效（与 enable/disable 同模式）。
          if (body.action === "set-pin") {
            const scope = body.scope;
            const key = body.key?.trim();
            if ((scope !== "capability" && scope !== "source") || !key) return json({ error: "scope (capability|source) and key required" }, 400);
            if (typeof reg.setPin !== "function") return json({ error: "宿主 core 不支持 pin（需升级 pi-web）" }, 501);
            const value = typeof body.value === "string" && body.value.trim() ? body.value.trim() : null;
            reg.setPin(scope + ":" + key, value);
            await reg.reload();
            return json({ ok: true, scope, key, value, ...enrichedStatus() });
          }
          if (body.action === "set-dev-priority") {
            if (typeof reg.setDevPriority !== "function") return json({ error: "宿主 core 不支持 dev 优先开关（需升级 pi-web）" }, 501);
            reg.setDevPriority(body.value === true);
            await reg.reload();
            return json({ ok: true, devPriority: body.value === true, ...enrichedStatus() });
          }
          // 功能管理：逐项启停/设置扩展声明的 feature（core 持久化 + 注入过滤，无需 reload）。
          if (body.action === "set-feature") {
            if (!body.id?.trim() || !body.featureId?.trim()) return json({ error: "id and featureId required" }, 400);
            const status = enrichedStatus();
            const entry = status.extensions[body.id];
            const feature = entry?.features?.find((f: { id: string; type?: string }) => f.id === body.featureId);
            if (!entry || entry.loaded !== true || !feature) {
              return json({ error: `扩展 ${body.id} 未加载或未声明功能 ${body.featureId}` }, 400);
            }
            // string/textlist feature → 写值（value 缺省为空串）；boolean feature → 启停（enabled 缺省 true）
            let value: boolean | string;
            if (feature.type === "string" || feature.type === "textlist") {
              value = (body.value !== undefined && typeof body.value !== "boolean") ? String(body.value) : String(body.value ?? "");
              reg.setFeatureValue(body.id, body.featureId, value);
            } else {
              value = body.enabled !== false;
              reg.setFeatureFlag(body.id, body.featureId, value);
            }
            const fresh = enrichedStatus();
            const fe = fresh.extensions[body.id]?.features?.find((f: any) => f.id === body.featureId);
            return json({ ok: true, id: body.id, featureId: body.featureId, enabled: fe ? fe.enabled !== false : true, value: fe && typeof fe.value === "string" ? fe.value : undefined, ...fresh });
          }
          // 共享依赖手动 reconcile（deploy.mjs 通知 / AI / UI 触发；install/remove 已自动触发）
          if (body.action === "reconcile-deps") {
            const deps = await reconcile(body.source?.trim() || "manual");
            return json({ ok: deps.ok, deps, ...enrichedStatus() });
          }
          return json({ error: "unknown action (install|remove|enable|disable|reload|set-feature|set-pin|set-dev-priority|reconcile-deps|trust|untrust)" }, 400);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }

      return null; // 404
    },
  },
};
