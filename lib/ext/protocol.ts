/**
 * pi-web 扩展协议版本 —— 宿主侧镜像（docs/pi-web-ext-protocol.md）。
 *
 * canonical 定义在 aiti-ai：`pi-web-ext/_shared/ext-protocol.mjs`（规范 + 变更记录）；
 * 本文件保持同语义/同常量，宿主用它对扩展 package.json 的 `aitiExtProtocol` 做静态裁决：
 *   - registry.status()/statusPayload()：每扩展带 `protocol` 状态 + 顶层 current/minSupported；
 *   - loadAll()：非 ok 打一条 warn（进程级去重）；PI_WEB_EXT_PROTOCOL_STRICT=1 时拒载
 *     incompatible/missing/invalid/too_new（stale 仍加载——宿主保留兼容层）。
 * bump 规则（规范 §2.1）：仅明显改动已有接口且影响现有功能时 MAJOR+1；纯增项不 bump。
 * 版本 bump 时两边（本文件与 aiti-ai canonical）同时改（bump 流程见规范 §7）；两侧单测各自钉死解析与状态逻辑。
 */

/** 当前协议版本（字符串 MAJOR.MINOR）。 */
export const EXT_PROTOCOL_VERSION = "1.0";

/** 宿主最低支持的协议 MAJOR（声明 major < 此值 = incompatible）。 */
export const EXT_PROTOCOL_MIN_MAJOR = 1;

export interface ExtProtocolParse {
  major: number;
  minor: number;
  raw: string;
}

export type ExtProtocolState = "ok" | "stale" | "incompatible" | "too_new" | "missing" | "invalid";

export interface ExtProtocolInfo {
  state: ExtProtocolState;
  declared: string | null;
  current: string;
  minSupported: string;
  minorAhead: boolean;
  needsUpgrade: boolean;
  upgradeRefs: string[];
  detail?: string;
}

/** 解析协议版本声明。仅接受字符串 "MAJOR.MINOR"（数字类型/其他格式 → null）。 */
export function parseExtProtocol(v: unknown): ExtProtocolParse | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const m = /^(\d+)\.(\d+)$/.exec(s);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), raw: s };
}

/**
 * 声明 → 当前协议之间的迁移手册引用（逐跳；声明缺失视为 legacy）。
 * 手册位于 aiti-ai `pi-web-ext/aiti-extman/skills/ext-protocol-upgrade/references/`。
 */
export function extProtocolUpgradeRefs(declared: unknown, opts: { current?: string } = {}): string[] {
  const cur = parseExtProtocol(opts.current ?? EXT_PROTOCOL_VERSION) ?? parseExtProtocol(EXT_PROTOCOL_VERSION);
  if (!cur) return [];
  const d = parseExtProtocol(declared);
  const refs: string[] = [];
  // 声明缺失/非法/0.x（版本化前谱系）→ 先补 legacy 手册；迁移手册按 major 逐跳。
  const legacy = !d || d.major < 1;
  const fromMajor = legacy ? 1 : d.major;
  if (legacy) refs.push("legacy-to-v1");
  for (let m = fromMajor; m < cur.major; m++) refs.push(`v${m}-to-v${m + 1}`);
  return refs;
}

/**
 * 兼容状态计算（与 aiti-ai `_shared/ext-protocol.mjs` 同裁决口径）：
 *   ok 同 major（扩展 minor 高于宿主 minor 时 minorAhead=true）/ stale / incompatible /
 *   too_new / missing / invalid。
 */
export function extProtocolInfo(declared: unknown, opts: { current?: string; minMajor?: number } = {}): ExtProtocolInfo {
  const current = parseExtProtocol(opts.current ?? EXT_PROTOCOL_VERSION) ?? { major: 1, minor: 0, raw: EXT_PROTOCOL_VERSION };
  const minMajor = Number.isInteger(opts.minMajor) ? (opts.minMajor as number) : EXT_PROTOCOL_MIN_MAJOR;
  const minSupported = `${minMajor}.0`;
  const base = {
    declared: typeof declared === "string" ? declared : null,
    current: current.raw,
    minSupported,
    minorAhead: false,
    needsUpgrade: false,
    upgradeRefs: [] as string[],
  };
  if (declared === undefined || declared === null || declared === "") {
    return { ...base, state: "missing", needsUpgrade: true, upgradeRefs: extProtocolUpgradeRefs(declared, opts), detail: "未声明协议版本（legacy）" };
  }
  const d = parseExtProtocol(declared);
  if (!d) {
    return { ...base, state: "invalid", needsUpgrade: true, upgradeRefs: extProtocolUpgradeRefs(declared, opts), detail: '声明必须是 "MAJOR.MINOR" 字符串' };
  }
  if (d.major > current.major) {
    return { ...base, state: "too_new", detail: `扩展声明协议 ${d.raw} 高于宿主 ${current.raw}——请升级 pi-web 宿主` };
  }
  if (d.major < minMajor) {
    return { ...base, state: "incompatible", needsUpgrade: true, upgradeRefs: extProtocolUpgradeRefs(declared, opts), detail: `声明 ${d.raw} 低于宿主最低支持 ${minSupported}` };
  }
  if (d.major < current.major) {
    return { ...base, state: "stale", needsUpgrade: true, upgradeRefs: extProtocolUpgradeRefs(declared, opts), detail: `声明 ${d.raw} 落后当前 ${current.raw}` };
  }
  const minorAhead = d.minor > current.minor;
  return {
    ...base,
    state: "ok",
    minorAhead,
    detail: minorAhead ? `扩展用到 ${d.raw} 的新增能力（宿主 ${current.raw}）——宿主可升级以启用` : undefined,
  };
}

/** strict 拒载状态（PI_WEB_EXT_PROTOCOL_STRICT=1）；stale 不在内（宿主保留兼容层）。 */
export const EXT_PROTOCOL_STRICT_BLOCKED: ExtProtocolState[] = ["incompatible", "missing", "invalid", "too_new"];
