/**
 * compact-gate — evidence gate for the Qoder backend's manual context-compaction
 * capability (`compact`).
 *
 * Why a gate at all: ACP has no `session/compact` method. The only channel is the
 * CLI's own interactive slash command, sent as a normal `session/prompt` whose
 * text is `/compact`. qodercli 1.1.83 answers that prompt over ACP with
 *
 *     Command /compact requires interactive UI and is not available in ACP.
 *
 * (probe 2026-11-24, exit in 1.7s without any model turn; the CLI's
 * `available_commands_update` frame lists 26 slash commands and none of them is
 * `compact`.) So the host's Compact button must stay hidden — a fake button that
 * only prints a refusal is worse than no button.
 *
 * Opening rule: exactly the same discipline as steer (probe-book.ts) — a
 * `verdict:"pass"` record for THIS CLI binary on the `acp` driver, written by
 * `node tools/compact-probe-acp.mjs --record`. A CLI upgrade that repoints the
 * symlink changes the key, so the gate closes until the probe is re-run; when the
 * vendor does expose compaction over ACP, the probe starts passing and the
 * capability lights up without a code change.
 *
 * The ledger is a separate file from steer's (`compact-probe.json` vs
 * `steer-probe.json`): the two capabilities are verified by different probes, so
 * one must never inherit the other's evidence.
 */
import {
  defaultProbeStateDir,
  describeProbeGate,
  mergeProbeRecord,
  parseProbeBook,
  probeBookPath,
  probeEvidenceStale,
  probePassed,
  withCapabilityGate,
  type ProbeBook,
  type ProbeRecord,
} from "./probe-book.ts";

/** Ledger file (state dir root, next to steer-probe.json / queues / task-lists). */
export const COMPACT_PROBE_FILE = "compact-probe.json";

/** Key = canonical CLI path, value = newest conclusion of `tools/compact-probe-acp.mjs`. */
export type CompactProbeBook = ProbeBook;

export function compactProbePath(stateDir: string): string {
  return probeBookPath(stateDir, COMPACT_PROBE_FILE);
}

/** Tool-side state dir fallback (probe scripts have no extension ctx). */
export const defaultCompactStateDir = defaultProbeStateDir;

/** Lenient parse: anything unusable collapses to `{}` = no evidence = gate closed. */
export const parseCompactProbeBook = parseProbeBook;

/** Only open condition: pass for this binary on the ACP driver. */
export function compactProbePassed(book: CompactProbeBook | null | undefined, cliPath: string | null | undefined): boolean {
  return probePassed(book, cliPath, "acp");
}

/** Merge one conclusion (overwrites the same binary's older record, pass included). */
export const mergeCompactProbeRecord = mergeProbeRecord;

/** Base capability table + gate result (only `compact` moves). */
export function withCompactGate<T extends Record<string, boolean>>(base: T, enabled: boolean): T {
  return withCapabilityGate(base, "compact", enabled);
}

/** One-line human-readable gate state (startup log / probe output share the wording). */
export function describeCompactGate(book: CompactProbeBook, cliPath: string | null): string {
  return describeProbeGate(book, cliPath, "acp", "compact");
}

/** Version freshness hint (in-place binary replacement keeps the path key): hint only, never revoke live. */
export function compactEvidenceStale(
  book: CompactProbeBook,
  cliPath: string,
  reportedVersion: string,
): string | null {
  return probeEvidenceStale(book, cliPath, reportedVersion, "acp", "compact", "tools/compact-probe-acp.mjs");
}

export type { ProbeRecord as CompactProbeRecord };
