/**
 * aiti-channels · config.toml 读取（cc-connect 配置）
 *
 * 极简 TOML 解析（不引第三方）：只需提取 aiti-channels 关心的段——
 *   [management]  enabled/port/token
 *   [bridge]      enabled/port/token/path
 *   [log]         level
 *   [[projects]]  name/agent/platforms（嵌套 [[projects.platforms]]）
 * 其余 key 忽略。行级：`key = value`、段 `[x]` / `[[x]]`、注释 `#`。
 */

import { readFileSync } from "node:fs";

export type CcPlatform = {
  type: string;
  options: Record<string, string>;
};

export type CcProject = {
  name: string;
  agentType: string;
  agentOptions: Record<string, string>;
  platforms: CcPlatform[];
};

export type CcConfig = {
  path: string;
  raw: string;
  management: { enabled: boolean; port: number; token: string };
  bridge: { enabled: boolean; port: number; token: string; path: string };
  logLevel: string;
  projects: CcProject[];
};

function parseBool(v: string): boolean {
  return /^(true|yes|on|1)$/i.test(String(v).trim());
}

function parseScalar(v: string): string | number | boolean {
  const s = String(v).trim();
  if (/^"[^"]*"$/.test(s)) return s.slice(1, -1);
  if (/^'[^']*'$/.test(s)) return s.slice(1, -1);
  if (/^(true|false|yes|no|on|off)$/i.test(s)) return parseBool(s);
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

export function parseConfig(raw: string): Omit<CcConfig, "path" | "raw"> {
  const cfg = {
    management: { enabled: false, port: 9820, token: "" },
    bridge: { enabled: false, port: 9810, token: "", path: "/bridge/ws" },
    logLevel: "info",
    projects: [] as CcProject[],
  };

  const lines = raw.split(/\r?\n/);
  let section = ""; // 当前段名（含数组段）
  let curProject: CcProject | null = null;
  let curPlatform: CcPlatform | null = null;
  let inProjectAgent = false;

  const commitPlatform = () => {
    if (curProject && curPlatform) curProject.platforms.push(curPlatform);
    curPlatform = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;

    if (line.startsWith("[[")) {
      const name = line.slice(2, -2).trim();
      commitPlatform();
      inProjectAgent = false;
      if (name === "projects") {
        if (curProject) cfg.projects.push(curProject);
        curProject = { name: "", agentType: "", agentOptions: {}, platforms: [] };
        section = name;
      } else if (name.startsWith("projects.platforms")) {
        section = "projects.platforms";
        curPlatform = { type: "", options: {} };
      } else {
        section = name;
      }
      continue;
    }

    if (line.startsWith("[")) {
      const name = line.slice(1, -1).trim();
      // platform 内部子段（[projects.platforms.options]）不提交 curPlatform——
      // 否则 options 键会因 curPlatform 置空而丢失（platform 由 [[..]] 段提交）
      if (!name.startsWith("projects.platforms.")) commitPlatform();
      section = name;
      inProjectAgent = name === "projects.agent";
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = parseScalar(line.slice(eq + 1));

    if (section === "management") {
      if (key === "enabled") cfg.management.enabled = !!val;
      else if (key === "port") cfg.management.port = Number(val);
      else if (key === "token") cfg.management.token = String(val);
      continue;
    }
    if (section === "bridge") {
      if (key === "enabled") cfg.bridge.enabled = !!val;
      else if (key === "port") cfg.bridge.port = Number(val);
      else if (key === "token") cfg.bridge.token = String(val);
      else if (key === "path") cfg.bridge.path = String(val);
      continue;
    }
    if (section === "log") {
      if (key === "level") cfg.logLevel = String(val);
      continue;
    }

    if (section === "projects" && curProject) {
      if (key === "name") curProject.name = String(val);
      continue;
    }
    if (section.startsWith("projects.agent") && curProject) {
      if (key === "type") curProject.agentType = String(val);
      else curProject.agentOptions[key] = String(val);
      continue;
    }
    if (section.startsWith("projects.platforms") && curPlatform) {
      if (key === "type") curPlatform.type = String(val);
      else curPlatform.options[key] = String(val);
    }
  }

  if (curProject) {
    commitPlatform();
    cfg.projects.push(curProject);
  }

  return cfg;
}

export function readConfigFile(configPath: string): CcConfig | null {
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = parseConfig(raw);
    return { path: configPath, raw, ...parsed };
  } catch {
    return null;
  }
}
