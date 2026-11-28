/**
 * 服务端口发现（service-tunnels 同款模式，跨平台）：
 *   「ours」= VS Code 主进程的后代进程树（集成终端/任务/调试里起的服务）
 *   —— 永不枚举任意用户进程（防噪音与误代理，同 service-tunnels 安全模型）
 *
 * 进程表：Linux /proc/<pid>（stat+cmdline）；macOS `ps -axo pid=,ppid=,command=`；
 *         Windows PowerShell Get-CimInstance Win32_Process（tab 分列）。
 * 监听端口：Linux /proc/net/tcp LISTEN 按 socket inode 反查归属（ss 兜底）；
 *         macOS `lsof -nP -iTCP -sTCP:LISTEN`；Windows `netstat -ano` LISTENING 行。
 * 全部 async（execFile 不阻塞扩展宿主）；解析模式对齐 service-tunnels/src/discovery.ts。
 * 分类：逐端口 HTTP GET / → text/html = 可注入页面（框架指纹）；其他 2xx = 非页面服务。
 */
import { readdirSync, readFileSync, readlinkSync } from "fs";
import { execFile } from "child_process";
import { basename } from "path";

export interface ServiceHit {
  port: number;
  pid: number;
  process: string;
  url: string;
  kind: "page" | "http";
  framework: string;
  title: string;
}

const HTTP_TIMEOUT_MS = 900;
const PROBE_CONCURRENCY = 12;
const EXEC_TIMEOUT_MS = 6000;

interface ProcEntry {
  ppid: number;
  name: string;
  cmdline: string;
}
type ProcTable = Map<number, ProcEntry>;
type ListenMap = Map<number, { pid: number; name: string }>;

function execP(cmd: string, args: string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }, (e, stdout) =>
      resolve(e ? "" : String(stdout)),
    );
  });
}

// ---------- 进程表（跨平台） ----------

async function processTableLinux(): Promise<ProcTable> {
  const map: ProcTable = new Map();
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return map;
  }
  for (const pidStr of pids) {
    const pid = Number(pidStr);
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = raw.lastIndexOf(")");
      const parts = raw.slice(close + 2).split(" ");
      let cmdline = "";
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ").slice(0, 120);
      } catch {
        /* ignore */
      }
      map.set(pid, {
        ppid: Number(parts[1]),
        name: (parts[0] || "").trim(),
        cmdline,
      });
    } catch {
      /* 进程消失跳过 */
    }
  }
  return map;
}

function parsePsTable(out: string): ProcTable {
  const map: ProcTable = new Map();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) {
      const cmdline = m[3] ?? "";
      map.set(Number(m[1]), { ppid: Number(m[2]), name: cmdline.split(" ")[0] || "?", cmdline });
    }
  }
  return map;
}

function parsePowerShellTable(out: string): ProcTable {
  const map: ProcTable = new Map();
  for (const line of out.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const pid = Number(parts[0]?.trim());
    const ppid = Number(parts[1]?.trim());
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    map.set(pid, { ppid, name: (parts[2] ?? "").trim(), cmdline: (parts[3] ?? "").trim() });
  }
  return map;
}

async function processTable(): Promise<ProcTable> {
  if (process.platform === "linux") return processTableLinux();
  if (process.platform === "darwin") return parsePsTable(await execP("ps", ["-axo", "pid=,ppid=,command="]));
  if (process.platform === "win32") {
    // [Console]::OutputEncoding=UTF8 forces UTF-8 stdout (default OEM codepage is GBK on Chinese
    // Windows; execFile decodes utf8 -> garbled CJK command lines)
    const cmd =
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)" }';
    return parsePowerShellTable(await execP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd]));
  }
  return new Map();
}

// ---------- 监听端口（跨平台，port → pid+进程名） ----------

function parseLsofAddress(name: string): number | null {
  const m = /\[?([^\]]*)\]?:(\d+) \(LISTEN\)/.exec(name);
  if (!m) return null;
  const port = Number(m[2]);
  return Number.isFinite(port) && port > 0 ? port : null;
}

function parseNetstatAddress(addr: string): number | null {
  let m = /^\[([^\]]*)\]:(\d+)$/.exec(addr); // IPv6 [::]:5173
  if (!m) m = /^([^:]+):(\d+)$/.exec(addr); // 0.0.0.0:5173
  if (!m) return null;
  const port = Number(m[2]);
  return Number.isFinite(port) && port > 0 ? port : null;
}

/** Linux：/proc/net/tcp(+6) LISTEN → socket inode 反查 /proc/<pid>/fd */
async function listeningLinuxInode(): Promise<ListenMap> {
  const entries: Array<{ port: number; inode: string }> = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== "0A") continue;
      const port = parseInt((f[1] || "").split(":")[1], 16);
      if (port > 0 && port < 65536) entries.push({ port, inode: f[9] });
    }
  }
  const inodeToPid = new Map<string, { pid: number; name: string }>();
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return new Map();
  }
  for (const pidStr of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pidStr}/fd`);
    } catch {
      continue;
    }
    const pid = Number(pidStr);
    for (const fd of fds) {
      try {
        const link = readlinkSync(`/proc/${pidStr}/fd/${fd}`);
        const m = link.match(/^socket:\[(\d+)\]$/);
        if (m && !inodeToPid.has(m[1])) {
          let name = "";
          try {
            name = readFileSync(`/proc/${pidStr}/comm`, "utf8").trim();
          } catch {
            /* ignore */
          }
          inodeToPid.set(m[1], { pid, name });
        }
      } catch {
        /* fd 瞬时消失 */
      }
    }
  }
  const out: ListenMap = new Map();
  for (const e of entries) {
    const owner = inodeToPid.get(e.inode);
    if (owner && !out.has(e.port)) out.set(e.port, owner);
  }
  return out;
}

async function listeningLinuxSsFallback(): Promise<ListenMap> {
  const out = await execP("ss", ["-tlnp"], 2000);
  const map: ListenMap = new Map();
  for (const line of out.split("\n")) {
    const m = line.match(/LISTEN\s+\d+\s+\d+\s+[^\s]*?:(\d+)\s+\S+\s+users:\(\("([^"]+)",pid=(\d+)/);
    if (m) map.set(Number(m[1]), { pid: Number(m[3]), name: m[2] });
  }
  return map;
}

async function listeningDarwin(): Promise<ListenMap> {
  const out = await execP("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  const map: ListenMap = new Map();
  for (const line of out.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const port = parseLsofAddress(parts[8] || "");
    const pid = Number(parts[1]);
    if (port && Number.isFinite(pid) && !map.has(port)) map.set(port, { pid, name: parts[0] || "?" });
  }
  return map;
}

async function listeningWindows(): Promise<ListenMap> {
  const out = await execP("netstat", ["-ano"]);
  const map: ListenMap = new Map();
  for (const line of out.split("\n")) {
    if (!/LISTENING/.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const port = parseNetstatAddress(parts[1] || "");
    const pid = Number(parts[4]);
    if (port && Number.isFinite(pid) && !map.has(port)) map.set(port, { pid, name: "" }); // 进程名从进程表回填
  }
  return map;
}

async function listeningMap(): Promise<ListenMap> {
  if (process.platform === "linux") {
    const primary = await listeningLinuxInode();
    return primary.size > 0 ? primary : listeningLinuxSsFallback();
  }
  if (process.platform === "darwin") return listeningDarwin();
  if (process.platform === "win32") return listeningWindows();
  return new Map();
}

// ---------- 进程树 ----------

function descendantsOf(table: ProcTable, root: number): Set<number> {
  const kids = new Map<number, number[]>();
  for (const [pid, info] of table) {
    const list = kids.get(info.ppid) || [];
    list.push(pid);
    kids.set(info.ppid, list);
  }
  const out = new Set<number>();
  const queue = [...(kids.get(root) || [])];
  while (queue.length) {
    const pid = queue.shift()!;
    if (out.has(pid)) continue;
    out.add(pid);
    for (const k of kids.get(pid) || []) queue.push(k);
  }
  return out;
}

/**
 * Anchoring rules for the ancestor chain (pure function, unit-tested): an ancestor whose process
 * name equals the extension host's own exe (the whole VS Code family runs every process from the
 * same exe: Code.exe/Qoder.exe/Cursor.exe/Windsurf.exe/Trae.exe ...) or a code|electron fallback.
 * 2026-11-14 fix: the old /code|electron/i regex never matched on forks (e.g. Qoder.exe) ->
 * root=undefined -> discoverVscodeServices always returned [] -> no port candidates, no injection.
 */
export function anchorIdeRoot(table: ProcTable, selfExe: string, startPid = process.pid): number | undefined {
  const selfName = selfExe.toLowerCase();
  let pid = startPid;
  let top: number | undefined;
  for (let i = 0; i < 50; i++) {
    const e = table.get(pid);
    if (!e) break;
    if (e.name.toLowerCase() === selfName || /code|electron/i.test(e.name)) top = pid;
    else if (top !== undefined && top !== process.pid) break;
    if (!e.ppid || e.ppid <= 1) break;
    pid = e.ppid;
  }
  return top;
}

/** Last IDE main process up the ancestor chain = VS Code/fork main process (never climbs out of shell chains) */
function deriveRoot(table: ProcTable): number | undefined {
  return anchorIdeRoot(table, basename(process.execPath));
}

// ---------- 探测与分类 ----------

function detectFramework(html: string): { framework: string; title: string } {
  const title = (html.match(/<title[^>]*>([^<]{0,80})/)?.[1] || "").trim();
  const markers: Array<[string, string]> = [
    ["/@vite/client", "Vite"],
    ["/_next/", "Next.js"],
    ["webpack-dev-server", "webpack"],
    ["/_nuxt/", "Nuxt"],
    [".svelte-kit/", "SvelteKit"],
  ];
  for (const [marker, name] of markers) if (html.includes(marker)) return { framework: name, title };
  return { framework: "HTTP page", title };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) out[i] = await fn(items[i++]);
    }),
  );
  return out;
}

/**
 * 发现 VS Code 子进程树里的监听服务（service-tunnels「ours=调用方进程树后代」模式，跨平台）。
 * rootPid 缺省时从扩展宿主祖先链自动锚定 VS Code 主进程。
 */
export async function discoverVscodeServices(opts: {
  excludePorts?: number[];
  excludeCmdline?: RegExp[];
  rootPid?: number;
}): Promise<ServiceHit[]> {
  const { excludePorts = [], excludeCmdline = [] } = opts;
  const table = await processTable();
  if (table.size === 0) return []; // 非 Linux 且系统工具不可用 → 降级手动登记模式
  const root = opts.rootPid ?? deriveRoot(table);
  if (!root || !table.has(root)) return [];
  const desc = descendantsOf(table, root);
  const listening = await listeningMap();

  const ports: number[] = [];
  for (const [port, li] of listening.entries()) {
    if (excludePorts.includes(port) || !desc.has(li.pid)) continue;
    const entry = table.get(li.pid);
    if (!entry) continue;
    if (excludeCmdline.some((re) => re.test(entry.cmdline) || re.test(entry.name))) continue;
    ports.push(port);
  }

  const hits = await mapLimit(ports, PROBE_CONCURRENCY, async (port): Promise<ServiceHit | null> => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal: ctl.signal,
        headers: { accept: "text/html, */*;q=0.1", "sec-fetch-mode": "navigate" },
      });
      clearTimeout(timer);
      const li = listening.get(port)!;
      const entry = table.get(li.pid)!;
      const base: ServiceHit = {
        port,
        pid: li.pid,
        process: entry.name || li.name || "?",
        url: `http://localhost:${port}/`,
        kind: "http",
        framework: "",
        title: "",
      };
      const ct = res.headers.get("content-type") || "";
      if (res.ok && ct.includes("text/html")) {
        const html = await res.text();
        const { framework, title } = detectFramework(html);
        return { ...base, kind: "page", framework, title: title || "(untitled)" };
      }
      if (res.ok) return { ...base, framework: ct.split(";")[0] || "http" };
      return null;
    } catch {
      return null;
    }
  });
  return hits
    .filter((h): h is ServiceHit => !!h)
    .sort((a, b) => (a.kind === b.kind ? a.port - b.port : a.kind === "page" ? -1 : 1));
}
