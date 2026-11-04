/**
 * aiti-codex-agent · 受控登录 client（薄壳）。
 *
 * 全部 UI/轮询/文案模板在 ./controlled-login-dialog.mjs
 * （权威源 pi-web-ext/_shared/controlled-login-dialog.mjs 的部署副本，改动须双向同步）——
 * 本文件只传扩展专属配置。
 */
import { registerControlledLoginClient } from "./controlled-login-dialog.mjs";

export default function register(ctx) {
  registerControlledLoginClient(ctx, {
    extId: "aiti-codex-agent",
    toolbarLabel: "登录 Codex",
    title: "登录 Codex（设备码）",
    urlHint:
      "后端发起官方 `codex login --device-auth`（设备码模式，远程/headless 官方推荐），把授权链接交给你——" +
      "在任意设备的浏览器打开并登录 ChatGPT/OpenAI 账号授权即可；凭据由官方 CLI 自动落盘，本页约 2s 内自动感知。",
    pasteHint: null,
    successHint: null,
  });
}
