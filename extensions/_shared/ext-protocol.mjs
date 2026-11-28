/**
 * pi-web extension protocol version — canonical definition (this repo).
 *
 * Purpose:
 *   - extensions declare `"aitiExtProtocol": "1.0"` (string MAJOR.MINOR) in package.json;
 *   - check scripts / extman / future install screeners share this module's parsing and state computation;
 *   - the host pi-web mirrors the implementation in `lib/ext/protocol.ts` (same semantics; spec in docs/pi-web-ext-protocol.md).
 *
 * extman deploy copies this file into extension directories (ext-protocol.mjs) for runtime use — keep it zero-dependency pure ESM.
 * Bump rule (docs/pi-web-ext-protocol.md §2.1): MAJOR+1 only for changes that **clearly alter an existing interface and affect current functionality**;
 * pure additions do not bump. The bump process is in spec §7 (change this file's constants + changelog + migration manuals; sync the host mirror).
 */

/** Current protocol version (string MAJOR.MINOR). */
export const EXT_PROTOCOL_VERSION = "1.0";

/** Lowest protocol MAJOR the host supports (declared major < this = incompatible; raised per the compatibility policy on the first bump). */
export const EXT_PROTOCOL_MIN_MAJOR = 1;

/**
 * Parses a protocol version declaration. Accepts only the string "MAJOR.MINOR" (number types/other formats → null).
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
 * Migration-manual references between a declaration and the current protocol (hop by hop; a missing declaration counts as legacy).
 * Example: declared "1.0" + current "2.1" → ["v1-to-v2"]; missing + current "1.0" → ["legacy-to-v1"].
 * Manuals live in pi-web-ext/aiti-extman/skills/ext-protocol-upgrade/references/.
 * @param {unknown} declared
 * @param {{ current?: string }} [opts]
 * @returns {string[]}
 */
export function extProtocolUpgradeRefs(declared, opts = {}) {
  const cur = parseExtProtocol(opts.current ?? EXT_PROTOCOL_VERSION) ?? parseExtProtocol(EXT_PROTOCOL_VERSION);
  if (!cur) return [];
  const d = parseExtProtocol(declared);
  const refs = [];
  // declaration missing/invalid/0.x (pre-versioning lineage) → prepend the legacy manual; migration manuals hop per major.
  const legacy = !d || d.major < 1;
  let fromMajor = legacy ? 1 : d.major;
  if (legacy) refs.push("legacy-to-v1");
  for (let m = fromMajor; m < cur.major; m++) refs.push(`v${m}-to-v${m + 1}`);
  return refs;
}

/**
 * Compatibility state computation (the single arbiter).
 *
 * state：
 *   ok            same major (when the extension's minor exceeds the host's minor, minorAhead=true — yellow hint only)
 *   stale         declared major < current major and >= minMajor (the host keeps a compatibility layer; still runs)
 *   incompatible  declared major < minMajor (the host no longer supports it)
 *   too_new       declared major > current major (host too old; pi-web needs upgrading)
 *   missing       no declaration (pre-versioning leftover, counted as legacy v0)
 *   invalid       declaration invalid (not an "M.m" string)
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
    return { ...base, state: "missing", needsUpgrade: true, upgradeRefs: extProtocolUpgradeRefs(declared, opts), detail: "No protocol version declared (legacy)" };
  }
  const d = parseExtProtocol(declared);
  if (!d) {
    return { ...base, state: "invalid", needsUpgrade: true, upgradeRefs: extProtocolUpgradeRefs(declared, opts), detail: 'Declaration must be a "MAJOR.MINOR" string' };
  }
  if (d.major > current.major) {
    return { ...base, state: "too_new", detail: `Extension declares protocol ${d.raw} above host ${current.raw} — upgrade the pi-web host` };
  }
  if (d.major < minMajor) {
    return { ...base, state: "incompatible", needsUpgrade: true, upgradeRefs: extProtocolUpgradeRefs(declared, opts), detail: `Declared ${d.raw} is below the host's minimum supported ${minSupported}` };
  }
  if (d.major < current.major) {
    return { ...base, state: "stale", needsUpgrade: true, upgradeRefs: extProtocolUpgradeRefs(declared, opts), detail: `Declared ${d.raw} is behind the current ${current.raw}` };
  }
  const minorAhead = d.minor > current.minor;
  return {
    ...base,
    state: "ok",
    minorAhead,
    detail: minorAhead ? `Extension uses new capabilities of ${d.raw} (host ${current.raw}) — the host can upgrade to enable them` : undefined,
  };
}
