/**
 * aiti-proc-tree · core.cjs — pure logic shared by the server and the client bundle.
 *
 * Zero dependencies and zero I/O so `node --test` can cover the tricky parts:
 * - Linux /proc stat parsing + CPU delta math
 * - env ownership markers (AITI_PROC_TREE_*, PI_SUBAGENT_*, SERVICE_TUNNELS_*)
 * - registry row normalization (cmd-host / agent-starter / bridge / tunnels / subagents)
 * - logical tree merging (real ppid graph + registry roots)
 * - kill planning (uid / protected pids / subtree collection)
 * - display formatters
 *
 * All comments are English (public-surface language rule).
 */

"use strict";

// ---------------------------------------------------------------- linux proc

/**
 * Parse one `/proc/<pid>/stat` line.
 * Fields after the last ")" are: state ppid pgrp session tty_nr tpgid flags
 * minflt cminflt majflt cmajflt utime stime cutime cstime ... starttime.
 * Returns null when the line is malformed.
 */
function parseLinuxStat(line) {
  if (typeof line !== "string" || !line) return null;
  const close = line.lastIndexOf(")");
  if (close < 0) return null;
  const pid = Number(line.slice(0, line.indexOf(" ")));
  const rest = line.slice(close + 2).trim().split(/\s+/);
  if (!Number.isFinite(pid) || rest.length < 20) return null;
  return {
    pid,
    state: rest[0] || "?",
    ppid: Number(rest[1]) || 0,
    utime: Number(rest[11]) || 0,
    stime: Number(rest[12]) || 0,
    starttime: Number(rest[19]) || 0,
  };
}

/**
 * CPU percent for one process between two tick samples.
 * `prev`/`cur` are `{utime, stime}` in clock ticks; dtMs is the wall-clock
 * window. First tick (no prev) or non-positive window returns null.
 * 100 = one full core; multi-threaded processes can exceed 100.
 */
function cpuPercent(prev, cur, dtMs, clkTck) {
  if (!prev || !cur) return null;
  const hz = Number(clkTck) > 0 ? Number(clkTck) : 100;
  const dt = Number(dtMs);
  if (!Number.isFinite(dt) || dt <= 0) return null;
  const delta = (Number(cur.utime) + Number(cur.stime)) - (Number(prev.utime) + Number(prev.stime));
  if (!Number.isFinite(delta) || delta < 0) return null;
  return Math.round((delta / (dt / 1000 * hz)) * 1000) / 10;
}

/** Parse a NUL-separated /proc/<pid>/environ buffer into a plain object. */
function parseEnviron(text) {
  const out = {};
  if (typeof text !== "string" || !text) return out;
  for (const part of text.split("\0")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/**
 * Ownership markers carried by process env. This is the fallback channel when
 * a registry entry is missing (detached/reparented processes keep their env).
 * Returns null when no marker is present.
 */
function parseEnvMarkers(envText) {
  const env = typeof envText === "string" ? parseEnviron(envText) : (envText || {});
  const owner = env.AITI_PROC_TREE_OWNER || "";
  const kind = env.AITI_PROC_TREE_KIND || "";
  const id = env.AITI_PROC_TREE_ID || "";
  const label = env.AITI_PROC_TREE_LABEL || "";
  const instancePid = Number(env.AITI_PROC_TREE_INSTANCE) || 0;
  const parentPid = Number(env.AITI_PROC_TREE_PARENT) || 0;
  const subagentChild = env.PI_SUBAGENT_CHILD === "1";
  const runnerPid = Number(env.PI_SUBAGENT_RUNNER_PID) || 0;
  const parentSession = env.PI_SUBAGENT_PARENT_SESSION || "";
  const tunnelRole = env.SERVICE_TUNNELS_ROLE || "";
  const tunnelMarker = env.SERVICE_TUNNELS_MARKER || "";
  if (!owner && !kind && !subagentChild && !runnerPid && !tunnelRole) return null;
  if (owner) return { owner, kind: kind || "external", id, label, instancePid, parentPid };
  if (subagentChild || runnerPid) {
    return {
      owner: "pi-subagents",
      kind: "subagent",
      id: parentSession,
      label: label || "subagent",
      instancePid,
      parentPid: parentPid || runnerPid,
    };
  }
  return {
    owner: "service-tunnels",
    kind: tunnelRole === "tunnel" ? "tunnel" : "helper",
    id: tunnelMarker || tunnelRole,
    label: tunnelRole || "tunnel helper",
    instancePid,
    parentPid,
  };
}

// ---------------------------------------------------------------- registries

/** Normalize every registry source into one row shape (all fields optional but pid/source). */
function normalizeRegistryRows(input) {
  const byKey = new Map();
  const push = (row) => {
    if (!row) return;
    row.pid = Number(row.pid) || 0;
    if (row.pid <= 0 && !row.virtual) return;
    const key = row.owner + ":" + (row.pid || "v:" + (row.id || "")) + ":" + (row.id || "");
    byKey.set(key, row);
  };

  const cmdHost = (input && input.cmdHost) || [];
  for (const e of cmdHost) {
    if (!e) continue;
    push({
      owner: "aiti-cmd",
      kind: "terminal",
      id: String(e.sid || ""),
      label: String(e.name || e.cmd || "shell"),
      pid: Number(e.pid || e.wrapperPid || 0),
      wrapperPid: Number(e.wrapperPid || 0) || undefined,
      cwd: e.cwd || undefined,
      source: "aiti-cmd-host",
      transport: "host",
      socket: e.socket || undefined,
      unit: e.unit || undefined,
      createdAt: Number(e.createdAt) || undefined,
      shellSource: e.source || undefined,
    });
  }

  const agentStarter = (input && input.agentStarter) || [];
  for (const e of agentStarter) {
    if (!e) continue;
    push({
      owner: "agent-starter",
      kind: "agent",
      id: String(e.sessionId || e.key || ""),
      label: String(e.agentKey || "agent") + (e.providerType ? " · " + String(e.providerType) : ""),
      pid: Number(e.pid || e.wrapperPid || 0),
      wrapperPid: Number(e.wrapperPid || 0) || undefined,
      launcherPid: Number(e.launcherPid || 0) || undefined,
      cwd: e.cwd || undefined,
      source: "agent-starter",
      transport: "host",
      socket: e.socket || undefined,
      unit: e.unit || undefined,
      createdAt: Number(e.createdAt) || undefined,
      instance: "external",
    });
  }

  const bridge = (input && input.bridge) || {};
  for (const [sessionFile, e] of Object.entries(bridge)) {
    if (!e || !Number.isFinite(Number(e.pid))) continue;
    push({
      owner: "agent-starter",
      kind: "agent",
      id: sessionFile,
      label: "TUI bridge",
      pid: Number(e.pid),
      cwd: sessionFile.includes("/") ? sessionFile.slice(0, sessionFile.lastIndexOf("/")) : undefined,
      source: "bridge-registry",
      transport: "bridge",
      socket: e.socket || undefined,
      createdAt: Number(e.startedAt) || undefined,
      instance: "external",
    });
  }

  const tunnels = (input && input.tunnels) || [];
  for (const e of tunnels) {
    if (!e) continue;
    const role = String(e.role || "tunnel");
    push({
      owner: "service-tunnels",
      kind: role === "tunnel" ? "tunnel" : "helper",
      id: role,
      label: String(e.name || role),
      pid: Number(e.pid || 0),
      parentPid: Number(e.parentPid || 0) || undefined,
      source: "service-tunnels",
      createdAt: Number(e.t) || undefined,
      url: e.url || undefined,
    });
  }

  const subagents = (input && input.subagents) || [];
  for (const e of subagents) {
    if (!e) continue;
    push({
      owner: "pi-subagents",
      kind: "subagent",
      id: String(e.runId || ""),
      label: String(e.agent || "subagent") + (e.attached ? " · attached" : ""),
      pid: Number(e.pid || 0),
      virtual: !Number(e.pid),
      cwd: e.cwd || undefined,
      source: "pi-subagents",
      createdAt: Number(e.startedAt) || undefined,
      state: e.state || undefined,
      attached: Boolean(e.attached) || !Number(e.pid),
      sessionFile: e.sessionFile || undefined,
    });
  }

  const services = (input && input.services) || [];
  for (const e of services) {
    if (!e) continue;
    const pid = Number(e.pid || e.nativePid || 0);
    push({
      owner: String(e.owner || "service"),
      kind: String(e.kind || "external"),
      id: String(e.id || e.sessionId || e.runId || ""),
      label: String(e.label || e.name || e.cmd || e.agent || e.agentKey || "session"),
      pid,
      virtual: e.virtual === true,
      wrapperPid: Number(e.wrapperPid || 0) || undefined,
      launcherPid: Number(e.launcherPid || 0) || undefined,
      cwd: e.cwd || undefined,
      source: "service:" + String(e.owner || "service"),
      transport: e.transport || undefined,
      state: e.state || undefined,
      url: e.url || undefined,
      socket: e.socket || undefined,
      attached: e.attached === true,
    });
  }

  return Array.from(byKey.values());
}

// ---------------------------------------------------------------- tree merge

function toRawMap(list) {
  const map = new Map();
  for (const p of list || []) {
    if (p && Number.isFinite(Number(p.pid))) map.set(Number(p.pid), p);
  }
  return map;
}

/** Self pid up to the pi-web CLI (inclusive). Stops before init/systemd. */
function ancestorChain(raw, selfPid, cliPid) {
  const chain = [];
  const seen = new Set();
  let cur = Number(selfPid) || 0;
  while (cur > 0 && cur !== 1 && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    if (Number(cliPid) && cur === Number(cliPid)) break;
    const p = raw.get(cur);
    if (!p) break;
    cur = p.ppid;
  }
  return chain;
}

/** All descendants of `roots` (BFS along the ppid graph), roots included. */
function descendantsOf(raw, roots) {
  const children = new Map();
  for (const p of raw.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const out = new Set();
  const queue = [];
  for (const pid of roots) {
    if (raw.has(pid) && !out.has(pid)) { out.add(pid); queue.push(pid); }
  }
  while (queue.length) {
    const pid = queue.shift();
    for (const child of children.get(pid) || []) {
      if (!out.has(child)) { out.add(child); queue.push(child); }
    }
  }
  return out;
}

/**
 * Preview of the visible set (ancestors + registry seeds + descendants).
 * The server uses it to decide which processes need detailed reads before
 * buildTree runs; buildTree computes the same set internally.
 */
function visibleSet(raw, rows, selfPid, cliPid) {
  const ancestors = ancestorChain(raw, selfPid, cliPid);
  const seeds = new Set(ancestors.filter((pid) => raw.has(pid)));
  for (const row of rows || []) {
    if (!row) continue;
    if (raw.has(row.pid)) seeds.add(row.pid);
    if (row.wrapperPid && raw.has(row.wrapperPid)) seeds.add(row.wrapperPid);
  }
  return { ancestors, seeds, visible: descendantsOf(raw, seeds) };
}

function pickRowFor(pid, rows, byPid, byWrapper) {
  if (byPid.has(pid)) return { row: byPid.get(pid), viaWrapper: false };
  if (byWrapper.has(pid)) return { row: byWrapper.get(pid), viaWrapper: true };
  return null;
}

/**
 * Merge the raw /proc graph with registry rows into display nodes.
 * Only the seed set (self + CLI ancestors + every registry pid) and its
 * descendant closure is returned: unrelated processes are never materialized.
 */
function buildTree(opts) {
  const options = opts || {};
  const raw = options.raw instanceof Map ? options.raw : toRawMap(options.raw);
  const details = options.details instanceof Map ? options.details : new Map(Object.entries(options.details || {}));
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const selfPid = Number(options.selfPid) || 0;
  const cliPid = Number(options.cliPid) || 0;
  const ancestors = new Set(
    Array.isArray(options.ancestors)
      ? options.ancestors.map(Number)
      : ancestorChain(raw, selfPid, cliPid),
  );
  const preview = visibleSet(raw, rows, selfPid, cliPid);

  const byPid = new Map();
  const byWrapper = new Map();
  for (const row of rows) {
    if (!row || !Number.isFinite(row.pid)) continue;
    if (!byPid.has(row.pid)) byPid.set(row.pid, row);
    if (row.wrapperPid && !byWrapper.has(row.wrapperPid)) byWrapper.set(row.wrapperPid, row);
  }

  // Seeds: self chain + registry rows that are alive. Registry rows whose pid
  // has vanished are skipped (stale entries stay in the registry owner's hands).
  const visible = preview.visible.size ? preview.visible : descendantsOf(raw, Array.from(ancestors).filter((pid) => raw.has(pid)));
  if (!visible.size) return { nodes: [], stats: { total: 0, cpu: 0, mem: 0, killable: 0 } };
  // Keep the registry rows themselves only when their pid is visible.
  const nodes = [];
  const nodeByPid = new Map();

  for (const pid of visible) {
    const p = raw.get(pid);
    if (!p) continue;
    const d = details.get(pid) || {};
    const picked = pickRowFor(pid, rows, byPid, byWrapper);
    const row = picked ? picked.row : null;
    const markers = d.envText ? parseEnvMarkers(d.envText) : null;

    let kind = "ext-child";
    let owner = "pi-web";
    let label = "";
    let sessionId = "";
    let instance = "self";
    let source = "";
    let transport = "";
    let url = "";
    let socket = "";
    let attached = false;

    if (pid === selfPid) {
      kind = "host";
      owner = "pi-web";
      label = "pi-web server";
      source = "host";
    } else if (pid === cliPid) {
      kind = "host";
      owner = "pi-web";
      label = "pi-web" + (options.mode ? " (" + options.mode + ")" : "");
      source = "host";
    } else if (row) {
      kind = picked && picked.viaWrapper ? "helper" : (row.kind || "external");
      owner = row.owner || "service";
      label = picked && picked.viaWrapper ? "wrapper · " + (row.label || String(pid)) : (row.label || String(pid));
      sessionId = row.id || "";
      instance = row.instance || (row.source && String(row.source).includes("agent-starter") ? "external" : "self");
      source = row.source || "registry";
      transport = row.transport || "";
      url = row.url || "";
      socket = row.socket || "";
      attached = row.attached === true;
      if (row.parentPid) d.logicalParent = row.parentPid;
    } else if (markers) {
      kind = markers.kind || "external";
      owner = markers.owner;
      label = markers.label || markers.id || String(pid);
      sessionId = markers.id || "";
      source = "env-marker";
      instance = "detached";
    } else if (ancestors.has(pid)) {
      kind = "host";
      owner = "pi-web";
      label = "pi-web host";
      source = "ancestor";
    }

    if (!label) label = d.name || d.comm || String(pid);

    // Logical parent: registry launcher wins for reparented (detached) roots,
    // otherwise the real ppid when it is part of the visible set.
    let parentPid = 0;
    const realParent = p.ppid;
    const realParentVisible = realParent && visible.has(realParent) && realParent !== pid;
    if (realParentVisible) {
      parentPid = realParent;
    } else if (row && row.launcherPid && visible.has(row.launcherPid) && row.launcherPid !== pid) {
      parentPid = row.launcherPid;
      instance = instance === "self" ? "detached" : instance;
    } else if (d.logicalParent && visible.has(d.logicalParent)) {
      parentPid = d.logicalParent;
    }
    // Detached/reparented processes (parent outside the visible set) are marked.
    if (!realParentVisible && row) instance = "detached";

    const cpu = d.cpu == null ? null : d.cpu;
    const protectedReason =
      pid === 1 ? "system"
        : pid === selfPid ? "self"
          : pid === cliPid ? "host"
            : instance === "other" ? "other-instance"
              : kind === "unknown" ? "unknown"
                : undefined;

    const node = {
      pid,
      ppid: realParent,
      parentPid,
      kind,
      owner,
      label,
      sessionId,
      cwd: d.cwd || undefined,
      user: d.user || "",
      state: p.state || d.state || "",
      cpu,
      mem: d.mem == null ? null : d.mem,
      etimeMs: d.etimeMs == null ? null : d.etimeMs,
      cmd: d.cmd || undefined,
      canKill: !protectedReason,
      protectedReason,
      instance,
      source,
      transport: transport || undefined,
      url: url || undefined,
      socket: socket || undefined,
      attached: attached || undefined,
      depth: 0,
      hasChildren: false,
    };
    nodes.push(node);
    nodeByPid.set(pid, node);
  }

  // Attached subagent runs live inside the host process (no pid): render them as
  // virtual child nodes of the instance so the user sees them, never killable.
  let virtualSeq = 0;
  for (const row of rows) {
    if (!row || !row.virtual || !row.id) continue;
    const vpid = -(++virtualSeq);
    const parentPid = selfPid && visible.has(selfPid) ? selfPid : 0;
    const node = {
      pid: vpid,
      ppid: 0,
      parentPid,
      kind: row.kind || "subagent",
      owner: row.owner || "pi-subagents",
      label: row.label || row.id,
      sessionId: row.id,
      cwd: row.cwd || undefined,
      user: "",
      state: row.state || "",
      cpu: null,
      mem: null,
      etimeMs: null,
      cmd: undefined,
      canKill: false,
      protectedReason: "attached",
      instance: "self",
      source: row.source || "pi-subagents",
      attached: true,
      depth: 0,
      hasChildren: false,
    };
    nodes.push(node);
    nodeByPid.set(vpid, node);
  }

  for (const node of nodes) {
    if (node.parentPid && nodeByPid.has(node.parentPid)) {
      // hasChildren means "this node has children" (set on the parent).
      nodeByPid.get(node.parentPid).hasChildren = true;
    } else {
      node.parentPid = 0;
    }
  }

  // Depth from root (for client-side indentation fallback).
  const computeDepth = (node, seen) => {
    if (!node.parentPid || !nodeByPid.has(node.parentPid) || seen.has(node.pid)) return 0;
    seen.add(node.pid);
    return 1 + computeDepth(nodeByPid.get(node.parentPid), seen);
  };
  for (const node of nodes) node.depth = computeDepth(node, new Set());

  let cpu = 0;
  let mem = 0;
  let killable = 0;
  for (const node of nodes) {
    if (node.cpu) cpu += node.cpu;
    if (node.mem) mem += node.mem;
    if (node.canKill) killable++;
  }

  return {
    nodes,
    stats: {
      total: nodes.length,
      cpu: Math.round(cpu * 10) / 10,
      mem,
      killable,
    },
  };
}

// ---------------------------------------------------------------- kill plan

/**
 * Build a kill plan without touching the system. The caller (server) executes
 * it; this function only decides who may be signalled and in which order.
 *
 * - targets: pids requested by the client
 * - raw: Map<pid, {pid, ppid, ...}>
 * - uidOf(pid): effective owner uid (null when unreadable)
 * - owned: Set<pid> of pids the tree recognizes (registry/marker/host subtree)
 * - allowHost: explicit host-kill opt-in (double confirmation in the UI)
 */
function killPlan(opts) {
  const options = opts || {};
  const raw = options.raw instanceof Map ? options.raw : toRawMap(options.raw);
  const targets = Array.isArray(options.targets) ? options.targets.map(Number).filter((n) => n > 0) : [];
  const mode = options.mode === "subtree" ? "subtree" : "single";
  const uid = Number(options.uid);
  const selfPid = Number(options.selfPid) || 0;
  const cliPid = Number(options.cliPid) || 0;
  const allowHost = options.allowHost === true;
  const owned = options.owned instanceof Set ? options.owned : new Set(options.owned || []);
  const uidOf = typeof options.uidOf === "function" ? options.uidOf : () => uid;

  const denied = [];
  const allowed = new Set();
  const deny = (pid, reason) => denied.push({ pid, reason });

  const roots = [];
  for (const pid of targets) {
    if (!raw.has(Number(pid))) { deny(pid, "gone"); continue; }
    if (pid === 1) { deny(pid, "system"); continue; }
    if (pid === selfPid) { deny(pid, "self"); continue; }
    if (pid === cliPid && !allowHost) { deny(pid, "host"); continue; }
    const ownerUid = uidOf(pid);
    if (ownerUid != null && uid != null && Number(ownerUid) !== Number(uid)) { deny(pid, "other-user"); continue; }
    if (!owned.has(pid)) { deny(pid, "not-owned"); continue; }
    roots.push(pid);
  }

  if (mode === "single") {
    for (const pid of roots) allowed.add(pid);
  } else {
    for (const pid of roots) {
      const sub = descendantsOf(raw, [pid]);
      for (const child of sub) {
        if (child === 1 || child === selfPid) { deny(child, child === 1 ? "system" : "self"); continue; }
        if (child === cliPid && !allowHost) { deny(child, "host"); continue; }
        const ownerUid = uidOf(child);
        if (ownerUid != null && uid != null && Number(ownerUid) !== Number(uid)) { deny(child, "other-user"); continue; }
        allowed.add(child);
      }
    }
  }

  // Bottom-up: the deepest processes die first.
  const depthOf = (pid) => {
    let depth = 0;
    let cur = pid;
    const seen = new Set();
    while (cur > 1 && !seen.has(cur)) {
      seen.add(cur);
      const p = raw.get(cur);
      if (!p || !p.ppid) break;
      cur = p.ppid;
      depth++;
      if (depth > 64) break;
    }
    return depth;
  };
  const list = Array.from(allowed).map((pid) => ({ pid, depth: depthOf(pid) }));
  list.sort((a, b) => b.depth - a.depth || a.pid - b.pid);
  return { mode, allowed: list, denied };
}

// ---------------------------------------------------------------- formatters

function fmtBytes(n, digits) {
  if (n == null || !isFinite(Number(n)) || Number(n) < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const d = digits == null ? (v >= 100 ? 0 : 1) : digits;
  return (i === 0 ? String(Math.round(v)) : v.toFixed(d)) + " " + units[i];
}

function fmtCpu(v) {
  const n = Number(v);
  if (v == null || !isFinite(n) || n < 0) return "—";
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + "%";
}

function fmtDuration(ms) {
  const n = Number(ms);
  if (ms == null || !isFinite(n) || n < 0) return "—";
  const s = Math.floor(n / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m " + (s % 60) + "s";
  return s + "s";
}

function fmtCount(n) {
  const v = Number(n);
  return isFinite(v) && v > 0 ? String(Math.round(v)) : "0";
}

module.exports = {
  ancestorChain,
  visibleSet,
  parseLinuxStat,
  cpuPercent,
  parseEnviron,
  parseEnvMarkers,
  normalizeRegistryRows,
  buildTree,
  descendantPids: descendantsOf,
  killPlan,
  fmtBytes,
  fmtCpu,
  fmtDuration,
  fmtCount,
};
