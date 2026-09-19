/**
 * Extension protocol version — host-side mirror (docs/pi-web-ext-protocol.md).
 *
 * The canonical definition lives in the extension-side shared module `_shared/ext-protocol.mjs`
 * (spec + change log); this file mirrors its semantics/constants. The host uses it to statically
 * adjudicate an extension package.json's `aitiExtProtocol`:
 *   - registry.status()/statusPayload(): per-extension `protocol` state + top-level current/minSupported;
 *   - loadAll(): logs one warn for non-ok (process-level dedupe); with PI_WEB_EXT_PROTOCOL_STRICT=1
 *     refuses to load incompatible/missing/invalid/too_new (stale still loads — the host keeps a
 *     compatibility layer).
 * Bump rule (spec §2.1): MAJOR+1 only when an existing interface visibly changes and breaks
 * current behavior; purely additive changes don't bump.
 * When bumping, keep in sync with the extension-side copy of this module; both sides' unit
 * tests pin the same parsing/state matrix (bump procedure: spec §7).
 */

/** Current protocol version (string MAJOR.MINOR). */
export const EXT_PROTOCOL_VERSION = "1.0";

/** Minimum protocol MAJOR the host supports (a declared major below this = incompatible). */
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

/** Parse a protocol version declaration. Only accepts the string "MAJOR.MINOR" (numbers/other formats → null). */
export function parseExtProtocol(v: unknown): ExtProtocolParse | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const m = /^(\d+)\.(\d+)$/.exec(s);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), raw: s };
}

/**
 * Upgrade-manual references between a declaration and the current protocol (hop by hop;
 * a missing declaration is treated as legacy).
 * The manuals live in the extension manager's `skills/ext-protocol-upgrade/references/` directory.
 */
export function extProtocolUpgradeRefs(declared: unknown, opts: { current?: string } = {}): string[] {
  const cur = parseExtProtocol(opts.current ?? EXT_PROTOCOL_VERSION) ?? parseExtProtocol(EXT_PROTOCOL_VERSION);
  if (!cur) return [];
  const d = parseExtProtocol(declared);
  const refs: string[] = [];
  // Missing/invalid/0.x declaration (pre-versioning lineage) → prepend the legacy manual;
  // migration manuals hop one major at a time.
  const legacy = !d || d.major < 1;
  const fromMajor = legacy ? 1 : d.major;
  if (legacy) refs.push("legacy-to-v1");
  for (let m = fromMajor; m < cur.major; m++) refs.push(`v${m}-to-v${m + 1}`);
  return refs;
}

/**
 * Compatibility-state computation (same adjudication as the extension-side `_shared/ext-protocol.mjs`):
 *   ok — same major (minorAhead=true when the extension's minor is above the host's) / stale / incompatible /
 *   too_new / missing / invalid.
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
    return { ...base, state: "missing", needsUpgrade: true, upgradeRefs: extProtocolUpgradeRefs(declared, opts), detail: "no protocol version declared (legacy)" };
  }
  const d = parseExtProtocol(declared);
  if (!d) {
    return { ...base, state: "invalid", needsUpgrade: true, upgradeRefs: extProtocolUpgradeRefs(declared, opts), detail: 'declaration must be a "MAJOR.MINOR" string' };
  }
  if (d.major > current.major) {
    return { ...base, state: "too_new", detail: `extension declares protocol ${d.raw}, newer than host ${current.raw} — upgrade the host` };
  }
  if (d.major < minMajor) {
    return { ...base, state: "incompatible", needsUpgrade: true, upgradeRefs: extProtocolUpgradeRefs(declared, opts), detail: `declared ${d.raw} is below the host minimum supported ${minSupported}` };
  }
  if (d.major < current.major) {
    return { ...base, state: "stale", needsUpgrade: true, upgradeRefs: extProtocolUpgradeRefs(declared, opts), detail: `declared ${d.raw} is behind current ${current.raw}` };
  }
  const minorAhead = d.minor > current.minor;
  return {
    ...base,
    state: "ok",
    minorAhead,
    detail: minorAhead ? `extension uses new capabilities from ${d.raw} (host ${current.raw}) — upgrading the host enables them` : undefined,
  };
}

/** States blocked under strict mode (PI_WEB_EXT_PROTOCOL_STRICT=1); stale is not included (the host keeps a compatibility layer). */
export const EXT_PROTOCOL_STRICT_BLOCKED: ExtProtocolState[] = ["incompatible", "missing", "invalid", "too_new"];
