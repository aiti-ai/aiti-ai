// src/port-scan.ts
import { readdirSync, readFileSync, readlinkSync } from "fs";
import { execFile } from "child_process";
import { basename } from "path";
var HTTP_TIMEOUT_MS = 900;
var PROBE_CONCURRENCY = 12;
var EXEC_TIMEOUT_MS = 6e3;
function execP(cmd, args, timeoutMs = EXEC_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (e, stdout) => resolve(e ? "" : String(stdout))
    );
  });
}
async function processTableLinux() {
  const map = /* @__PURE__ */ new Map();
  let pids;
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
      }
      map.set(pid, {
        ppid: Number(parts[1]),
        name: (parts[0] || "").trim(),
        cmdline
      });
    } catch {
    }
  }
  return map;
}
function parsePsTable(out) {
  const map = /* @__PURE__ */ new Map();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) {
      const cmdline = m[3] ?? "";
      map.set(Number(m[1]), { ppid: Number(m[2]), name: cmdline.split(" ")[0] || "?", cmdline });
    }
  }
  return map;
}
function parsePowerShellTable(out) {
  const map = /* @__PURE__ */ new Map();
  for (const line of out.split("\n")) {
    const parts = line.split("	");
    if (parts.length < 3) continue;
    const pid = Number(parts[0]?.trim());
    const ppid = Number(parts[1]?.trim());
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    map.set(pid, { ppid, name: (parts[2] ?? "").trim(), cmdline: (parts[3] ?? "").trim() });
  }
  return map;
}
async function processTable() {
  if (process.platform === "linux") return processTableLinux();
  if (process.platform === "darwin") return parsePsTable(await execP("ps", ["-axo", "pid=,ppid=,command="]));
  if (process.platform === "win32") {
    const cmd = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)" }';
    return parsePowerShellTable(await execP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd]));
  }
  return /* @__PURE__ */ new Map();
}
function parseLsofAddress(name) {
  const m = /\[?([^\]]*)\]?:(\d+) \(LISTEN\)/.exec(name);
  if (!m) return null;
  const port = Number(m[2]);
  return Number.isFinite(port) && port > 0 ? port : null;
}
function parseNetstatAddress(addr) {
  let m = /^\[([^\]]*)\]:(\d+)$/.exec(addr);
  if (!m) m = /^([^:]+):(\d+)$/.exec(addr);
  if (!m) return null;
  const port = Number(m[2]);
  return Number.isFinite(port) && port > 0 ? port : null;
}
async function listeningLinuxInode() {
  const entries = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let raw;
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
  const inodeToPid = /* @__PURE__ */ new Map();
  let pids;
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return /* @__PURE__ */ new Map();
  }
  for (const pidStr of pids) {
    let fds;
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
          }
          inodeToPid.set(m[1], { pid, name });
        }
      } catch {
      }
    }
  }
  const out = /* @__PURE__ */ new Map();
  for (const e of entries) {
    const owner = inodeToPid.get(e.inode);
    if (owner && !out.has(e.port)) out.set(e.port, owner);
  }
  return out;
}
async function listeningLinuxSsFallback() {
  const out = await execP("ss", ["-tlnp"], 2e3);
  const map = /* @__PURE__ */ new Map();
  for (const line of out.split("\n")) {
    const m = line.match(/LISTEN\s+\d+\s+\d+\s+[^\s]*?:(\d+)\s+\S+\s+users:\(\("([^"]+)",pid=(\d+)/);
    if (m) map.set(Number(m[1]), { pid: Number(m[3]), name: m[2] });
  }
  return map;
}
async function listeningDarwin() {
  const out = await execP("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  const map = /* @__PURE__ */ new Map();
  for (const line of out.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const port = parseLsofAddress(parts[8] || "");
    const pid = Number(parts[1]);
    if (port && Number.isFinite(pid) && !map.has(port)) map.set(port, { pid, name: parts[0] || "?" });
  }
  return map;
}
async function listeningWindows() {
  const out = await execP("netstat", ["-ano"]);
  const map = /* @__PURE__ */ new Map();
  for (const line of out.split("\n")) {
    if (!/LISTENING/.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const port = parseNetstatAddress(parts[1] || "");
    const pid = Number(parts[4]);
    if (port && Number.isFinite(pid) && !map.has(port)) map.set(port, { pid, name: "" });
  }
  return map;
}
async function listeningMap() {
  if (process.platform === "linux") {
    const primary = await listeningLinuxInode();
    return primary.size > 0 ? primary : listeningLinuxSsFallback();
  }
  if (process.platform === "darwin") return listeningDarwin();
  if (process.platform === "win32") return listeningWindows();
  return /* @__PURE__ */ new Map();
}
function descendantsOf(table, root) {
  const kids = /* @__PURE__ */ new Map();
  for (const [pid, info] of table) {
    const list = kids.get(info.ppid) || [];
    list.push(pid);
    kids.set(info.ppid, list);
  }
  const out = /* @__PURE__ */ new Set();
  const queue = [...kids.get(root) || []];
  while (queue.length) {
    const pid = queue.shift();
    if (out.has(pid)) continue;
    out.add(pid);
    for (const k of kids.get(pid) || []) queue.push(k);
  }
  return out;
}
function anchorIdeRoot(table, selfExe, startPid = process.pid) {
  const selfName = selfExe.toLowerCase();
  let pid = startPid;
  let top;
  for (let i = 0; i < 50; i++) {
    const e = table.get(pid);
    if (!e) break;
    if (e.name.toLowerCase() === selfName || /code|electron/i.test(e.name)) top = pid;
    else if (top !== void 0 && top !== process.pid) break;
    if (!e.ppid || e.ppid <= 1) break;
    pid = e.ppid;
  }
  return top;
}
function deriveRoot(table) {
  return anchorIdeRoot(table, basename(process.execPath));
}
function detectFramework(html) {
  const title = (html.match(/<title[^>]*>([^<]{0,80})/)?.[1] || "").trim();
  const markers = [
    ["/@vite/client", "Vite"],
    ["/_next/", "Next.js"],
    ["webpack-dev-server", "webpack"],
    ["/_nuxt/", "Nuxt"],
    [".svelte-kit/", "SvelteKit"]
  ];
  for (const [marker, name] of markers) if (html.includes(marker)) return { framework: name, title };
  return { framework: "HTTP page", title };
}
async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) out[i] = await fn(items[i++]);
    })
  );
  return out;
}
async function discoverVscodeServices(opts) {
  const { excludePorts = [], excludeCmdline = [] } = opts;
  const table = await processTable();
  if (table.size === 0) return [];
  const root = opts.rootPid ?? deriveRoot(table);
  if (!root || !table.has(root)) return [];
  const desc = descendantsOf(table, root);
  const listening = await listeningMap();
  const ports = [];
  for (const [port, li] of listening.entries()) {
    if (excludePorts.includes(port) || !desc.has(li.pid)) continue;
    const entry = table.get(li.pid);
    if (!entry) continue;
    if (excludeCmdline.some((re) => re.test(entry.cmdline) || re.test(entry.name))) continue;
    ports.push(port);
  }
  const hits = await mapLimit(ports, PROBE_CONCURRENCY, async (port) => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal: ctl.signal,
        headers: { accept: "text/html, */*;q=0.1", "sec-fetch-mode": "navigate" }
      });
      clearTimeout(timer);
      const li = listening.get(port);
      const entry = table.get(li.pid);
      const base = {
        port,
        pid: li.pid,
        process: entry.name || li.name || "?",
        url: `http://localhost:${port}/`,
        kind: "http",
        framework: "",
        title: ""
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
  return hits.filter((h) => !!h).sort((a, b) => a.kind === b.kind ? a.port - b.port : a.kind === "page" ? -1 : 1);
}
export {
  anchorIdeRoot,
  discoverVscodeServices
};
