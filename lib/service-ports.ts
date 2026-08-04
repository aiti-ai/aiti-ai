import { readFileSync, readdirSync, readlinkSync } from "fs";
import { execFileSync } from "child_process";
import { networkInterfaces } from "os";
import { isIP } from "node:net";

/**
 * Service-port discovery + auto allow-list.
 *
 * "Allow-list" here is not configured by hand: it is the cache of listening
 * TCP ports discovered on processes spawned by pi-web itself (the pi agent
 * runs sessions in-process, so any test server it starts is a descendant of
 * the pi-web process tree). Ports not in that set are never proxied, so a
 * remote attacker who can reach pi-web cannot pivot to unrelated local
 * services (Redis, MySQL, ...) — those are not our children.
 *
 * A process is considered "ours" when it is:
 *   1. a descendant of the pi-web process tree (pi-web → pi session → bash →
 *      python → ...), or
 *   2. carrying the PI_WEB_CHILD_MARKER environment value in /proc/<pid>/environ
 *      (Linux). Children inherit env at spawn time, so this survives
 *      re-parenting by daemonization (nohup / setsid / double-fork), where the
 *      tree link is lost. The marker is stamped by instrumentation.ts at
 *      server boot, before any session is created.
 *
 * Platform backends (all built-in system tools, no npm deps):
 *   Linux   — /proc (process tree, environ marker, fd sockets, net tables)
 *   macOS   — ps (tree + cmdline) + lsof (listening sockets)
 *   Windows — PowerShell Get-CimInstance (tree + cmdline) + netstat (sockets)
 */

export interface ServicePortInfo {
  port: number;
  pid: number;
  process: string;
  cmdline: string;
  /** Every concrete address the port is listening on (wildcards expanded). */
  addresses: string[];
}

declare global {
  var __piServicePortsCache:
    | { ports: Map<number, ServicePortInfo>; expiresAt: number }
    | undefined;
}

const DISCOVERY_TTL_MS = 5_000;

/**
 * Env marker stamped at server boot (instrumentation.ts) and inherited by
 * every spawned child. /proc/<pid>/environ never contains the server's own
 * marker (it reflects the env at exec time), so a marker hit is always a
 * spawned descendant — even one re-parented by daemonization.
 */
const CHILD_MARKER_ENV = "PI_WEB_CHILD_MARKER";

function ensureChildMarker(): string {
  if (!process.env[CHILD_MARKER_ENV]) {
    process.env[CHILD_MARKER_ENV] = `pi-web-${process.pid}-${Date.now().toString(36)}`;
  }
  return process.env[CHILD_MARKER_ENV]!;
}

const CHILD_MARKER = ensureChildMarker();

/** Command lines that identify pi-web's own processes (never "services"). */
export function isPiWebProcess(cmdline: string): boolean {
  if (!cmdline) return false;
  return (
    /next[\\/]dist[\\/]bin[\\/]next/.test(cmdline) ||
    /(^|[\s/\\])next(-server)?(\s|$)/.test(cmdline) ||
    /bin[\\/]pi-web/.test(cmdline) ||
    /pi-web(-options)?\.js/.test(cmdline)
  );
}

// ── /proc helpers (Linux) ────────────────────────────────────────────────────

function readCommandLine(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

function readComm(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return "?";
  }
}

/** Children of the given pids, from /proc/<pid>/task/<tid>/children. */
function readProcChildren(pids: Iterable<number>): Set<number> {
  const out = new Set<number>();
  for (const pid of pids) {
    let tasks: string[];
    try {
      tasks = readdirSync(`/proc/${pid}/task`);
    } catch {
      continue; // process vanished
    }
    for (const tid of tasks) {
      try {
        const raw = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8");
        for (const c of raw.trim().split(/\s+/)) {
          if (c) out.add(Number(c));
        }
      } catch {
        // tid vanished between readdir and read
      }
    }
  }
  return out;
}

// ── Cross-platform process table (macOS / Windows) ───────────────────────────

interface ProcEntry {
  ppid: number;
  name: string;
  cmdline: string;
}

function parsePsTable(out: string): Map<number, ProcEntry> {
  const map = new Map<number, ProcEntry>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) {
      map.set(Number(m[1]), {
        ppid: Number(m[2]),
        name: "",
        cmdline: m[3] ?? "",
      });
    }
  }
  return map;
}

function parsePowerShellTable(out: string): Map<number, ProcEntry> {
  const map = new Map<number, ProcEntry>();
  for (const line of out.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const pid = Number(parts[0].trim());
    const ppid = Number(parts[1].trim());
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    map.set(pid, {
      ppid,
      name: (parts[2] ?? "").trim(),
      cmdline: (parts[3] ?? "").trim(),
    });
  }
  return map;
}

/** pid → { ppid, name, cmdline } for every process (macOS/Windows only). */
function readProcessTable(): Map<number, ProcEntry> {
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      return parsePsTable(out);
    } catch {
      return new Map();
    }
  }
  if (process.platform === "win32") {
    try {
      const cmd =
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)" }';
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", cmd],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      );
      return parsePowerShellTable(out);
    } catch {
      return new Map();
    }
  }
  return new Map();
}

// ── Process tree ─────────────────────────────────────────────────────────────

interface ProcTree {
  /** PIDs below the pi-web root (agent shells, test servers, workers). */
  descendants: Set<number>;
  /** pi-web's own process chain. */
  selfAndAncestors: Set<number>;
}

function collectLinuxTree(): ProcTree {
  const selfAndAncestors = new Set<number>();
  let pid = process.pid;
  while (pid > 1) {
    selfAndAncestors.add(pid);
    if (!isPiWebProcess(readCommandLine(pid))) break;
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const m = /^PPid:\s+(\d+)/m.exec(status);
      const ppid = m ? Number(m[1]) : 0;
      if (!ppid || ppid === pid || ppid === 1) break;
      pid = ppid;
    } catch {
      break;
    }
  }
  const root = pid;

  const descendants = new Set<number>();
  let frontier = new Set<number>([root]);
  while (frontier.size > 0) {
    frontier = readProcChildren(frontier);
    for (const p of frontier) {
      if (p !== root && !selfAndAncestors.has(p)) descendants.add(p);
    }
  }
  return { descendants, selfAndAncestors };
}

function collectTableTree(table: Map<number, ProcEntry>): ProcTree {
  const selfAndAncestors = new Set<number>();
  let pid = process.pid;
  for (;;) {
    selfAndAncestors.add(pid);
    const entry = table.get(pid);
    const isOwn = pid === process.pid || isPiWebProcess(entry?.cmdline ?? "") || isPiWebProcess(entry?.name ?? "");
    const ppid = entry?.ppid ?? 0;
    if (!isOwn || !ppid || ppid === pid || ppid === 1) break;
    pid = ppid;
  }
  const root = pid;

  const childrenMap = new Map<number, number[]>();
  for (const [child, entry] of table) {
    const arr = childrenMap.get(entry.ppid) ?? [];
    arr.push(child);
    childrenMap.set(entry.ppid, arr);
  }

  const descendants = new Set<number>();
  const queue = [root];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const child of childrenMap.get(cur) ?? []) {
      if (child === root || selfAndAncestors.has(child) || descendants.has(child)) continue;
      descendants.add(child);
      queue.push(child);
    }
  }
  return { descendants, selfAndAncestors };
}

/**
 * Walk up from the current process to the topmost pi-web process, then
 * collect every descendant below it. Scoped to pi-web even when it was
 * launched from a user shell or an IDE.
 */
function collectProcTree(): ProcTree {
  if (process.platform === "linux") return collectLinuxTree();
  return collectTableTree(readProcessTable());
}

// ── Socket table parsing (Linux /proc) ───────────────────────────────────────

interface ListenSocket {
  port: number;
  address: string;
}

export function decodeIpv4(hex: string): string {
  const bytes = hex.match(/../g) ?? [];
  return bytes.map((b) => parseInt(b, 16)).reverse().join(".");
}

function formatIpv6(words: number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < words.length; ) {
    if (words[i] === 0) {
      let j = i;
      while (j < words.length && words[j] === 0) j++;
      if (j - i > bestLen) {
        bestStart = i;
        bestLen = j - i;
      }
      i = j;
    } else {
      i++;
    }
  }
  const hex = words.map((w) => w.toString(16));
  if (bestLen >= 2) {
    const head = hex.slice(0, bestStart).join(":");
    const tail = hex.slice(bestStart + bestLen).join(":");
    return `${head}::${tail}`;
  }
  return hex.join(":");
}

export function decodeIpv6(hex: string): string {
  const words: number[] = [];
  for (let i = 0; i < 32; i += 8) {
    const n = parseInt(hex.slice(i, i + 8), 16);
    // /proc/net/tcp6 stores each 32-bit group little-endian → reorder bytes
    // into two 16-bit words.
    const b0 = (n >> 24) & 0xff;
    const b1 = (n >> 16) & 0xff;
    const b2 = (n >> 8) & 0xff;
    const b3 = n & 0xff;
    words.push((b3 << 8) | b2, (b1 << 8) | b0);
  }
  return formatIpv6(words);
}

/** socket inode → (port, address) for every LISTEN socket in this netns. */
function parseNetListenTables(): Map<number, ListenSocket> {
  const inodeToSocket = new Map<number, ListenSocket>();
  const tables: Array<[string, boolean]> = [
    ["/proc/net/tcp", false],
    ["/proc/net/tcp6", true],
  ];
  for (const [file, ipv6] of tables) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      if (parts[3] !== "0A") continue; // only LISTEN
      const local = parts[1];
      const idx = local.indexOf(":");
      if (idx <= 0) continue;
      const addrHex = local.slice(0, idx);
      const port = parseInt(local.slice(idx + 1), 16);
      if (!Number.isFinite(port) || port <= 0) continue;
      const inode = Number(parts[9]);
      if (!Number.isFinite(inode)) continue;
      inodeToSocket.set(inode, {
        port,
        address: ipv6 ? decodeIpv6(addrHex) : decodeIpv4(addrHex),
      });
    }
  }
  return inodeToSocket;
}

/** Listening sockets held by a pid (via /proc/<pid>/fd socket inodes). */
function pidsListeningSockets(pid: number, inodeToSocket: Map<number, ListenSocket>): ListenSocket[] {
  let fds: string[];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return [];
  }
  const out: ListenSocket[] = [];
  for (const fd of fds) {
    let link: string;
    try {
      link = readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    const m = /^socket:\[(\d+)\]$/.exec(link);
    if (!m) continue;
    const sock = inodeToSocket.get(Number(m[1]));
    if (sock) out.push(sock);
  }
  return out;
}

// ── Platform discovery backends ──────────────────────────────────────────────

/** All numeric /proc entries (process ids). */
function listAllPids(): number[] {
  try {
    return readdirSync("/proc")
      .filter((n) => /^\d+$/.test(n))
      .map(Number);
  } catch {
    return [];
  }
}

/** True when the process carries our env marker (spawned by this pi-web). */
function processHasChildMarker(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/environ`).includes(CHILD_MARKER);
  } catch {
    return false;
  }
}

/** Non-internal interface addresses on this machine. */
function lanAddresses(): { ipv4: string[]; ipv6: string[] } {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  try {
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const iface of ifaces ?? []) {
        if (iface.internal) continue;
        if (iface.family === "IPv4") ipv4.push(iface.address);
        else if (iface.family === "IPv6") ipv6.push(iface.address);
      }
    }
  } catch {
    // networkInterfaces unavailable
  }
  return { ipv4, ipv6 };
}

/** Turn wildcard binds (0.0.0.0 / *) into concrete reachable addresses. */
export function expandListeningAddresses(addresses: string[]): string[] {
  const out = new Set<string>();
  const { ipv4, ipv6 } = lanAddresses();
  for (const a of addresses) {
    if (a === "0.0.0.0" || a === "*") {
      out.add("127.0.0.1");
      for (const ip of ipv4) out.add(ip);
    } else if (a === "::" || a === "::0") {
      out.add("::1");
      for (const ip of ipv6) out.add(ip);
    } else {
      out.add(a);
    }
  }
  return [...out];
}

function discoverLinux(): Map<number, ServicePortInfo> {
  const { descendants, selfAndAncestors } = collectLinuxTree();
  const inodeToSocket = parseNetListenTables();
  const result = new Map<number, ServicePortInfo>();

  // Union of tree descendants and env-marker carriers (daemonized, re-parented
  // children that left the tree). Skip our own chain — the marker scan would
  // not include the server itself anyway (environ is fixed at exec), but the
  // ancestor check keeps the tree side honest.
  const candidatePids = new Set(descendants);
  for (const pid of listAllPids()) {
    if (candidatePids.has(pid) || selfAndAncestors.has(pid) || pid === process.pid) continue;
    if (processHasChildMarker(pid)) candidatePids.add(pid);
  }

  for (const pid of candidatePids) {
    const cmdline = readCommandLine(pid);
    if (isPiWebProcess(cmdline)) continue;
    for (const sock of pidsListeningSockets(pid, inodeToSocket)) {
      const existing = result.get(sock.port);
      if (existing) {
        if (!existing.addresses.includes(sock.address)) existing.addresses.push(sock.address);
      } else {
        result.set(sock.port, {
          port: sock.port,
          pid,
          process: readComm(pid),
          cmdline,
          addresses: [sock.address],
        });
      }
    }
  }
  for (const info of result.values()) info.addresses = expandListeningAddresses(info.addresses);
  return result;
}

export function parseLsofAddress(name: string): { address: string; port: number } | null {
  const m = /\[?([^\]]*)\]?:(\d+) \(LISTEN\)/.exec(name);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { address: m[1] || "*", port };
}

function discoverDarwin(descendants: Set<number>): Map<number, ServicePortInfo> {
  const table = readProcessTable();
  const result = new Map<number, ServicePortInfo>();
  let out: string;
  try {
    out = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return result;
  }
  for (const line of out.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const pid = Number(parts[1]);
    if (!Number.isFinite(pid) || !descendants.has(pid)) continue;
    const parsed = parseLsofAddress(parts[8]);
    if (!parsed) continue;
    const entry = table.get(pid);
    const cmdline = entry?.cmdline ?? "";
    if (isPiWebProcess(cmdline)) continue;
    const existing = result.get(parsed.port);
    if (existing) {
      if (!existing.addresses.includes(parsed.address)) existing.addresses.push(parsed.address);
    } else {
      result.set(parsed.port, {
        port: parsed.port,
        pid,
        process: parts[0],
        cmdline,
        addresses: [parsed.address],
      });
    }
  }
  for (const info of result.values()) info.addresses = expandListeningAddresses(info.addresses);
  return result;
}

export function parseNetstatAddress(addr: string): { address: string; port: number } | null {
  let m = /^\[([^\]]*)\]:(\d+)$/.exec(addr);
  if (m) {
    const port = Number(m[2]);
    return Number.isFinite(port) && port > 0 ? { address: m[1], port } : null;
  }
  m = /^([^:]+):(\d+)$/.exec(addr);
  if (m) {
    const port = Number(m[2]);
    return Number.isFinite(port) && port > 0 ? { address: m[1], port } : null;
  }
  return null;
}

function discoverWindows(descendants: Set<number>): Map<number, ServicePortInfo> {
  const table = readProcessTable();
  const result = new Map<number, ServicePortInfo>();
  let out: string;
  try {
    out = execFileSync("netstat", ["-ano"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return result;
  }
  for (const line of out.split("\n")) {
    if (!/LISTENING/.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const pid = Number(parts[4]);
    if (!Number.isFinite(pid) || !descendants.has(pid)) continue;
    const parsed = parseNetstatAddress(parts[1]);
    if (!parsed) continue;
    const entry = table.get(pid);
    if (!entry) continue;
    if (isPiWebProcess(entry.cmdline) || isPiWebProcess(entry.name)) continue;
    const existing = result.get(parsed.port);
    if (existing) {
      if (!existing.addresses.includes(parsed.address)) existing.addresses.push(parsed.address);
    } else {
      result.set(parsed.port, {
        port: parsed.port,
        pid,
        process: entry.name || "?",
        cmdline: entry.cmdline,
        addresses: [parsed.address],
      });
    }
  }
  for (const info of result.values()) info.addresses = expandListeningAddresses(info.addresses);
  return result;
}

/** Discover listening TCP ports owned by pi-web's descendant processes. */
export function discoverServicePorts(): Map<number, ServicePortInfo> {
  const { descendants } = collectProcTree();
  if (process.platform === "linux") return discoverLinux();
  if (process.platform === "darwin") return discoverDarwin(descendants);
  return discoverWindows(descendants);
}

/** Cached discovery — the cache doubles as the proxy allow-list. */
export function getServicePorts(force = false): ServicePortInfo[] {
  const now = Date.now();
  const cached = globalThis.__piServicePortsCache;
  if (!force && cached && cached.expiresAt > now) {
    return [...cached.ports.values()];
  }
  const ports = discoverServicePorts();
  globalThis.__piServicePortsCache = { ports, expiresAt: now + DISCOVERY_TTL_MS };
  return [...ports.values()];
}

/** Whether a port may be proxied (i.e. was found in our own process tree). */
export function isServicePortAllowed(port: number): boolean {
  return getServicePorts().some((p) => p.port === port);
}

/** Virtual-host suffix used for service URLs, e.g. ".pi.localhost". */
export function getServiceHostSuffix(): string {
  const raw = process.env.PI_WEB_SVC_HOST_SUFFIX ?? ".pi.localhost";
  return raw.startsWith(".") ? raw : `.${raw}`;
}

/**
 * All suffixes that proxy.ts accepts as service virtual hosts, in priority
 * order: the built-in .pi.localhost, the explicit PI_WEB_SVC_HOST_SUFFIX, and
 * the operator-configured hosts (PI_WEB_HOSTNAME / PI_WEB_ALLOWED_HOSTS) so a
 * deployment at example.com automatically serves <port>.example.com too.
 */
export function getServiceHostSuffixes(): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const s = raw.trim().toLowerCase().replace(/^\./, "");
    // IP literals (e.g. PI_WEB_HOSTNAME=127.0.0.1) cannot be wildcard suffixes.
    if (!s || isIP(s) !== 0) return;
    if (!out.includes(`.${s}`)) out.push(`.${s}`);
  };
  add(getServiceHostSuffix());
  for (const h of (process.env.PI_WEB_HOSTNAME ?? "").split(",")) add(h);
  for (const h of (process.env.PI_WEB_ALLOWED_HOSTS ?? "").split(",")) add(h);
  return out;
}

/**
 * Strip pi-web's own basePath (e.g. /dev) from a path before forwarding it to
 * a proxied service. Service URLs carry the basePath so reverse proxies that
 * path-route pi-web (nginx `location /dev/`) send them to pi-web; the service
 * itself must see the ORIGINAL path, so /dev/foo → /foo. Paths that do not
 * start with the basePath pass through untouched.
 */
export function stripBasePath(pathname: string, basePath: string): string {
  const base = (basePath ?? "").replace(/\/+$/, "");
  if (!base || pathname === "/") return pathname;
  if (pathname === base) return "/";
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);
  return pathname;
}
