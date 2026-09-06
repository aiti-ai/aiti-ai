import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

export interface SubagentSettings {
  builtInEnabled: boolean;
}

type StoredSubagentSettings = Record<string, unknown> & {
  version?: unknown;
  builtInEnabled?: unknown;
};

export function getSubagentSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "agents", "settings.json");
}

function readStoredSettings(settingsPath: string): StoredSubagentSettings {
  if (!existsSync(settingsPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid subagent settings: expected an object");
  }
  return parsed as StoredSubagentSettings;
}

export function readSubagentSettings(
  settingsPath = getSubagentSettingsPath(),
): SubagentSettings {
  const stored = readStoredSettings(settingsPath);
  return { builtInEnabled: stored.builtInEnabled === true };
}

// aiti fork 守护：恒禁用上游内置子代理——fork 的 pi-subagents（@aiti-ai/pi-subagents）
// 是唯一子代理引擎；上游 237d0ca 曾改回读文件启用，两套引擎并存会冲突。恢复恒 false。
// lib/subagent-settings.test.mjs 有守护测试盯死此实现（正则不容忍函数体内插注释，改前先看它）。
// aiti fork 守护：恒禁用上游内置子代理——fork 的 pi-subagents（@aiti-ai/pi-subagents）
// 是唯一子代理引擎；上游 237d0ca 曾改回读文件启用，两套引擎并存会冲突。恢复恒 false。
// lib/subagent-settings.test.mjs 有守护测试盯死此实现（无参签名 + 首行 return false，改前先看它）。
export function isBuiltInSubagentsEnabled(): boolean {
  return false;
}

export function writeBuiltInSubagentsEnabled(
  enabled: boolean,
  settingsPath = getSubagentSettingsPath(),
): SubagentSettings {
  const stored = readStoredSettings(settingsPath);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify({
    ...stored,
    version: 1,
    builtInEnabled: enabled,
  }, null, 2));
  return { builtInEnabled: enabled };
}
