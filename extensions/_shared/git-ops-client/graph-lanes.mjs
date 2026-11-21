/**
 * git-ops-client · git log --graph ASCII art → per-row lane geometry (pure, no DOM).
 *
 * Graph view data layer (dsh-better-sidebar borrow plan §2.1): the engine already emits
 * `--graph --oneline --date-order --decorate=short` lines; we decode git's own layout
 * instead of re-deriving it. Lane grid = 1 char per half-lane (git lanes are 2 chars wide),
 * so a `\` drawn at index i connects lane column (i-1) above to (i+1) below, and `/`
 * connects (i+1) above to (i-1) below. Renderer draws one SVG per row; consecutive rows
 * connect seamlessly because every row draws its own full-height verticals.
 *
 * Lane ids are cosmetic (edge/node coloring only): a `*` node inherits the pipe lane
 * above it; `\` opens a new lane; `/` keeps the collapsing lane's color unless a pipe
 * already owns that column (merge junctions must stay on the main lane's color).
 */

// Graph-art characters git can emit (anything else means the line is not graph art).
const GRAPH_CHARS = new Set(["*", "|", "\\", "/", "-", "_", ".", " "]);

const SHA_RE = /[0-9a-f]{7,40}/;

/** Decorations look like refs: `HEAD -> main`, `origin/x`, `tag: v1`, `HEAD`. */
function looksLikeRef(part) {
  if (part === "HEAD") return true;
  if (part.startsWith("tag:")) return true;
  if (part.startsWith("HEAD ->")) return true;
  return /^[\w.-]+\/?[\w./-]*$/.test(part) && /[\w._-]/.test(part);
}

/**
 * Parse one log line into { graph, sha, refs, subject } | null.
 * `graph` keeps the ASCII prefix (trimmed of trailing blanks); continuation rows
 * (bare `|\` / `|/` art without a commit) return with sha=null and subject="".
 * Returns null for lines that carry no graph prefix at all (defensive; --graph output
 * always has one, but octopus corner cases may surprise us — caller falls back to raw text).
 */
export function parseGraphRow(line) {
  if (typeof line !== "string") return null;
  // Find the sha: first 7-40 hex run that sits after a graph-art prefix.
  const m = /^([\s|\\/.*_-]*)([0-9a-f]{7,40})(?:[ ]+\(([^)]*)\))?(?:[ ](.*))?$/.exec(line);
  if (!m) {
    // No sha → continuation row; keep it only if it is really graph art.
    const art = line.replace(/\s+$/, "");
    if (!art || ![...art].every((c) => GRAPH_CHARS.has(c))) return null;
    return { graph: art, sha: null, refs: [], subject: "" };
  }
  let [, prefix, sha, deco, subject] = m;
  // Guard: a subject that merely starts with "(...)" must not become a ref badge.
  if (deco !== undefined) {
    const parts = deco.split(",").map((s) => s.trim());
    if (parts.length === 0 || parts.some((s) => !looksLikeRef(s))) {
      subject = (deco + " " + (subject ?? "")).trim();
      deco = undefined;
    }
  }
  const refs = deco === undefined ? [] : deco.split(",").map((s) => s.trim()).filter(Boolean);
  return { graph: prefix.replace(/\s+$/, ""), sha, refs, subject: (subject ?? "").trimEnd() };
}

/** Parse a whole page of log lines; unparseable lines come back as { raw } rows. */
export function parseGraphRows(lines) {
  const rows = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const row = parseGraphRow(line);
    rows.push(row ?? { raw: String(line) });
  }
  return rows;
}

/**
 * Assign lane ids per row. Returns rows with:
 *  - lanes: Array<[col, laneId]> vertical continuity map of this row,
 *  - prevLanes: same map of the row above (edge coloring: a `/` merge edge keeps
 *    the collapsing lane's color, a `\` branch edge takes the new branch's color),
 *  - nodeCol / nodeLane: where the `*` sits (or -1/-1 on continuation rows).
 */
export function assignLanes(rows) {
  let lanesAbove = new Map();
  let nextLane = 0;
  return rows.map((row) => {
    if (row.raw !== undefined) return { ...row, lanes: [], prevLanes: [], nodeCol: -1, nodeLane: -1 };
    const above = lanesAbove;
    const lanes = new Map();
    let nodeCol = -1;
    let nodeLane = -1;
    const g = row.graph;
    for (let i = 0; i < g.length; i++) {
      const ch = g[i];
      if (ch === "*" || ch === "|") {
        const id = above.get(i) ?? lanes.get(i) ?? nextLane++;
        lanes.set(i, id);
        if (ch === "*") { nodeCol = i; nodeLane = id; }
      } else if (ch === "\\") {
        // Branch-out edge: the new branch line below gets its own color.
        if (!lanes.has(i + 1)) lanes.set(i + 1, nextLane++);
      } else if (ch === "/") {
        // Merge-in edge: collapsing lane keeps its color, unless a pipe owns the target column.
        const id = above.get(i + 1) ?? nextLane++;
        if (!lanes.has(i - 1)) lanes.set(i - 1, id);
      }
    }
    lanesAbove = lanes;
    return { ...row, lanes: [...lanes.entries()], prevLanes: [...above.entries()], nodeCol, nodeLane };
  });
}

/** Palette derived from host CSS vars only (theme hard rule: no raw color values). */
export const LANE_COLORS = [
  "var(--accent)",
  "color-mix(in srgb, var(--ok, var(--accent)) 65%, var(--text-muted))",
  "color-mix(in srgb, var(--danger, var(--text-muted)) 60%, var(--text-muted))",
  "color-mix(in srgb, var(--accent) 45%, var(--text-dim))",
  "color-mix(in srgb, var(--accent) 70%, var(--text-muted))",
  "var(--text-dim)",
];

export function laneColor(laneId) {
  return LANE_COLORS[Math.abs(laneId) % LANE_COLORS.length];
}
