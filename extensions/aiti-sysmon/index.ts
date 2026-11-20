/**
 * aiti-sysmon · server status viewer for the pi-web host machine.
 *
 * One-shot snapshot API (GET /api/extensions/aiti-sysmon/snapshot) built on the
 * `systeminformation` package (pure JS, cross-platform). Design notes:
 *   - No background timers, no server-side polling: rates (cpu load %, net rx/tx
 *     per second) are deltas computed by si internally between consecutive calls,
 *     so the client polling cadence is the sampling window. The server keeps no
 *     state beyond small TTL caches for slow-changing sections.
 *   - Slow sections (disks 30s, OS info 10min, temperature 5s) are cached so the
 *     per-poll subprocess overhead stays near zero; cpu/mem/net are cheap reads.
 *   - Temperature degrades to null (no lm-sensors / unsupported platform) and the
 *     client renders an N/A hint linking to the docs page for setup instructions:
 *     https://aiti.pw/extensions/aiti-sysmon.html
 *   - Read-only: no config/state writes at all (ctx.configDir untouched).
 */
import os from "node:os";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const core = require("./core.cjs");

// systeminformation is lazy-loaded on first use so a missing install (extman
// reconcile not run yet) surfaces as a clean 503 API error instead of a broken
// extension load.
let si: any = null;
let siError: string | null = null;
function loadSi(): any {
  if (si) return si;
  try {
    si = require("systeminformation");
    siError = null;
  } catch (e: any) {
    siError = String(e?.message || e);
  }
  return si;
}

// TTL caches for slow-changing sections (see header note).
const osCache = new core.TTLCache(600_000);
const diskCache = new core.TTLCache(30_000);
const tempCache = new core.TTLCache(5_000);
const hwmonCache = new core.TTLCache(5_000);
let tempMissStreak = 0;

interface HwmonSensor { chip: string; label: string; temp: number }

/** Generic sensors scan (lm-sensors style): read /sys/class/hwmon/hwmonN/name plus
 *  tempN_input (+ optional tempN_label). Kernel-side sysfs — no userspace tools required. Returns
 *  [] on non-Linux platforms; millidegree values filtered to a sane (0, 150)°C range;
 *  capped at 16 entries. 5s TTL cache (same cadence as the CPU temperature read). */
function readHwmonSensors(): HwmonSensor[] {
  const cached = hwmonCache.get("hwmon");
  if (cached !== undefined) return cached as HwmonSensor[];
  const out: HwmonSensor[] = [];
  if (process.platform === "linux") {
    try {
      const base = "/sys/class/hwmon";
      for (const dir of readdirSync(base).sort()) {
        const d = join(base, dir);
        let chip = "";
        try { chip = readFileSync(join(d, "name"), "utf8").trim(); } catch { continue; }
        if (!chip) continue;
        for (const f of readdirSync(d)) {
          const m = /^temp(\d+)_input$/.exec(f);
          if (!m) continue;
          let label = `temp${m[1]}`;
          try { label = readFileSync(join(d, `temp${m[1]}_label`), "utf8").trim() || label; } catch { /* unlabeled */ }
          const raw = Number(readFileSync(join(d, f), "utf8").trim()) / 1000;
          if (Number.isFinite(raw) && raw > 0 && raw < 150) {
            out.push({ chip, label, temp: Math.round(raw * 10) / 10 });
          }
        }
      }
    } catch { /* hwmon unavailable */ }
  }
  if (out.length > 16) out.length = 16;
  hwmonCache.set("hwmon", out);
  return out;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

async function buildSnapshot() {
  const s = loadSi();
  if (!s) {
    const err: any = new Error("systeminformation is not installed yet (extman reconcile pending): " + siError);
    err.code = "SI_MISSING";
    throw err;
  }
  const out: any = { ts: Date.now() };

  // OS identity — slow changing, 10min TTL.
  let osInfo: any = osCache.get("os");
  if (osInfo === undefined) {
    try { osInfo = await s.osInfo(); } catch { osInfo = {}; }
    osCache.set("os", osInfo);
  }
  out.os = {
    hostname: os.hostname(),
    platform: osInfo.platform || process.platform,
    distro: osInfo.distro || "",
    release: osInfo.release || "",
    kernel: osInfo.kernel || os.release(),
    arch: osInfo.arch || process.arch,
    uptime: os.uptime(),
  };

  // CPU — load is a delta si computes since the previous currentLoad() call.
  let load: any = null;
  try { load = await s.currentLoad(); } catch { load = null; }
  const cpus = os.cpus();
  out.cpu = {
    model: (cpus[0] && cpus[0].model) || "",
    cores: cpus.length,
    load: core.pct(load?.currentLoad),
    perCore: Array.isArray(load?.cpus) ? load.cpus.map((c: any) => core.pct(c.load)) : [],
    loadavg: os.loadavg(),
    temp: undefined as number | null | undefined,
  };

  // Temperature — cached 5s; null when the platform cannot provide it. A
  // consecutive-miss streak flags the client to render the setup hint.
  let temp = tempCache.get("temp");
  if (temp === undefined) {
    try {
      const t = await s.cpuTemperature();
      temp = core.pickTemp(t?.main);
    } catch { temp = null; }
    tempCache.set("temp", temp);
    if (temp == null) tempMissStreak++; else tempMissStreak = 0;
  }
  out.cpu.temp = temp == null ? null : temp;
  if (temp == null) out.tempHint = true;

  // Sensors — full chip list (lm-sensors style). When the platform-specific CPU
  // temperature is unavailable but a known CPU sensor exists in the list, derive
  // cpu.temp from it (k10temp / zenpower / coretemp / cpu_thermal).
  const sensors = readHwmonSensors();
  out.sensors = sensors;
  if (out.cpu.temp == null && sensors.length) {
    const cpuSensor = sensors.find((s: HwmonSensor) => /k10temp|zenpower|coretemp|cpu_thermal/i.test(s.chip));
    if (cpuSensor) out.cpu.temp = cpuSensor.temp;
  }

  // Memory.
  try {
    const m = await s.mem();
    out.mem = {
      total: m.total, used: m.used, free: m.free,
      swapTotal: m.swaptotal, swapUsed: m.swapused,
    };
  } catch { out.mem = null; }

  // Disks — 30s TTL (fsSize shells out to df on some platforms).
  let disks: any = diskCache.get("disks");
  if (disks === undefined) {
    try {
      disks = (await s.fsSize()).map((d: any) => ({
        fs: d.fs, mount: d.mount, type: d.type || "",
        used: d.used, total: d.size, use: core.pct(d.use),
      }));
    } catch { disks = []; }
    diskCache.set("disks", disks);
  }
  out.disks = disks;

  // Network — "*" = all interfaces ("**" collapses to an empty row on some hosts);
  // rx_sec/tx_sec are si deltas between consecutive calls (null on the very first).
  // Filter loopback/virtual noise (docker bridges, veth pairs); keep real NICs and
  // VPN/tunnel ifaces, plus anything that actually carried traffic.
  try {
    const nets = await s.networkStats("*");
    out.net = (nets || [])
      .filter((n: any) => n.iface
        && !/^(lo$|veth|br-|docker0|virbr)/.test(n.iface)
        && (n.operstate === "up" || n.rx_bytes > 0 || n.tx_bytes > 0))
      .map((n: any) => ({
        iface: n.iface,
        rxSec: n.rx_sec, txSec: n.tx_sec,
        rxTotal: n.rx_bytes, txTotal: n.tx_bytes,
        operState: n.operstate || "",
      }));
  } catch { out.net = []; }

  return out;
}

export default {
  id: "aiti-sysmon",
  name: "系统状态（服务器 CPU/内存/磁盘/网络/温度）",
  icon: "icon.svg",
  client: "dist/aiti-sysmon-client.mjs",
  // Client load-order hint: the auto-dock in register() talks to the aiti-float state machine.
  clientDependsOn: ["aiti-float"],

  // AI self-management (aiti-helper): intro only — no skills in v1.
  ai: {
    manage: true,
    intro: "AI 能帮我查看 pi-web 所在服务器的实时状态（CPU/内存/磁盘/网络/温度），并在温度显示 N/A 时指导安装 lm-sensors 启用温度监控（aiti-sysmon）",
  },

  ui: {
    // Eager bundle: the auto-dock restore-default-presence in register() needs the
    // client to run at page start (a lazy dock-only extension has no entry point).
    clientImmediately: true,
    // Left sidebar dock static slot (registered item takes over on load).
    sidebarExplorerDock: [{ id: "panel", label: "i18n:sy.panel.label", icon: "icons/gauge.svg" }],
    i18n: {
      // Bilingual tables (zh-CN identity + en) per the model-check convention:
      // client copy keys are the raw Chinese strings; en table hand-translated.
      "zh-CN": {
        "sy.panel.label": "系统状态",
        "ext.displayName": "服务器状态查看器",
        "暂停": "暂停",
        "恢复": "恢复",
        "刷新": "刷新",
        "已运行": "已运行",
        "负载": "负载",
        "每核占用": "每核占用",
        "核": "核",
        "温度": "温度",
        "温度不可用": "温度不可用",
        "已暂停": "已暂停",
        "快照错误": "快照错误",
        "传感器": "传感器",
        "如何启用？": "如何启用？",
        "打开配置指南": "打开配置指南",
      },
      en: {
        "sy.panel.label": "System Status",
        "ext.displayName": "Server Status Viewer",
        "暂停": "Pause",
        "恢复": "Resume",
        "刷新": "Refresh",
        "已运行": "up",
        "负载": "load",
        "每核占用": "per-core load",
        "核": "cores",
        "温度": "TEMP",
        "温度不可用": "Temp N/A",
        "已暂停": "paused",
        "快照错误": "snapshot error",
        "传感器": "Sensors",
        "如何启用？": "How to enable?",
        "打开配置指南": "Open setup guide",
      },
    },
  },

  features: [
    {
      id: "interval",
      type: "string",
      label: "轮询间隔（秒）",
      group: "采样",
      description: "面板展开时的快照轮询间隔秒数（默认 3；非法值回退默认）。面板折叠或页面隐藏时不采样，服务端零常驻开销。",
      value: "3",
      placeholder: "3",
    },
    {
      id: "showSensors",
      type: "boolean",
      label: "显示 CPU 温度",
      group: "采样",
      description: "显示 CPU 温度（Linux 需安装 lm-sensors；读不到时显示 N/A 并给出配置指引链接）。",
      default: true,
    },
  ],

  server: {
    startup() {
      // Fail fast into a logged warning (never throw — a missing dep must not
      // break extension load; the API responds 503 with an install hint).
      if (!loadSi()) {
        console.warn("[aiti-sysmon] systeminformation not resolvable yet — extman reconcile will install it; API returns 503 until then (" + siError + ")");
      }
    },

    async shutdown() { /* no persistent resources */ },

    async api(req: Request, ctx: any) {
      if (ctx.method !== "GET") return json({ error: "method not allowed" }, 405);
      const [action] = ctx.path;
      if (action === "snapshot") {
        try {
          return json(await buildSnapshot());
        } catch (e: any) {
          if (e?.code === "SI_MISSING") return json({ error: e.message }, 503);
          return json({ error: String(e?.message || e) }, 500);
        }
      }
      return null;
    },
  },
};
