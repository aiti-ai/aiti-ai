/**
 * ext-conflicts —— 通用「冲突插件」禁用机制。
 *
 * 扩展在清单（PiWebExtension.conflicts）里声明与其功能冲突、必须禁用的第三方
 * 扩展/包标识；平台组装 SDK 扩展加载结果（LoadExtensionsResult）时，把命中
 * 标识的扩展整个移除（不初始化）。
 *
 * 典型用例（aiti-subagents）：声明 conflicts: ["pi-subagents"] —— 用户手工安装的
 * 原版 pi-subagents 与平台自带 fork（@aiti-ai/pi-subagents）注册同名 subagent
 * 工具，双注册冲突；fork 是完整平替，原版一律禁用。
 *
 * 匹配规则（保守、防误伤）：
 *   - 标识与 SDK 扩展的 **npm 包名** 精确比较（scoped 完整名，如
 *     "@aiti-ai/pi-subagents" ≠ "pi-subagents"）；
 *   - 仅 source 可解析时参与匹配（本地路径安装无 source 的暂不覆盖）；
 *   - 声明者位于 pi-web 扩展体系，与 SDK 加载结果天然隔离，无自噬问题。
 * 无轮询：仅在扩展加载结果组装（会话创建）路径上调用。
 */

import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

/** 极简 registry 形状（依赖注入；真实实现为 lib/ext/registry 的 ExtRegistryImpl）。 */
export interface ConflictsRegistryProbe {
  all(): Array<{ ext: { conflicts?: string[] } }>;
}

/** 从 npm/git style source 解析包名："npm:@scope/name@1.2" → "@scope/name"；"git:foo" → "foo"。 */
export function sourcePackageName(source: string): string {
  let s = source.replace(/^[a-z]+:/i, "");
  s = s.split("#")[0];
  if (s.startsWith("@")) {
    const at = s.indexOf("@", 1);
    return at === -1 ? s : s.slice(0, at);
  }
  const at = s.indexOf("@");
  return at === -1 ? s : s.slice(0, at);
}

/** 路径中的 scoped 包名（"…/node_modules/@scope/name/…" → "@scope/name"）；无则 null。 */
export function pathScopedPackageName(path: string): string | null {
  const segments = path.replaceAll("\\", "/").split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].startsWith("@") && segments[i + 1]) return `${segments[i]}/${segments[i + 1]}`;
  }
  return null;
}

/** 收集所有已加载 pi-web 扩展声明的冲突标识（去重、保序）。 */
export function collectExtensionConflicts(registry: ConflictsRegistryProbe): string[] {
  const out: string[] = [];
  try {
    for (const loaded of registry.all()) {
      for (const c of loaded.ext.conflicts ?? []) {
        const id = String(c ?? "").trim();
        if (id && !out.includes(id)) out.push(id);
      }
    }
  } catch { /* registry 不可用 → 无冲突声明 */ }
  return out;
}

/**
 * 组装 SDK 扩展加载结果时禁用被声明冲突的扩展。
 * @param base  SDK 扩展加载结果
 * @param registry  pi-web 扩展注册表（声明来源）；不可用时原样返回
 */
export function disableConflictingExtensions(
  base: LoadExtensionsResult,
  registry?: ConflictsRegistryProbe,
): LoadExtensionsResult {
  if (!registry) return base;
  const conflicts = collectExtensionConflicts(registry);
  if (conflicts.length === 0) return base;

  const blocked = (extension: LoadExtensionsResult["extensions"][number]): boolean => {
    const viaSource = sourcePackageName(extension.sourceInfo?.source ?? "");
    if (viaSource && conflicts.includes(viaSource)) return true;
    const viaPath = pathScopedPackageName(extension.resolvedPath ?? extension.path ?? "");
    if (viaPath && conflicts.includes(viaPath)) return true;
    return false;
  };

  const removed = new Set<string>();
  for (const extension of base.extensions) {
    if (blocked(extension)) removed.add(extension.path);
  }
  if (removed.size === 0) return base;

  return {
    ...base,
    extensions: base.extensions.filter((extension) => !removed.has(extension.path)),
    errors: base.errors.filter((error) => !removed.has(error.path)),
  };
}
