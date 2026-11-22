/**
 * aiti-qoder-agent · 受控登录 driver（外部 Agent 受控登录标准，共享层 controlled-login.mjs）。
 *
 * 独立成模块的原因：index.ts 顶部有 WASM 客户端预热副作用（createClient），driver 要进
 * 无副作用测试面（_shared/controlled-login.test.mjs fixture），不能拉它。
 *
 * 模式 A url-only：spawn `qodercli|qoderclicn login` + NO_BROWSER=true（官方无浏览器通道，
 * URL 抓取实测 qodercli 1.1.17：stdout `https://…/device/selectAccounts?challenge&nonce&…`）。
 * cn/intl 两变体域名不同（qoder.com.cn / qoder.com）——正则不钉域名，CLI 自己按 HOME 定。
 */
// 受控登录共享层（权威源 pi-web-ext/_shared/controlled-login.mjs，副本随扩展部署——改动须双向同步）
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { whichBin } from "@aiti-ai/ext-shared/exec-async";
import { cleanEnv, tailLine } from "@aiti-ai/ext-shared/controlled-login";

export type { QoderVariant } from "./variants.ts";
import type { QoderVariant } from "./variants.ts";

/** login CLI 路径（与 index.ts QoderHandle.start 同源：env 覆盖 > 约定名）。 */
export function qoderLoginBin(variant: QoderVariant): string {
  return variant === "cn"
    ? (process.env.QODER_CLI_CN_PATH || "qoderclicn")
    : (process.env.QODER_CLI_PATH || "qodercli");
}

/**
 * CLI 二进制解析：PATH 命中 > 安装位兜底 > null。
 * Windows 实测装态：qoderclicn 落在 ~/.qoder-cn/bin/qoderclicn/qoderclicn.exe 且 PATH 上
 * 只有 IDE 命令 `qoder`（D:\apps\Qoder\bin，code 式启动器非 agent CLI）——只认 PATH 会漏注册。
 * intl 同构目录 ~/.qoder/bin/qodercli/ 一并兜底。home 参数仅供测试注入。
 */
export function resolveQoderCli(variant: QoderVariant, home = homedir()): string | null {
  // Windows 坑：whichBin 对 PATH 上的同名**目录**也放行（X_OK 对目录恒真，实测
  // ~/.qoder-cn/bin 在 PATH 时命中目录 bin/qoderclicn），spawn 目录必挂——只认文件
  const isFile = (p: string | null): p is string => {
    if (!p) return false;
    try { return statSync(p).isFile(); } catch { return false; }
  };
  const bin = qoderLoginBin(variant);
  const hit = whichBin(bin);
  if (isFile(hit)) return hit;
  const exe = process.platform === "win32" ? `${bin}.exe` : bin;
  const p = join(home, variant === "cn" ? ".qoder-cn" : ".qoder", "bin", bin, exe);
  return existsSync(p) && isFile(p) ? p : null;
}

/** login URL 抓取（设备选择页，两区域域名都命中）。 */
export function extractQoderLoginUrl(text: string): string | null {
  const m = /https?:\/\/\S*\/device\/selectAccounts\?\S+/.exec(text);
  return m ? m[0] : null;
}

/** 结果判定：退出码 0 → success；其余 failed（尾行透出）。 */
export function interpretQoderLogin(code: number | null, stdout: string, stderr: string): { state: "success" | "failed"; error?: string } {
  if (code === 0) return { state: "success" };
  return { state: "failed", error: tailLine(stderr) || tailLine(stdout) || `qodercli login 异常退出（code=${code ?? "signal"}）` };
}

export const qoderLoginDriver = {
  agentId: "qoder",
  mode: "url" as const,
  loginTimeoutMs: 330_000,
  buildLogin: ({ runtime }: { runtime: string }) => ({
    cmd: runtime,
    args: ["login"],
    env: cleanEnv({ NO_BROWSER: "true" }),
  }),
  extractUrl: extractQoderLoginUrl,
  interpret: interpretQoderLogin,
};
