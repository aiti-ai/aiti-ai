/**
 * aiti-bridge 生命周期管理：健康探测 → 已跑则复用（不重复起桥），未跑则子进程拉起
 * - 只停自己拉起的桥（预先在跑的独立桥/systemd 桥绝不代杀）
 * - 日志环形缓冲（面板展示 tail）
 * - Windows 兼容：spawn 参数数组不走 shell；停树 taskkill /T /F（见 docs/windows-compat-lessons.md §0）
 */
import { spawn, type ChildProcess } from "child_process";

const READINESS_DEADLINE_MS = 6000;
const READINESS_TICK_MS = 150; // 有界就绪等待（子进程启动必需，非 UI 轮询）
const LOG_CAP = 200;

export class BridgeManager {
  private proc: ChildProcess | undefined;
  private logs: string[] = [];
  private expectStop = false;
  /** 是否由本扩展拉起（决定 stop 是否有权限） */
  spawnedHere = false;
  /** 外部已在跑的桥被本扩展复用（面板展示用） */
  reusedExternal = false;
  /** 桥意外退出（面板/状态栏提示用） */
  crashed = false;

  constructor(
    public readonly port: number,
    private spawnOpts: { assetsDir?: string; dataDir?: string } = {},
  ) {}

  get bridgeBase(): string {
    return `http://127.0.0.1:${this.port}/aiti`;
  }

  get running(): boolean {
    return !!this.proc && !this.proc.killed && this.proc.exitCode === null;
  }

  async healthy(): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 800);
      const res = await fetch(`${this.bridgeBase}/bridge/sessions`, { signal: ctl.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  private log(line: string): void {
    this.logs.push(`${new Date().toLocaleTimeString()} ${line}`);
    if (this.logs.length > LOG_CAP) this.logs.splice(0, this.logs.length - LOG_CAP);
  }

  /**
   * 确保桥可用：已健康 → "already"（复用，不动别人的桥）；
   * 未健康 → 以子进程拉起并等就绪；超时抛错（带日志 tail）。
   */
  async ensureRunning(bridgePath: string): Promise<"already" | "started"> {
    if (await this.healthy()) {
      this.log(`reusing an already-running bridge (port ${this.port})`);
      return "already";
    }
    this.stop(); // 清理可能的残留子进程
    this.expectStop = false;
    this.crashed = false;
    this.log(`spawn ${bridgePath} --port ${this.port}`);
    const args = [bridgePath, "--port", String(this.port)];
    if (this.spawnOpts.assetsDir) args.push("--assets", this.spawnOpts.assetsDir);
    if (this.spawnOpts.dataDir) args.push("--data-dir", this.spawnOpts.dataDir);
    this.proc = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, // 扩展宿主是 Electron，子进程要显式按 Node 跑
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.spawnedHere = true;
    const proc = this.proc;
    proc.stdout?.on("data", (d: Buffer) => this.log(d.toString().trimEnd()));
    proc.stderr?.on("data", (d: Buffer) => this.log(d.toString().trimEnd()));
    proc.on("exit", (code) => {
      this.log(`bridge exited (code=${code})`);
      if (!this.expectStop) this.crashed = true;
      this.proc = undefined;
      this.spawnedHere = false;
    });
    const deadline = Date.now() + READINESS_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (await this.healthy()) {
        this.log(`bridge ready: ${this.bridgeBase}`);
        return "started";
      }
      if (!this.running) throw new Error(`bridge process exited immediately (code=${proc.exitCode})\n${this.tailLogs()}`);
      await new Promise((r) => setTimeout(r, READINESS_TICK_MS));
    }
    throw new Error(`bridge readiness timeout after ${READINESS_DEADLINE_MS}ms\n${this.tailLogs()}`);
  }

  /** 停止（仅本扩展拉起的桥；外部桥不代杀） */
  stop(): void {
    const proc = this.proc;
    if (!proc?.pid) return;
    this.expectStop = true;
    if (process.platform === "win32") {
      // Windows：直接 kill 只杀父进程，桥可能留下孤儿 → 树杀
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
      setTimeout(() => { if (proc.exitCode === null) proc.kill("SIGKILL"); }, 2000);
    }
    this.proc = undefined;
    this.spawnedHere = false;
    this.log(`bridge stopped (pid=${proc.pid})`);
  }

  tailLogs(n = 30): string {
    return this.logs.slice(-n).join("\n") || " (no logs)";
  }
}
