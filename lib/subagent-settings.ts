import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// aiti fork 守护：恒禁用上游内置子代理——fork 的 pi-subagents（@aiti-ai/pi-subagents）
// 是唯一子代理引擎；上游 237d0ca 曾改回读文件启用，两套引擎并存会冲突。恢复恒 false。
// lib/subagent-settings.test.mjs 有守护测试盯死此实现（无参签名 + 首行 return false，改前先看它）。
export function isBuiltInSubagentsEnabled(): boolean {
  return false;
}

export interface SubagentEngineStatus {
  /** 引擎是否经 pi settings.json packages 装载（装载即启用，无独立开关） */
  installed: boolean;
  packageName: "@aiti-ai/pi-subagents";
  /** settings.json packages 里的原始 spec（如 "npm:@aiti-ai/pi-subagents@0.59.0-aiti.1"） */
  spec: string | null;
  /** 实装版本（读 <agentDir>/npm/node_modules 下 package.json；未装或读取失败为 null） */
  version: string | null;
}

/**
 * fork 子代理引擎（@aiti-ai/pi-subagents）装载状态：唯一来源是 pi settings.json 的
 * packages 数组（装载即启用，无运行时开关——Agents 页展示用，见 docs/todo-upstream-v0.9-integration.md T3）。
 * 写路径不存在：引擎开关=pi settings.json 的 packages 管理，不在 pi-web 侧提供。
 */
export function readSubagentEngineStatus(
  agentDir = getAgentDir(),
  settingsPath = join(agentDir, "settings.json"),
): SubagentEngineStatus {
  const PACKAGE_NAME = "@aiti-ai/pi-subagents" as const;
  let spec: string | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const packages = (parsed as { packages?: unknown }).packages;
      if (Array.isArray(packages)) {
        const hit = packages.find((entry): entry is string =>
          typeof entry === "string" && entry.includes(PACKAGE_NAME));
        if (hit) spec = hit;
      }
    }
  } catch {
    // settings.json 缺失/损坏 → 视为未装载，不再上抛（展示态接口 fail-soft）
  }
  let version: string | null = null;
  if (spec) {
    try {
      const pkgPath = join(agentDir, "npm", "node_modules", ...PACKAGE_NAME.split("/"), "package.json");
      const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg && typeof pkg === "object" && typeof (pkg as { version?: unknown }).version === "string") {
        version = (pkg as { version: string }).version;
      }
    } catch {
      // 实装目录读取失败 → version 留空（spec 仍展示）
    }
  }
  return { installed: spec !== null, packageName: PACKAGE_NAME, spec, version };
}
