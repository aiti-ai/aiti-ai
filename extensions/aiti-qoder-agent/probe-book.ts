/**
 * probe-book — the generic probe ledger behind the qoder backend's evidence-gated
 * capabilities (steer injection, context compaction).
 *
 * A capability that no code path can prove stays OFF until a real run left
 * `verdict:"pass"` evidence for THIS CLI binary AND THIS driver. The two
 * capability-specific façades (steer-gate.ts, compact-gate.ts) hold their own
 * ledger file and wording; everything about parsing / merging / lookup order
 * lives here once, so both gates fail the same way.
 *
 * Ledger shape: `{ probes: { "<canonical CLI path>": { verdict, driver,
 * cliVersion, at, evidence } } }`.
 *
 * Key = canonical (realpath) path of the CLI binary. PATH entries are usually
 * symlinks into versioned files (`~/.local/bin/qoderclicn` -> `qodercli-1.1.83`),
 * so an upgrade repoints the link: without canonicalisation the evidence of the
 * old binary would be silently inherited by a version nobody probed.
 *
 * Fail-closed by construction: missing file / broken JSON / unknown verdict all
 * parse to `{}` (= no evidence = capability off). No dirty data can open a gate.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProbeVerdict = "pass" | "fail" | "blocked";

/** Which driver the evidence belongs to. Evidence of one driver never opens another. */
export type ProbeDriver = "stream-json" | "acp";

export interface ProbeRecord {
  verdict: ProbeVerdict;
  /** The driver this conclusion was reached on; a record without it (legacy book) opens nothing. */
  driver?: ProbeDriver;
  /** CLI `--version` output (human traceability; the gate itself only keys on path + driver). */
  cliVersion?: string;
  /** ISO timestamp of the probe run. */
  at?: string;
  /** Criteria detail (C0/C1/... evidence written by the probe script). */
  evidence?: Record<string, unknown>;
}

export type ProbeBook = Record<string, ProbeRecord>;

/** Ledger file path inside a capability's state dir (e.g. `<stateDir>/steer-probe.json`). */
export function probeBookPath(stateDir: string, fileName: string): string {
  return join(stateDir, fileName);
}

/**
 * Fallback state dir for tool-side scripts (no extension ctx): same convention as
 * the extension's `extDataDir()` — `PI_WEB_DATA_DIR` first, else `~/.pi/web/data`.
 * Both local instances share one data root.
 */
export function defaultProbeStateDir(home = homedir()): string {
  const root = process.env.PI_WEB_DATA_DIR || join(home, ".pi", "web", "data");
  return join(root, "aiti-qoder-agent", "state");
}

/**
 * Lenient parse: missing file / broken JSON / wrong shape -> empty book. Accepts
 * both on-disk forms: `{probes:{...}}` (wrapped, easier to hand-edit) and a bare map.
 */
export function parseProbeBook(text: string | null | undefined): ProbeBook {
  if (!text) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const inner = obj.probes && typeof obj.probes === "object"
    ? (obj.probes as Record<string, unknown>)
    : obj;
  const book: ProbeBook = {};
  for (const [cliPath, rec] of Object.entries(inner)) {
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    const verdict = r.verdict;
    if (verdict !== "pass" && verdict !== "fail" && verdict !== "blocked") continue;
    const driver = r.driver;
    book[cliPath] = {
      verdict,
      ...(driver === "stream-json" || driver === "acp" ? { driver } : {}),
      ...(typeof r.cliVersion === "string" ? { cliVersion: r.cliVersion } : {}),
      ...(typeof r.at === "string" ? { at: r.at } : {}),
      ...(r.evidence && typeof r.evidence === "object" ? { evidence: r.evidence as Record<string, unknown> } : {}),
    };
  }
  return book;
}

/**
 * Evidence key: the canonical (realpath) CLI path. Falls back to the raw path when
 * realpath fails (missing/permission) — fail-closed, since a lookup then finds no
 * pass record.
 */
export function canonicalCliKey(cliPath: string | null | undefined): string {
  if (!cliPath) return "";
  try {
    return realpathSync(cliPath);
  } catch {
    return cliPath;
  }
}

/** The only open condition: a pass record for this binary on this driver (fail/blocked/missing/other driver = off). */
export function probePassed(
  book: ProbeBook | null | undefined,
  cliPath: string | null | undefined,
  driver: ProbeDriver,
): boolean {
  if (!book || !cliPath) return false;
  const rec = book[canonicalCliKey(cliPath)];
  return rec?.verdict === "pass" && rec.driver === driver;
}

/** Merge one conclusion (overwrites the same binary's older record; fail/blocked are kept too — a pass can be withdrawn). */
export function mergeProbeRecord(book: ProbeBook, cliPath: string, record: ProbeRecord): ProbeBook {
  return { ...book, [canonicalCliKey(cliPath)]: { ...record } };
}

/** Base capability table + one gate result (only the named capability moves; the rest is untouched). */
export function withCapabilityGate<T extends Record<string, boolean>>(
  base: T,
  capability: string,
  enabled: boolean,
): T {
  if (base[capability] === enabled) return base;
  return { ...base, [capability]: enabled } as T;
}

/** One-line human-readable gate state (startup log / probe output share the wording). */
export function describeProbeGate(
  book: ProbeBook,
  cliPath: string | null | undefined,
  driver: ProbeDriver | undefined,
  capability: string,
): string {
  const tag = driver ? `${driver} ` : "";
  if (!cliPath) return `${capability}=off（未解析到 CLI 路径）`;
  const rec = book[canonicalCliKey(cliPath)];
  if (!rec) return `${capability}=off（${cliPath} 无探针记录）`;
  if (rec.verdict === "pass" && (!driver || rec.driver === driver)) return `${capability}=on（${tag}探针 pass @${rec.at ?? "?"}）`;
  if (rec.verdict === "pass") return `${capability}=off（探针 pass 属于 ${rec.driver ?? "旧驱动"}，不是 ${driver} @${rec.at ?? "?"}）`;
  return `${capability}=off（${tag}探针 ${rec.verdict} @${rec.at ?? "?"}）`;
}

/**
 * Evidence freshness: the gate key is the CLI *path*, and PATH entries are often
 * symlinks into versioned files. In-place replacement (a Windows updater
 * overwriting `qoderclicn.exe`) keeps the key but the evidence belongs to the old
 * version — the CLI reports its own version at session start, so a mismatch yields
 * a re-run hint. Hint only, never a live capability revoke: the table was already
 * published to the host when the session was created, and changing it mid-session
 * would desync the frontend button from the backend behaviour.
 */
export function probeEvidenceStale(
  book: ProbeBook,
  cliPath: string,
  reportedVersion: string,
  driver: ProbeDriver,
  capability: string,
  probeScript: string,
): string | null {
  const want = book[canonicalCliKey(cliPath)]?.cliVersion;
  if (!want || !reportedVersion || want === reportedVersion) return null;
  return `${capability} 探针记录版本 ${want} ≠ 本轮 CLI ${reportedVersion}（${cliPath}）→ 重跑 ${probeScript} --record`;
}
