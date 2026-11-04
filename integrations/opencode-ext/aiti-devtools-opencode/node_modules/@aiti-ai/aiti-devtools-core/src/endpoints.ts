/**
 * aiti-devtools-core · 地址协商解析（公共能力，载体无关）
 *
 * 把用户给的"一个地址"智能归一到桥端点（需求 2/3）：
 *   - 空 → 与应用同源（bridge/mcp/launcher 全部 <origin>/aiti/…）
 *   - 裸基地址 / 带 /aiti / /bridge / /mcp 多余路径 / 完整 MCP 端点 → 剥后缀得到桥 origin
 *   - aiUrl（aiti-agent 地址）→ 直接作 AI 窗，不影响桥
 * 纯函数 + probeBridge（异步探测，供"裸地址未识别"时启发式判定桥/agent）。
 */
export type EndpointsKind = "same-origin" | "external-bridge";

export interface ResolveEndpointsInput {
  /** 用户给的桥/MCP/带多余路径地址（可空 → 同源） */
  bridgeUrl?: string;
  /** 用户直接给的 aiti-agent（AI 窗）地址（可空 → 同源 cockpit） */
  aiUrl?: string;
  /** 本 dev server 的 origin（如 http://localhost:5173） */
  serverUrl: string;
  /** 挂载前缀（默认 /aiti） */
  prefix?: string;
}

export interface ResolvedEndpoints {
  /** 桥来源：与应用同源 / 外部桥 */
  kind: EndpointsKind;
  /** 桥 origin（与应用同源时 = serverUrl） */
  origin: string;
  /** 桥 client base（claim/sse 相对它，绝对 URL，如 http://localhost:5173/aiti） */
  bridgeBase: string;
  /** 注入脚本地址 */
  launcherUrl: string;
  /** MCP 端点（agent 的 mcp 配置 url 指这里） */
  mcpUrl: string;
  /** 操作台（AI 窗默认值） */
  cockpitUrl: string;
  /** AI 窗（用户给 aiti-agent → 那个；否则同源 cockpit） */
  aiUrl: string;
  /** 协商提示（剥掉的路径 / 未识别警告），给启动日志/用户看 */
  notes: string[];
}

const MCP_PATH_SUFFIXES = ["/mcp/mcp", "/bridge", "/mcp"];

/** 剥后缀循环 → { origin, notes }；非桥路径（如 /foo）保留 origin 并提示忽略 */
export function normalizeBridgeUrl(raw: string, prefix: string): { origin: string; notes: string[] } {
  const notes: string[] = [];
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { origin: raw, notes: ["地址无法解析，按原样使用：" + raw] };
  }
  let path = u.pathname.replace(/\/+$/, "") || "/";
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of MCP_PATH_SUFFIXES) {
      if (path.endsWith(suf)) {
        notes.push(`剥离路径后缀 "${suf}"`);
        path = path.slice(0, -suf.length) || "/";
        changed = true;
        break;
      }
    }
    if (!changed && prefix && prefix !== "/" && path.endsWith(prefix)) {
      notes.push(`剥离前缀 "${prefix}"`);
      path = path.slice(0, -prefix.length) || "/";
      changed = true;
    }
  }
  if (path && path !== "/") notes.push(`忽略多余路径 "${path}"（按 origin ${u.origin} 处理）`);
  return { origin: u.origin, notes };
}

/** 判断原始地址是否带明确的桥路径特征（/aiti、/bridge、/mcp） */
export function hasBridgePathSignature(raw: string): boolean {
  try {
    const p = new URL(raw).pathname;
    return /\/aiti(\/|$)/.test(p) || /\/bridge(\/|$)/.test(p) || /\/mcp(\/|$)/.test(p);
  } catch {
    return false;
  }
}

/** 两个 origin 是否同 host:port（http/https 视为一致） */
export function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a), ub = new URL(b);
    return ua.host === ub.host;
  } catch {
    return false;
  }
}

/**
 * 地址协商解析（纯函数）。
 *
 * kind 判定：
 *   - 无 bridgeUrl → same-origin
 *   - bridgeUrl 带桥路径特征 → external-bridge
 *   - bridgeUrl 与 serverUrl 同 host → same-origin
 *   - 其余 → external-bridge（note 提示未识别；插件层可用 probeBridge 二次确认）
 */
export function resolveEndpoints(input: ResolveEndpointsInput): ResolvedEndpoints {
  const prefix = (input.prefix || "/aiti").replace(/\/+$/, "") || "/";
  const serverUrl = String(input.serverUrl || "").replace(/\/+$/, "");
  const notes: string[] = [];

  let origin: string;
  let kind: EndpointsKind = "same-origin";
  if (!input.bridgeUrl) {
    origin = serverUrl;
  } else {
    const r = normalizeBridgeUrl(input.bridgeUrl, prefix);
    origin = r.origin;
    notes.push(...r.notes);
    if (sameOrigin(origin, serverUrl)) kind = "same-origin";
    else {
      kind = "external-bridge";
      if (!hasBridgePathSignature(input.bridgeUrl)) notes.push("输入地址未带桥路径特征（/aiti /bridge /mcp），按桥地址处理——若这是 aiti-agent（AI 窗）地址请改用 aiUrl 参数");
    }
  }

  const bridgeBase = origin + prefix;
  const cockpitUrl = bridgeBase + "/cockpit.html";
  const aiUrl = input.aiUrl && input.aiUrl.trim() ? input.aiUrl.replace(/\/+$/, "") : cockpitUrl;

  return {
    kind,
    origin,
    bridgeBase,
    launcherUrl: bridgeBase + "/aiti-launcher.js",
    // MCP 端点用一遍 /mcp（语义清晰：path[0]=mcp 即 MCP 端点）；/mcp/mcp 两遍旧形态兼容（协商剥后缀仍支持）
    mcpUrl: bridgeBase + "/mcp",
    cockpitUrl,
    aiUrl,
    notes,
  };
}

/**
 * 启发式探测：GET <bridgeBase>/aiti/mcp 是否像 MCP 端点（JSON-RPC 响应结构）。
 * 供"裸地址未识别"场景判定：可达 → 桥；不可达 → 更可能是 aiti-agent（AI 窗）。
 */
export async function probeBridge(bridgeBase: string, timeoutMs = 1500): Promise<boolean> {
  const base = bridgeBase.replace(/\/+$/, "");
  const url = base + "/aiti/mcp";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: ctrl.signal });
      const body = await res.json().catch(() => null);
      return !!body && (body.jsonrpc === "2.0" || typeof body.result !== "undefined" || body.error !== undefined);
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}
