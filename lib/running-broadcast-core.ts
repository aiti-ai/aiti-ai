/**
 * Pure-function core of the running broadcast (zero dependencies).
 *
 * Why a separate file: lib/running-broadcast.ts depends on heavyweight modules
 * such as rpc-manager (which uses TS parameter-property syntax, unloadable by
 * node --experimental-strip-types) — the functional tests need directly loadable
 * pure functions. Merge/key logic lives here; wiring regression is covered by
 * the source-scan in lib/running-broadcast.test.mjs.
 */

/** Union of the multi-source running sets (deduplicated; rpc local + handle backends + unclaimed TUI bridges). */
export function mergeRunningIds(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

/** Content key of a running-set frame (set semantics: sort + newline join; empty set = ""). */
export function runningFrameKey(ids: string[]): string {
  return [...ids].sort().join("\n");
}
