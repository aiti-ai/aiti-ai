/**
 * pi-web 扩展协议版本 —— canonical 定义（aiti-ai 侧）。
 *
 * 用途：
 *   - 扩展在 package.json 声明 `"aitiExtProtocol": "1.0"`（字符串 MAJOR.MINOR）；
 *   - 检查脚本 / extman / 未来安装筛查器共用本模块的解析与状态计算；
 *   - 宿主 pi-web 镜像实现 `lib/ext/protocol.ts`（同语义，规范见 docs/pi-web-ext-protocol.md）。
 *
 * 本文件被 extman deploy 拷贝进扩展目录（ext-protocol.mjs）供运行时使用——保持零依赖纯 ESM。
 * bump 规则（docs/pi-web-ext-protocol.md §2.1）：仅**明显改动已有接口且影响现有功能**时 MAJOR+1；
 * 纯增项不 bump。bump 流程见规范 §7（改本文件常量 + 变更记录 + 迁移手册；宿主镜像同步改）。
 */

/** 当前协议版本（字符串 MAJOR.MINOR）。 */
export const EXT_PROTOCOL_VERSION = "1.0";

/** 宿主最低支持的协议 MAJOR（声明 major < 此值 = incompatible；首次 bump 时按兼容策略提高）。 */
export const EXT_PROTOCOL_MIN_MAJOR = 1;

/**
 * 解析协议版本声明。仅接受字符串 "MAJOR.MINOR"（数字类型/其他格式 → null）。
 * @param {unknown} v
 * @returns {{ major: number, minor: number, raw: string } | null}
 */
export function parseExtProtocol(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const m = /^(\d+)\.(\d+)$/.exec(s);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), raw: s };
}

/**
 * 声明 → 当前协议之间的迁移手册引用（逐跳；声明缺失视为 legacy）。
 * 例：声明 "1.0" + 当前 "2.1" → ["v1-to-v2"]；缺失 + 当前 "1.0" → ["legacy-to-v1"]。
 * 手册位于 pi-web-ext/aiti-extman/skills/ext-protocol-upgrade/references/。
 * @param {unknown} declared
 * @param {{ current?: string }} [opts]
 * @returns {string[]}
 */
export function extProtocolUpgradeRefs(declared, opts = {}) {
  const cur = parseExtProtocol(opts.current ?? EXT_PROTOCOL_VERSION) ?? parseExtProtocol(EXT_PROTOCOL_VERSION);
  if (!cur) return [];
  const d = parseExtProtocol(declared);
  const refs = [];
  // 声明缺失/非法/0.x（版本化前谱系）→ 先补 legacy 手册；迁移手册按 major 逐跳。
  const legacy = !d || d.major < 1;
  let fromMajor = legacy ? 1 : d.major;
  if (legacy) refs.push("legacy-to-v1");
  for (let m = fromMajor; m < cur.major; m++) refs.push(`v${m}-to-v${m + 1}`);
  return refs;
}

/**
 * 兼容状态计算（唯一裁决口径）。
 *
 * state：
 *   ok            同 major（扩展 minor 高于宿主 minor 时 minorAhead=true，仅黄提示）
 *   stale         声明 major < 当前 major 且 >= minMajor（宿主保留兼容层，仍可运行）
 *   incompatible  声明 major < minMajor（宿主已不再兼容）
 *   too_new       声明 major > 当前 major（宿主过旧，需升级 pi-web）
 *   missing       无声明（版本化前遗留，视为 legacy v0）
 *   invalid       声明非法（非 "M.m" 字符串）
 *
 * @param {unknown} declared
 * @param {{ current?: string, minMajor?: number }} [opts]
 * @returns {{
 *   state: "ok"|"stale"|"incompatible"|"too_new"|"missing"|"invalid",
 *   declared: string|null,
 *   current: string,
 *   minSupported: string,
 *   minorAhead: boolean,
 *   needsUpgrade: boolean,
 *   upgradeRefs: string[],
 *   detail?: string,
 * }}
 */
export function extProtocolInfo(declared, opts = {}) {
  const current = parseExtProtocol(opts.current ?? EXT_PROTOCOL_VERSION) ?? { major: 1, minor: 0, raw: EXT_PROTOCOL_VERSION };
  const minMajor = Number.isInteger(opts.minMajor) ? opts.minMajor : EXT_PROTOCOL_MIN_MAJOR;
  const minSupported = `${minMajor}.0`;
  const base = {
    declared: typeof declared === "string" ? declared : null,
    current: current.raw,
    minSupported,
    minorAhead: false,
    needsUpgrade: false,
    upgradeRefs: [],
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
