/**
 * Runner selection for the detachable wrapper — the ONLY place that decides
 * "how do we start a process that outlives pi-web".
 *
 * Two variants, both constructed once (Factory pattern) so `spawn()` itself
 * never branches:
 *
 *   systemd-run  Linux with a reachable user manager: a transient unit in
 *                `user.slice`, immune to `systemctl restart pi-web` (which
 *                kills the service's cgroup, not the user manager's).
 *   plain        everything else (macOS, containers, a machine where the user
 *                manager is unreachable): a detached process with its own
 *                session. Survives a pi-web restart, but NOT a cgroup-wide
 *                kill of pi-web's unit (`KillMode=control-group`).
 *
 * PI_AGENT_STARTER_RUNNER=systemd|plain forces one (verification matrix T6b
 * needs the degraded path on purpose); PI_WEB_AGENT_DETACH=0 disables the
 * wrapper family entirely (upstream of this file).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { RunnerKind } from "./registry.ts";

export type RunnerProbe = {
  kind: RunnerKind;
  /** Env overrides the wrapper's launcher needs (systemd user bus coordinates). */
  env: Record<string, string>;
  /** Human-readable explanation (logged once when the starter is built). */
  detail: string;
};

/** Coordinates of this user's systemd user manager (logind keeps it alive). */
function userManagerEnv(): Record<string, string> | undefined {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) return undefined;
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  const bus = join(runtimeDir, "bus");
  if (!existsSync(runtimeDir) || !existsSync(bus)) return undefined;
  return {
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${bus}`,
  };
}

function probeSystemdRun(env: Record<string, string>): Promise<boolean> {
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
 * Pick the runner once per process. Never throws: an unreachable systemd
 * silently degrades to the plain variant (documented behavior).
 */
export async function probeRunner(): Promise<RunnerProbe> {
  const forced = (process.env.PI_AGENT_STARTER_RUNNER || "").trim().toLowerCase();
  const env = userManagerEnv() ?? {};
  if (forced === "plain") return { kind: "plain", env, detail: "forced by PI_AGENT_STARTER_RUNNER=plain" };
  if (forced === "systemd") return { kind: "systemd-run", env, detail: "forced by PI_AGENT_STARTER_RUNNER=systemd" };
  if (process.platform === "win32") {
    // Windows has no setsid: a plainly detached child dies with its console/job, and
    // `detached: true` is not enough (probed on a Windows box: the child stopped as
    // soon as the launching session ended). Win32_Process.Create starts the process
    // outside the caller's console/job — the only mechanism that survived there.
    return { kind: "windows-cim", env, detail: "windows: Win32_Process.Create (no console/job inheritance)" };
  }
  if (process.platform !== "linux") return { kind: "plain", env, detail: `platform ${process.platform} (no systemd user manager)` };
  if (!existsSync("/usr/bin/systemd-run") && !existsSync("/bin/systemd-run")) {
    return { kind: "plain", env, detail: "systemd-run not installed" };
  }
  if (Object.keys(env).length === 0) return { kind: "plain", env, detail: "systemd user manager unreachable (no /run/user/<uid>/bus)" };
  const alive = await probeSystemdRun(env);
  return alive
    ? { kind: "systemd-run", env, detail: "systemd user manager reachable" }
    : { kind: "plain", env, detail: "systemd user manager not answering" };
}

/** Transient unit name for a wrapper (stable per session key, systemd-safe). */
export function unitNameFor(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9:_.\-]/g, "_").slice(0, 120);
  return `pi-agent-${safe}`;
}

/**
 * Start the wrapper program and return a handle on the launcher process (the
 * launcher exits immediately for systemd-run; for the plain variant it IS the
 * wrapper, detached and unref'ed).
 */
export function launchWrapper(options: {
  runner: RunnerKind;
  nodePath: string;
  wrapperPath: string;
  configPath: string;
  key: string;
  env: Record<string, string>;
}): Promise<{ launcherPid?: number; unit?: string }> {
  const { runner, nodePath, wrapperPath, configPath, key, env } = options;
  if (runner === "systemd-run") {
    const unit = unitNameFor(key);
    const args = [
      "--user",
      "--quiet",
      "--collect",
      "--unit", unit,
      "--property", "Type=simple",
      "--property", "TimeoutStopSec=10",
      "--property", "KillMode=mixed",
      "--",
      nodePath,
      wrapperPath,
      "--config", configPath,
    ];
    return new Promise((resolve, reject) => {
      execFile(
        "systemd-run",
        args,
        { env: { ...process.env, ...env }, timeout: 15000 },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`systemd-run failed: ${err.message}${stderr ? ` (${String(stderr).trim()})` : ""}`));
            return;
          }
          resolve({ unit });
        },
      );
    });
  }
  if (runner === "windows-cim") {
    // CommandLine is the whole argv as one string; quoting is the wrapper path only
    // (the config path is generated by us and never contains quotes).
    const commandLine = `"${nodePath}" "${wrapperPath}" --config "${configPath}"`;
    const ps = [
      "$ErrorActionPreference='Stop'",
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}' }`,
      "Write-Output $r.ProcessId",
    ].join("; ");
    return new Promise((resolve, reject) => {
      execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 20000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Win32_Process.Create failed: ${err.message}${stderr ? ` (${String(stderr).trim()})` : ""}`));
          return;
        }
        const pid = Number(String(stdout).trim().split(/\s+/).pop());
        resolve(Number.isFinite(pid) && pid > 0 ? { launcherPid: pid } : {});
      });
    });
  }
  const child = spawn(nodePath, [wrapperPath, "--config", configPath], {
    detached: true,
    stdio: "ignore",
    cwd: "/",
    env: { ...process.env, ...env },
  });
  child.unref();
  return Promise.resolve({ launcherPid: child.pid });
}

/** Best-effort stop of a half-started wrapper (ready-wait timeout path). */
export function stopLauncher(
  runner: RunnerKind,
  unit: string | undefined,
  pid: number | undefined,
  env: Record<string, string> = {},
): void {
  if (runner === "systemd-run" && unit) {
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
