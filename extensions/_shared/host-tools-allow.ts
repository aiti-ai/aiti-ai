/**
 * G1 host tools allowlist (docs/pi-web-ext-host-tools-gate-plan.md §G1)
 *
 * Background: the bridge MCP's `aiti_*` tools were injected into external agents with zero filtering
 * via wireBridgeHostTools (omp) / aiti_bridge_req forwarding (attach) — one prompt-injection hop
 * reaches high-risk tools such as page execution / form writes.
 * G1 = by default only the read-only + human-in-the-loop subset is allowed; `*` (or "all") = everything
 * (= the old status quo); an explicit list = the exact set.
 *
 * Consumers: aiti-omp-agent/host-tools-bridge.ts (tools/list filtering), aiti-attach-agent/index.ts
 * (aiti_bridge_req forwarding check). Feature: `<extId>.hostToolsAllow` (string; default empty = the
 * readonly subset).
 */

/** Default read-only / human-in-the-loop subset (no page-data side effects; write-class page_exec/form_fill excluded by default) */
export const HOST_TOOLS_READONLY_NAMES: readonly string[] = [
  "aiti_inbox",       // main message-channel fetch (G1 red line: a conservative list must include inbox reads)
  "aiti_hello",       // agent self-introduction/registration
  "bridge_status",    // connected-page snapshot
  "page_snapshot",    // page live reading
  "self_ui",          // dialog/form inventory scan
  "page_logs",        // console log reading
  "page_network",     // network settled-state reading
  "file_stat",        // file metadata query
  "user_pick_element", // human point-and-pick (human in the loop, no data side effects)
  "user_confirm",
  "user_choose",
  "user_input",
  "user_presence",
  "user_notify",
];

const READONLY = new Set<string>(HOST_TOOLS_READONLY_NAMES);

export type HostToolsAllow = "all" | "readonly" | Set<string>;

/** Parse a feature value: empty/"readonly" -> read-only subset; "*"/"all" -> everything; otherwise = an explicit comma/whitespace-separated list */
export function parseHostToolsAllow(value: string | null | undefined): HostToolsAllow {
  const v = String(value ?? "").trim();
  if (!v || v === "readonly") return "readonly";
  if (v === "*" || v === "all") return "all";
  const names = v.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  return names.length ? new Set(names) : "readonly";
}

/** Filter a tool list by the allowlist (used by omp tools/list) */
export function filterHostToolsByAllow<T extends { name: string }>(tools: T[], allow: HostToolsAllow): T[] {
  if (allow === "all") return tools;
  if (allow === "readonly") return tools.filter((t) => READONLY.has(t.name));
  return tools.filter((t) => allow.has(t.name));
}

/** Single-tool decision (used by the attach aiti_bridge_req forwarding check) */
export function hostToolAllowed(name: string, allow: HostToolsAllow): boolean {
  if (allow === "all") return true;
  if (allow === "readonly") return READONLY.has(name);
  return allow.has(name);
}

/** Read the extman feature `<extId>.hostToolsAllow` (at runtime via the host featureValue; absent = the default read-only subset) */
export function readHostToolsAllow(extId: string): string | null {
  try {
    const reg = (globalThis as { __piWebExt?: { featureValue?: (extId: string, fid: string) => boolean | string } }).__piWebExt;
    const v = reg?.featureValue?.(extId, "hostToolsAllow");
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v === true) return "*";
  } catch { /* host absent: treat as default */ }
  return null;
}

/** extman feature declaration (each consumer extension appends it to its features array; pass a group name like "Omp") */
export function hostToolsAllowFeature(group?: string): {
  id: string; type: "string"; label: string; description: string; value: string; placeholder: string; group?: string;
} {
  return {
    id: "hostToolsAllow",
    ...(group ? { group } : {}),
    type: "string",
    label: "Bridge tool allowlist",
    description:
      "Allowlist of the bridge (aiti_*) tools injected into the agent. Empty = read-only subset (messages / page reads / " +
      "human-in-the-loop; write-class tools such as page_exec and form_fill are withheld — the G1 secure default). " +
      "* = everything (restores the old status quo, including page execution / form writes). A precise list also works " +
      "(comma/space separated, e.g. aiti_inbox, page_exec). Tools outside the list make the agent's call fail with " +
      "unknown host tool; takes effect on the next session turn.",
    value: "",
    placeholder: "empty=read-only subset; *=everything; or aiti_inbox, page_snapshot, page_exec",
  };
}

/**
 * English `ui.i18n.en` entries for the hostToolsAllow feature above.
 *
 * Shared by every consumer (omp / attach-agent …) so the label and the long G1 security note
 * stay in one place:
 *   `ui: { i18n: { en: { ...hostToolsAllowFeatureI18nEn(), … } } }`
 */
export function hostToolsAllowFeatureI18nEn(): Record<string, string> {
  return {
    "feat.hostToolsAllow": "Bridge tool allowlist",
    "feat.hostToolsAllow.desc":
      "Allowlist of bridge (aiti_*) tools injected into the agent. Empty = read-only subset (messages / page reads / " +
      "human-in-the-loop; write-class tools such as page_exec and form_fill are withheld — G1 secure default). " +
      "* = everything (restores the old behavior, including page execution and form writes). A precise list also works " +
      "(comma/space separated, e.g. aiti_inbox, page_exec). Tools outside the list make the agent's call fail with " +
      "unknown host tool; takes effect on the next session.",
  };
}
