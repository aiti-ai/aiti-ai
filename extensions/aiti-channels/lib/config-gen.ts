/**
 * aiti-channels · config.toml 生成器（表单化配置界面的落点）
 *
 * 用户要求：不手动改配置文件、不做前端文本编辑——面板用表单填，
 * 这里把结构化表单数据渲染成合法 cc-connect TOML 并落盘。
 * 结构对齐现有 ~/.config/cc-connect.toml（projects/agent/platforms/management/bridge/log）。
 */

export type PlatformForm = {
  type: string;
  /** 泛化字段：按 platform-schema 的键名任意填（renderConfig 输出非空键值对） */
  fields?: Record<string, string>;
  // ↓ 旧平铺字段（兼容既有调用；renderConfig 会合入 fields）
  client_id?: string;
  client_secret?: string;
  agent_id?: string | number;
  bot_name?: string;
};

export type ProjectForm = {
  name: string;
  agent?: string;      // claudecode / codex / cursor / gemini / qoder / opencode / piweb
  work_dir?: string;
  mode?: string;       // agent 运行模式（default / full_auto 等）
  /**
   * agent=piweb 专用：true = 原生 type=piweb（cc-connect 内建 ACP client 直连
   * Unix socket，无连接器进程；需 cc-connect 支持该 agent type 的版本）。
   * 缺省/false = 兜底 type=acp + 薄连接器（不改 cc-connect 任何文件的旧路径）。
   * 两路径语义等价，见 docs/cc-connect-piweb-agent-plan.md §3.2/§3.3.3。
   */
  piwebNative?: boolean;
  platforms: PlatformForm[];
};

export type ConfigForm = {
  dataDir: string;
  language?: string;
  logLevel?: string;
  management?: { enabled: boolean; port: number; token?: string };
  bridge?: { enabled: boolean; port: number; token?: string };
  projects: ProjectForm[];
  /** agent=piweb 时必填：连接器与 ACP socket 路径（index.ts 从 acp-server 取） */
  acp?: { connector: string; socketPath: string };
};

const tq = (s?: string | number) => (s === undefined || s === "" ? "" : JSON.stringify(String(s)));
const has = (s?: string) => s !== undefined && s !== "";

/** 渲染为 TOML 文本（合法 cc-connect config）。 */
export function renderConfig(form: ConfigForm): string {
  const L: string[] = [];
  L.push(`data_dir = ${tq(form.dataDir || "")}`);
  L.push(`language = ${tq(form.language || "zh")}`);
  L.push("");
  // AITI 统一行为：外部 agent 新启动即带 aiti MCP 工具直连浏览器桥——
  // 各 agent 的 MCP 配置由 aiti shim 自注册（core autoRegisterAitiShim / aiti-mcp-register.mjs）；
  // 本进程（cc-connect）环境需带 AITI_BRIDGE_URL（如 http://127.0.0.1:8777），agent 子进程继承后即连对桥。
  L.push(`# AITI: set env AITI_BRIDGE_URL (e.g. http://127.0.0.1:8777) on this service so agent child processes connect the browser bridge.`);
  L.push("");

  for (const p of form.projects || []) {
    L.push("[[projects]]");
    L.push(`  name = ${tq(p.name)}`);
    L.push("  [projects.agent]");
    if (p.agent === "piweb") {
      if (!form.acp?.connector || !form.acp?.socketPath) throw new Error("agent=piweb 需要 acp.connector / acp.socketPath");
      if (p.piwebNative) {
        // 原生路径：cc-connect 内建 ACP client net.Dial("unix") 直连 pi-web ACP socket，
        // 链路里没有任何子进程（display_name 仍标注 AITI 便于 IM 侧识别）
        L.push(`    type = "piweb"`);
        L.push("    [projects.agent.options]");
        if (has(p.work_dir)) L.push(`      work_dir = ${tq(p.work_dir)}`);
        L.push(`      socket = ${tq(form.acp.socketPath)}`);
        L.push(`      display_name = "AITI Agent"`);
      } else {
        // 兜底路径：cc-connect 现成 type=acp + 我们的薄连接器，
        // 真 agent（pi-web 会话）在 pi-web 进程内，归 aiti 管（不改 cc-connect 任何文件）
        L.push(`    type = "acp"`);
        L.push("    [projects.agent.options]");
        if (has(p.work_dir)) L.push(`      work_dir = ${tq(p.work_dir)}`);
        L.push(`      command = "node"`);
        L.push(`      args = [${tq(form.acp.connector)}, "--socket", ${tq(form.acp.socketPath)}]`);
        L.push(`      display_name = "AITI Agent"`);
      }
    } else {
      L.push(`    type = ${tq(p.agent || "claudecode")}`);
      L.push("    [projects.agent.options]");
      if (has(p.mode)) L.push(`      mode = ${tq(p.mode)}`);
      if (has(p.work_dir)) L.push(`      work_dir = ${tq(p.work_dir)}`);
    }
    for (const pl of p.platforms || []) {
      // 泛化：fields record（schema 驱动）+ 旧平铺字段合并；非空键值都写出
      const fields: Record<string, string> = { ...(pl.fields || {}) };
      for (const [k, v] of Object.entries(pl as Record<string, unknown>)) {
        if (k === "type" || k === "fields") continue;
        if (v !== undefined && v !== null && String(v) !== "" && !(k in fields)) fields[k] = String(v);
      }
      L.push("");
      L.push("  [[projects.platforms]]");
      L.push(`    type = ${tq(pl.type)}`);
      L.push("    [projects.platforms.options]");
      for (const [k, v] of Object.entries(fields)) {
        if (!has(v)) continue;
        L.push(`      ${k} = ${tq(v)}`);
      }
    }
    L.push("");
  }

  if (form.management) {
    L.push("[management]");
    L.push(`enabled = ${form.management.enabled}`);
    L.push(`port = ${form.management.port}`);
    if (has(form.management.token)) L.push(`token = ${tq(form.management.token)}`);
    L.push("");
  }
  if (form.bridge) {
    L.push("[bridge]");
    L.push(`enabled = ${form.bridge.enabled}`);
    L.push(`port = ${form.bridge.port}`);
    if (has(form.bridge.token)) L.push(`token = ${tq(form.bridge.token)}`);
    L.push(`path = "/bridge/ws"`);
    L.push("");
  }
  if (has(form.logLevel)) {
    L.push("[log]");
    L.push(`level = ${tq(form.logLevel)}`);
    L.push("");
  }
  return L.join("\n");
}
