/**
 * G1 host tools 白名单（docs/pi-web-ext-host-tools-gate-plan.md §G1）
 *
 * 背景：桥 MCP 的 `aiti_*` 工具经 wireBridgeHostTools（omp） / aiti_bridge_req 转发（attach）
 * 注入外部 agent 时零过滤——prompt injection 一跳即达页面执行/表单写等高危工具。
 * G1 = 缺省只放行只读与人机交互类子集；`*`（或 "all"）= 全量＝旧现状；显式清单 = 精确集合。
 *
 * 消费方：aiti-omp-agent/host-tools-bridge.ts（tools/list 过滤）、aiti-attach-agent/index.ts
 * （aiti_bridge_req 转发校验）。feature：`<extId>.hostToolsAllow`（string，缺省空=readonly 子集）。
 */

/** 缺省只读/人机交互子集（无页面数据副作用；写类 page_exec/form_fill 默认排除） */
export const HOST_TOOLS_READONLY_NAMES: readonly string[] = [
  "aiti_inbox",       // 消息主通道拉取（G1 红线：保守清单必含 inbox 读类）
  "aiti_hello",       // agent 自我介绍/注册
  "bridge_status",    // 已连接页面快照
  "page_snapshot",    // 页面现场读取
  "self_ui",          // 弹窗/表单清单扫描
  "page_logs",        // console 日志读取
  "page_network",     // 网络完成态读取
  "file_stat",        // 文件元数据查询
  "user_pick_element", // 人机点选（人参与，无数据副作用）
  "user_confirm",
  "user_choose",
  "user_input",
  "user_presence",
  "user_notify",
];

const READONLY = new Set<string>(HOST_TOOLS_READONLY_NAMES);

export type HostToolsAllow = "all" | "readonly" | Set<string>;

/** 解析 feature 值：空/"readonly" → 只读子集；"*"/"all" → 全量；其余 = 逗号/空白分隔的显式名单 */
export function parseHostToolsAllow(value: string | null | undefined): HostToolsAllow {
  const v = String(value ?? "").trim();
  if (!v || v === "readonly") return "readonly";
  if (v === "*" || v === "all") return "all";
  const names = v.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  return names.length ? new Set(names) : "readonly";
}

/** 按白名单过滤工具清单（omp tools/list 用） */
export function filterHostToolsByAllow<T extends { name: string }>(tools: T[], allow: HostToolsAllow): T[] {
  if (allow === "all") return tools;
  if (allow === "readonly") return tools.filter((t) => READONLY.has(t.name));
  return tools.filter((t) => allow.has(t.name));
}

/** 单工具判定（attach aiti_bridge_req 转发校验用） */
export function hostToolAllowed(name: string, allow: HostToolsAllow): boolean {
  if (allow === "all") return true;
  if (allow === "readonly") return READONLY.has(name);
  return allow.has(name);
}

/** 读 extman feature `<extId>.hostToolsAllow`（运行时经宿主 featureValue；缺席=缺省只读子集） */
export function readHostToolsAllow(extId: string): string | null {
  try {
    const reg = (globalThis as { __piWebExt?: { featureValue?: (extId: string, fid: string) => boolean | string } }).__piWebExt;
    const v = reg?.featureValue?.(extId, "hostToolsAllow");
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v === true) return "*";
  } catch { /* 宿主缺席：按缺省处理 */ }
  return null;
}

/** extman feature 声明（各消费扩展 features 数组追加；group 传 "Omp" 等分组名） */
export function hostToolsAllowFeature(group?: string): {
  id: string; type: "string"; label: string; description: string; value: string; placeholder: string; group?: string;
} {
  return {
    id: "hostToolsAllow",
    ...(group ? { group } : {}),
    type: "string",
    label: "桥工具白名单",
    description:
      "注入 agent 的桥（aiti_*）工具白名单。留空 = 只读子集（消息/页面读/人机交互类；page_exec、form_fill " +
      "等写类不注入——G1 安全缺省）。* = 全量（恢复旧现状，含页面执行/表单写）。也可给精确名单（逗号/空格分隔，" +
      "如 aiti_inbox, page_exec）。名单外工具 agent 调用会报 unknown host tool；改完下一轮会话生效。",
    value: "",
    placeholder: "留空=只读子集；*=全量；或 aiti_inbox, page_snapshot, page_exec",
  };
}
