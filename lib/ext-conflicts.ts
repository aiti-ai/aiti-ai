/**
 * ext-conflicts — the generic "conflicting plugin" disable mechanism.
 *
 * Extensions declare, in their manifest (PiWebExtension.conflicts), third-party
 * extension/package identifiers that conflict with their functionality and must be disabled;
 * when the platform assembles the SDK extension loading result (LoadExtensionsResult), any
 * extension whose identifier matches is removed entirely (not initialized).
 *
 * Typical use case (the subagents extension): it declares conflicts: ["pi-subagents"] — the
 * upstream pi-subagents package a user installs manually and the platform's bundled fork both
 * register subagent tools under the same names, a double-registration conflict; the fork is a
 * complete drop-in replacement, so the upstream package is always disabled.
 *
 * Matching rules (conservative, avoids false positives):
 *   - Identifiers are compared exactly against the SDK extension's **npm package name**
 *     (full scoped name, e.g. "@scope/fork-pkg" ≠ "fork-pkg");
 *   - Only extensions with a resolvable source participate in matching (locally
 *     path-installed extensions without a source are not covered for now);
 *   - Declarers live in the pi-web extension system, naturally isolated from the SDK loading
 *     result, so there is no self-consumption problem.
 * No polling: called only on the extension-load-result assembly path (session creation).
 */

import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

/** Minimal registry shape (dependency-injected; the real implementation is ExtRegistryImpl in lib/ext/registry). */
export interface ConflictsRegistryProbe {
  all(): Array<{ ext: { conflicts?: string[] } }>;
}

/** Parse the package name from an npm/git style source: "npm:@scope/name@1.2" → "@scope/name"; "git:foo" → "foo". */
export function sourcePackageName(source: string): string {
  let s = source.replace(/^[a-z]+:/i, "");
  s = s.split("#")[0];
  if (s.startsWith("@")) {
    const at = s.indexOf("@", 1);
    return at === -1 ? s : s.slice(0, at);
  }
  const at = s.indexOf("@");
  return at === -1 ? s : s.slice(0, at);
}

/** Scoped package name within a path ("…/node_modules/@scope/name/…" → "@scope/name"); null if none. */
export function pathScopedPackageName(path: string): string | null {
  const segments = path.replaceAll("\\", "/").split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].startsWith("@") && segments[i + 1]) return `${segments[i]}/${segments[i + 1]}`;
  }
  return null;
}

/** Collect conflict identifiers declared by all loaded pi-web extensions (deduplicated, order-preserving). */
export function collectExtensionConflicts(registry: ConflictsRegistryProbe): string[] {
  const out: string[] = [];
  try {
    for (const loaded of registry.all()) {
      for (const c of loaded.ext.conflicts ?? []) {
        const id = String(c ?? "").trim();
        if (id && !out.includes(id)) out.push(id);
      }
    }
  } catch { /* registry unavailable → no conflict declarations */ }
  return out;
}

/**
 * Disable extensions declared as conflicting when assembling the SDK extension loading result.
 * @param base  SDK extension loading result
 * @param registry  pi-web extension registry (source of declarations); returned as-is when unavailable
 */
export function disableConflictingExtensions(
  base: LoadExtensionsResult,
  registry?: ConflictsRegistryProbe,
): LoadExtensionsResult {
  if (!registry) return base;
  const conflicts = collectExtensionConflicts(registry);
  if (conflicts.length === 0) return base;

  const blocked = (extension: LoadExtensionsResult["extensions"][number]): boolean => {
    const viaSource = sourcePackageName(extension.sourceInfo?.source ?? "");
    if (viaSource && conflicts.includes(viaSource)) return true;
    const viaPath = pathScopedPackageName(extension.resolvedPath ?? extension.path ?? "");
    if (viaPath && conflicts.includes(viaPath)) return true;
    return false;
  };

  const removed = new Set<string>();
  for (const extension of base.extensions) {
    if (blocked(extension)) removed.add(extension.path);
  }
  if (removed.size === 0) return base;

  return {
    ...base,
    extensions: base.extensions.filter((extension) => !removed.has(extension.path)),
    errors: base.errors.filter((error) => !removed.has(error.path)),
  };
}
