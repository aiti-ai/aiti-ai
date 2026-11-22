/**
 * aiti-editor · 多编辑器仲裁（纯函数，零 window/ctx 依赖——node --test 可直测）。
 *
 * 模型（VSCode "Open With..." 语义 + 能力感知，docs/aiti-editor-office-plan.md §1.2）：
 *   命中队列 resolveProviders(filePath) = 所有 selector 命中该文件的 providers
 *   （preview-only / edit-only 均收——能力分离注册，provider 可只声明其一）。
 *   排序：① 用户默认偏好（per 扩展名，服务端持久化）→ ② priority（override 3 >
 *   preferred 2 > default 1）→ ③ 注册顺序（JS sort 稳定，天然保持）。
 *   能力联动：当前 provider 无目标能力 → 队列中（排序后）第一个具备该能力的 provider；
 *   全队列无 → null（上层禁用按钮 / 提示「未安装可编辑 xx 的扩展」）。
 *   fail-soft：偏好指向的 provider 已停用（不在 matched 里）→ 自然落到排序下一位，
 *   偏好保留（扩展重新启用即恢复）；全停用 → 空队列 → 回退核心查看器。
 */

export type EditorCapability = "preview" | "edit";

/** 编辑器「关于」元数据（菜单「关于编辑器」展示：名称/能力/限制/依赖/许可）。 */
export interface EditorAbout {
  /** 一句话说明 */
  summary?: string;
  /** 能力清单（每条一行） */
  capabilities?: string[];
  /** 限制清单（每条一行） */
  limits?: string[];
  /** 实现依赖（如 "exceljs 4.4 + Univer 0.25"） */
  vendor?: string;
  license?: string;
}

/** provider 注册项的最小形状（registry 里的实际注册项是它的超集）。 */
export interface ProviderLike {
  id: string;
  displayName?: string;
  selector?: any;
  priority?: string;
  supportsEdit?: boolean;
  capabilities?: EditorCapability[];
  defaultCapability?: EditorCapability;
  /** 第三方视图挂载点（存在即「渲染型 provider」，可接管非文本文件） */
  render?: unknown;
  /** 来源扩展 id（「打开方式」菜单展示用，可选） */
  sourceExt?: string;
  /** 「关于编辑器」元数据（可选；未提供则菜单只显示 id 与能力标注） */
  about?: EditorAbout;
}

/**
 * md 围栏渲染器注册项最小形状（docs/aiti-editor-md-plugins-plan.md §3.1；
 * registry 的实际注册项是它的超集——多 css/render/exportInline）。
 */
export interface MdRendererLike extends ProviderLike {
  /** 接管的围栏语言（```<lang>）；只允许 [\w-]（要进 CSS class 与正则） */
  lang: string;
}

const PRIORITY_WEIGHT: Record<string, number> = { override: 3, preferred: 2, default: 1 };

/** 文件扩展名（含点、小写，如 ".docx"；无扩展名 → ""）。 */
export function extOf(filePath: string): string {
  const base = String(filePath).split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
}

/** capabilities 规整：显式声明优先；缺省按 supportsEdit 推导（向后兼容旧注册）。 */
export function normalizeCapabilities(reg: ProviderLike): EditorCapability[] {
  if (Array.isArray(reg.capabilities) && reg.capabilities.length > 0) {
    return reg.capabilities.filter((c) => c === "preview" || c === "edit");
  }
  return reg.supportsEdit === false ? ["preview"] : ["preview", "edit"];
}

export function hasCapability(reg: ProviderLike, cap: EditorCapability): boolean {
  return normalizeCapabilities(reg).includes(cap);
}

/** 打开文件时先用哪个能力（缺省 preview；注册可声明 defaultCapability）。 */
export function defaultCapabilityOf(reg: ProviderLike): EditorCapability {
  const caps = normalizeCapabilities(reg);
  if (reg.defaultCapability && caps.includes(reg.defaultCapability)) return reg.defaultCapability;
  return "preview";
}

/**
 * 命中队列排序（纯）：偏好 > priority > 注册顺序。
 * @param matched selector 已命中的 providers（数组次序 = 注册顺序）
 * @param prefs   用户默认偏好 { ".docx": "providerId" }
 */
export function sortChain<T extends ProviderLike>(matched: T[], prefs: Record<string, string>, ext: string): T[] {
  const preferredId = prefs && ext ? prefs[ext] : "";
  return [...matched].sort((a, b) => {
    if (preferredId) {
      if (a.id === preferredId && b.id !== preferredId) return -1;
      if (b.id === preferredId && a.id !== preferredId) return 1;
    }
    return (PRIORITY_WEIGHT[b.priority || "default"] || 1) - (PRIORITY_WEIGHT[a.priority || "default"] || 1);
  });
}

/**
 * 围栏渲染器裁决（纯，md-plugins §5.1）：命中 lang 的注册项排序 = priority > 注册顺序。
 *
 * 与文件级 sortChain 的唯一差别是**无用户偏好**（围栏粒度太细，不进 prefs UI）——
 * 内置渲染器恒 priority:"default" 且先注册 ⇒ 平局内置赢，外部扩展不声明
 * preferred/override 就拿不走内置渲染器。同 lang 多声明不阻断，队列首生效。
 */
export function resolveFenceChain<T extends MdRendererLike>(all: T[], lang: string): T[] {
  if (!lang) return [];
  return sortChain((all || []).filter((r) => r && r.lang === lang), {}, "");
}

/**
 * 接管判定（纯，§1.6）：命中 provider 队列非空即接管；否则按 文本 / 可渲染二进制 兜底。
 *
 * supportsEdit:false 只表示 preview-only（capabilities 规整为 ["preview"]），
 * 不等于「不可渲染」——内建图片/视频/音频/PDF provider 都是 preview 能力，照常接管。
 * 回归备忘：M0 曾按 `resolved.provider.supportsEdit !== false` 判定，而 text provider
 * 按 §1.2 退出非文本队列后，媒体链首变成 preview-only provider → 视频等预览整体
 * 跌回核心旧查看器（2026-09-06 实测）。
 */
export function shouldTakeover(input: {
  chainLength: number;
  isText: boolean;
  isViewableBinary: boolean;
}): boolean {
  if (input.chainLength > 0) return true;
  return input.isText || input.isViewableBinary;
}

/**
 * 能力联动选主（纯）：返回队列中第一个具备 cap 能力的 provider。
 * 当前 provider 具备该能力 → 返回它自己（ no-op 语义）；全队列无 → null。
 */
export function pickForCapability<T extends ProviderLike>(chain: T[], cap: EditorCapability): T | null {
  for (const p of chain) {
    if (hasCapability(p, cap)) return p;
  }
  return null;
}

/** 菜单能力标注：👁 预览 / ✏️ 编辑 / 👁✏️ 双能力。 */
export function capabilityBadge(reg: ProviderLike): string {
  const caps = normalizeCapabilities(reg);
  const p = caps.includes("preview") ? "👁" : "";
  const e = caps.includes("edit") ? "✏️" : "";
  return p + e;
}
