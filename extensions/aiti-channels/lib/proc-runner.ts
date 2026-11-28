/**
 * aiti-channels · proc-runner — detached process runner for cc-connect instances.
 *
 * Modeled on the pi-web host runner (lib/agent-starter/runner.ts) but scoped to
 * long-lived daemons: the wrapper PROGRAM is intentionally NOT reused (it is
 * session semantics — socket child hosting + idle reap would reap an idle
 * cc-connect); we only borrow the runner decision matrix.
 *
 * Three runner kinds (decided ONCE per start, spawn itself never branches):
 *   systemd-run  Linux with a reachable user manager: a transient user unit
 *                (`aiti-cc-<instanceId>`) in user.slice — immune to pi-web
 *                service restarts (that kills pi-web's cgroup, not the user
 *                manager's). Stop = `systemctl --user stop` (cgroup-wide kill,
 *                graceful TimeoutStopSec). Logs still go to the instance log
 *                file via StandardOutput/Error=append:.
 *   plain        macOS / containers / no systemd user manager: detached spawn
 *                with its own session (the historical behavior; survives a
 *                pi-web restart but not a cgroup-wide kill of pi-web's unit).
 *   windows-cim  Windows has no setsid: Win32_Process.Create starts the
 *                process outside the caller's console/job (the only mechanism
 *                that survived there; probed 2026-09). Log redirection via a
 *                `cmd /c ... >> log 2>&1` wrapper; stop stays taskkill /T /F.
 *
 * Overrides: AITI_CC_RUNNER=systemd|plain forces one (verification matrix
 * semantics, same as PI_AGENT_STARTER_RUNNER on the host side).
 *
 * Dual-regime migration: instances started by the old setsid+pid-file path are
 * still recognized (pid file + findRunning); the next restart naturally lands
 * on the systemd kind. Runtime regime is recorded in <dataDir>/runtime.json.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { platform } from "node:os";

export type RunnerKind = "systemd-run" | "plain" | "windows-cim";

export type RunnerProbe = {
  kind: RunnerKind;
  /** Env overrides the launcher needs (systemd user bus coordinates). */
  env: Record<string, string>;
  /** Human-readable explanation (logged once per start). */
  detail: string;
};

/** Coordinates of this user's systemd user manager (logind keeps it alive). */
export function userManagerEnv(uid?: number): Record<string, string> {
  if (uid === undefined) return {};
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  const bus = join(runtimeDir, "bus");
  if (!existsSync(runtimeDir) || !existsSync(bus)) return {};
  return {
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${bus}`,
  };
}

function probeSystemdRunAlive(env: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", "is-system-running"], { env: { ...process.env, ...env }, timeout: 4000 }, (err, stdout) => {
      if (err) {
        // "degraded" still means the manager answers D-Bus; only a hard failure
        // (no bus / no manager) disqualifies the runner.
        const state = String(stdout ?? "").trim();
        resolve(state === "degraded" || state === "starting");
        return;
      }
      resolve(true);
    });
  });
}

/**
 * Pure decision matrix (unit-tested): given platform/bin/bus facts, pick the
 * runner kind. Order matches the host runner: forced > windows-cim > non-linux
 * plain > systemd-run probe > plain.
 */
export function decideRunner(facts: {
  platform: NodeJS.Platform;
  forced?: string;
  hasSystemdRunBin: boolean;
  hasUserBus: boolean;
  managerAlive: boolean;
}): { kind: RunnerKind; detail: string } {
  const forced = (facts.forced || "").trim().toLowerCase();
  if (forced === "systemd") return { kind: "systemd-run", detail: "forced by AITI_CC_RUNNER=systemd" };
  if (forced === "plain") return { kind: "plain", detail: "forced by AITI_CC_RUNNER=plain" };
  if (facts.platform === "win32") return { kind: "windows-cim", detail: "windows: Win32_Process.Create (no console/job inheritance)" };
  if (facts.platform !== "linux") return { kind: "plain", detail: `platform ${facts.platform} (no systemd user manager)` };
  if (!facts.hasSystemdRunBin) return { kind: "plain", detail: "systemd-run not installed" };
  if (!facts.hasUserBus) return { kind: "plain", detail: "systemd user manager unreachable (no /run/user/<uid>/bus)" };
  if (!facts.managerAlive) return { kind: "plain", detail: "systemd user manager not answering" };
  return { kind: "systemd-run", detail: "systemd user manager reachable" };
}

/** Async probe wrapper around decideRunner (never throws; degrades to plain).
 *  Liveness is verified AFTER the static matrix (async can't feed the pure
 *  decide): assume-alive first, then downgrade when the manager won't answer. */
export async function probeRunner(): Promise<RunnerProbe> {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const env = userManagerEnv(uid);
  const facts = {
    platform: platform(),
    forced: process.env.AITI_CC_RUNNER,
    hasSystemdRunBin: existsSync("/usr/bin/systemd-run") || existsSync("/bin/systemd-run"),
    hasUserBus: Object.keys(env).length > 0,
    managerAlive: true, // assumption — verified by the live probe below
  };
  const decided = decideRunner(facts);
  if (decided.kind !== "systemd-run") return { kind: decided.kind, env, detail: decided.detail };
  const alive = await probeSystemdRunAlive(env);
  return alive
    ? { kind: "systemd-run", env, detail: decided.detail }
    : { kind: "plain", env, detail: "systemd user manager not answering" };
}

/** Transient unit name for an instance (stable per instance id, systemd-safe). */
export function unitNameFor(instanceId: string): string {
  const safe = String(instanceId || "default").replace(/[^A-Za-z0-9:_.\-]/g, "_").slice(0, 120);
  return `aiti-cc-${safe}`;
}

/** Is a transient unit still loaded (active or on its way there/out)? A unit
 *  whose name is taken must not be spawned again (systemd-run would refuse). */
export function unitBusy(unit: string, env: Record<string, string> = {}): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", "is-active", unit], { env: { ...process.env, ...env }, timeout: 4000 }, (_err, stdout) => {
      const state = String(stdout ?? "").trim();
      resolve(state === "active" || state === "activating" || state === "reloading" || state === "deactivating");
    });
  });
}

export type LaunchOpts = {
  bin: string;
  config: string;
  logFile: string;
  unit: string;
  env: Record<string, string>;
};

/** Start under a transient systemd user unit; the launcher exits immediately
 *  and the daemon lives in user.slice. stdout/stderr append to the instance
 *  log file so the panel log tab keeps working across regimes. */
export function launchSystemd(o: LaunchOpts): Promise<{ unit: string }> {
  const args = [
    "--user", "--quiet", "--collect",
    "--unit", o.unit,
    "--property", "Type=simple",
    "--property", "TimeoutStopSec=10",
    "--property", "KillMode=mixed",
    "--property", `StandardOutput=append:${o.logFile}`,
    "--property", `StandardError=append:${o.logFile}`,
    "--",
    o.bin, "-config", o.config,
  ];
  return new Promise((resolve, reject) => {
    execFile("systemd-run", args, { env: { ...process.env, ...o.env }, timeout: 15000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`systemd-run failed: ${err.message}${stderr ? ` (${String(stderr).trim()})` : ""}`));
      else resolve({ unit: o.unit });
    });
  });
}

/** Windows detached start via Win32_Process.Create (outside console/job);
 *  log redirection via a cmd wrapper (CIM cannot redirect stdio itself). */
export function launchWindowsCim(o: LaunchOpts): Promise<{ launcherPid?: number }> {
  const quote = (arg: string) => `"${arg.replace(/"/g, '\\"')}"`;
  const inner = [quote(o.bin), "-config", quote(o.config), ">>", quote(o.logFile), "2>&1"].join(" ");
  const commandLine = `cmd /c ${inner}`;
  const ps = [
    "$ErrorActionPreference='Stop'",
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}' }`,
    "Write-Output $r.ProcessId",
  ].join("; ");
  return new Promise((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`Win32_Process.Create failed: ${err.message}${stderr ? ` (${String(stderr).trim()})` : ""}`));
      else {
        const pid = Number(String(stdout).trim().split(/\s+/).pop());
        resolve(Number.isFinite(pid) && pid > 0 ? { launcherPid: pid } : {});
      }
    });
  });
}

/** plain detached spawn (macOS/containers/fallback) — the historical path:
 *  own session, stdio appended to the instance log file, unref'ed. */
export function launchPlain(o: LaunchOpts): Promise<{ pid: number }> {
  return new Promise((resolve, reject) => {
    let fd: number;
    try {
      mkdirSync(dirname(o.logFile), { recursive: true });
      fd = openSync(o.logFile, "a");
    } catch (e) {
      reject(e as Error);
      return;
    }
    const child = spawn(o.bin, ["-config", o.config], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, ...o.env },
      windowsHide: true, // win32: detached console programs open a visible window in service context — suppress
      cwd: "/",
    });
    child.unref();
    closeSync(fd);
    child.on("error", reject);
    // pid is available synchronously; resolve on next tick so spawn errors
    // (ENOENT etc.) have a chance to surface first.
    setImmediate(() => resolve({ pid: child.pid || 0 }));
  });
}

/** Stop a transient unit and wait for systemctl to accept the stop. */
export function stopUnitAndWait(unit: string, env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", "stop", unit], { timeout: 12_000, env: { ...process.env, ...env } }, () => resolve());
  });
}

/** Best-effort stop of a half-started launcher (ready-wait timeout path). */
export function stopLauncher(kind: RunnerKind, unit: string | undefined, pid: number | undefined, env: Record<string, string> = {}): void {
  if (kind === "systemd-run" && unit) {
    execFile("systemctl", ["--user", "stop", unit], { timeout: 5000, env: { ...process.env, ...env } }, () => {
      /* best effort: the unit may already be gone */
    });
    return;
  }
  if (pid) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

// ---------- runtime regime registry (<dataDir>/runtime.json) ----------

export type RuntimeRegime = {
  runner: RunnerKind;
  unit?: string;
  pid?: number;
  startedAt: string;
};

export function runtimeFile(dataDir: string): string {
  return join(dataDir, "runtime.json");
}

export function readRuntime(dataDir: string): RuntimeRegime | null {
  try {
    const raw = readFileSync(runtimeFile(dataDir), "utf8");
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object" || !d.runner) return null;
    return d as RuntimeRegime;
  } catch {
    return null;
  }
}

export function writeRuntime(dataDir: string, r: RuntimeRegime): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(runtimeFile(dataDir), JSON.stringify(r, null, 2));
}

export function clearRuntime(dataDir: string): void {
  try { rmSync(runtimeFile(dataDir), { force: true }); } catch { /* ignore */ }
}
