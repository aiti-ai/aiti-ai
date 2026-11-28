/**
 * aiti-channels · bot-edit — surgical TOML text edits for fields cc-connect's
 * management API does not expose. Today: card_mode (reply granularity,
 * config/config.go:196 — "legacy" default | "rich" = Feishu Card 2.0 streaming
 * cards). Everything else goes through the management API; this module is the
 * ONLY local config writer besides config-gen (full regeneration).
 *
 * Scopes (config/config.go EffectiveCardMode — per-project overrides global):
 *   global   [display] card_mode = ...
 *   project  [[projects]] name="<p>" → [projects.display] card_mode = ...
 *
 * Text-op rules (generated configs are the norm, but manual edits must survive):
 *   - never reformat untouched lines; insert real (uncommented) lines rather
 *     than uncommenting defaults
 *   - project insert goes before the first sub-table header of the block
 *     ([projects.* / [[projects.*), or at block end when none
 *   - read helpers tolerate missing sections (absent = "legacy" effective default)
 */
export type CardMode = "legacy" | "rich";

const CARD_MODE_LINE = (mode: CardMode) => `card_mode = "${mode}"`;

/** Parse the effective card_mode landscape from raw TOML text. */
export function readCardModes(raw: string): { global: CardMode | null; byProject: Record<string, CardMode> } {
  const out: { global: CardMode | null; byProject: Record<string, CardMode> } = { global: null, byProject: {} };
  const lines = raw.split("\n");
  let section = ""; // "" | "display" | "project" | "project-display" | "other"
  let currentProject: string | null = null;
  let inProjectDisplay = false;
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    const header = line.match(/^\[+\s*([^\]\s]+)\s*\]+/); // [display] / [[projects]] / [projects.display] / [projects.platforms]...
    if (header) {
      const path = header[1];
      if (path === "display") { section = "display"; inProjectDisplay = false; continue; }
      if (path === "projects") { section = "project"; currentProject = null; inProjectDisplay = false; continue; }
      if (path === "projects.display") { section = "other"; inProjectDisplay = true; continue; }
      section = "other"; inProjectDisplay = false; continue;
    }
    if (section === "project") {
      const nm = line.match(/^name\s*=\s*"([^"]*)"/);
      if (nm) currentProject = nm[1];
    }
    const kv = line.match(/^card_mode\s*=\s*"(legacy|rich)"/);
    if (!kv) continue;
    const mode = kv[1] as CardMode;
    if (section === "display") out.global = mode;
    else if (inProjectDisplay && currentProject) out.byProject[currentProject] = mode;
  }
  return out;
}

/** Split raw TOML into [[projects]] block spans: [start, endExclusive) line
 *  indexes covering the header line plus its sub-tables. The projects family
 *  headers ([projects.display] / [[projects.platforms]] / ...) belong to the
 *  LAST [[projects]] element (TOML array-of-tables semantics), so only a
 *  header OUTSIDE the family (next [[projects]] / [display] / ...) ends a block. */
function projectBlockSpans(lines: string[]): Array<{ start: number; end: number; name: string | null }> {
  const spans: Array<{ start: number; end: number; name: string | null }> = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\[\[\s*projects\s*\]\]/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length) {
        if (!/^\s*\[/.test(lines[j])) { j++; continue; } // not a header line
        if (/^\s*\[?\[?\s*projects\./.test(lines[j])) { j++; continue; } // dotted sub-table (projects.*) → still ours
        break; // [[projects]] (new array element) or foreign header → block ends
      }
      const body = lines.slice(i, j).join("\n");
      const nm = body.match(/\bname\s*=\s*"([^"]*)"/);
      spans.push({ start: i, end: j, name: nm ? nm[1] : null });
      i = j;
    } else i++;
  }
  return spans;
}

/**
 * Set card_mode. project=null → global [display]; otherwise the [[projects]]
 * block with that name (creates [projects.display] sub-table when absent).
 * Returns the new raw text (same string when nothing to do) + scope description.
 * Throws when the target project block does not exist.
 */
export function setCardMode(raw: string, mode: CardMode, project?: string | null): { raw: string; scope: string } {
  const lines = raw.split("\n");
  if (project) {
    const spans = projectBlockSpans(lines);
    const hit = spans.find((s) => s.name === project);
    if (!hit) throw new Error(`project block not found in config.toml: ${project}`);
    // Locate an existing [projects.display] sub-table inside the block
    let dispStart = -1;
    let dispEnd = -1;
    for (let i = hit.start + 1; i < hit.end; i++) {
      if (/^\s*\[\s*projects\.display\s*\]/.test(lines[i])) { dispStart = i; dispEnd = i + 1; break; }
    }
    if (dispStart >= 0) {
      // extend dispEnd across the sub-table body (until next header or block end)
      dispEnd = dispStart + 1;
      while (dispEnd < hit.end && !/^\s*\[/.test(lines[dispEnd])) dispEnd++;
      for (let i = dispStart + 1; i < dispEnd; i++) {
        if (/^\s*card_mode\s*=/.test(lines[i])) { lines[i] = CARD_MODE_LINE(mode); return { raw: lines.join("\n"), scope: `project:${project}` }; }
      }
      lines.splice(dispEnd, 0, CARD_MODE_LINE(mode));
      return { raw: lines.join("\n"), scope: `project:${project}` };
    }
    // Insert a [projects.display] sub-table: before the block's first sub-table
    // header ([projects.* / [[projects.*), else at block end.
    let insertAt = hit.end;
    for (let i = hit.start + 1; i < hit.end; i++) {
      if (/^\s*\[?\[?\s*projects\./.test(lines[i])) { insertAt = i; break; }
    }
    lines.splice(insertAt, 0, "[projects.display]", CARD_MODE_LINE(mode), "");
    return { raw: lines.join("\n"), scope: `project:${project}` };
  }

  // Global scope: [display] section
  let dispStart = -1;
  let dispEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[\s*display\s*\]/.test(lines[i])) {
      dispStart = i;
      dispEnd = i + 1;
      while (dispEnd < lines.length && !/^\s*\[/.test(lines[dispEnd])) dispEnd++;
      break;
    }
  }
  if (dispStart < 0) {
    // No [display] section: append one at EOF
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push("[display]", CARD_MODE_LINE(mode), "");
    return { raw: lines.join("\n"), scope: "global" };
  }
  for (let i = dispStart + 1; i < dispEnd; i++) {
    if (/^\s*card_mode\s*=/.test(lines[i])) { lines[i] = CARD_MODE_LINE(mode); return { raw: lines.join("\n"), scope: "global" }; }
  }
  lines.splice(dispEnd, 0, CARD_MODE_LINE(mode));
  return { raw: lines.join("\n"), scope: "global" };
}
