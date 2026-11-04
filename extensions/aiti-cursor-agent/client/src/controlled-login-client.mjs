/**
 * aiti-cursor-agent · 受控登录 client（薄壳）。
 *
 * 全部 UI/轮询/文案模板在 ./controlled-login-dialog.mjs
 * （权威源 pi-web-ext/_shared/controlled-login-dialog.mjs 的部署副本，改动须双向同步）——
 * 本文件只传扩展专属配置。
 */
import { registerControlledLoginClient } from "./controlled-login-dialog.mjs";

export default function register(ctx) {
  registerControlledLoginClient(ctx, {
    extId: "aiti-cursor-agent",
    toolbarLabel: "登录 Cursor",
    title: "登录 Cursor",
    urlHint:
      "后端发起官方 cursor login（无浏览器通道），把授权链接交给你——在任意设备的浏览器打开并登录 Cursor 账号授权即可；" +
      "凭据由官方 CLI 自动落盘，本页约 2s 内自动感知。" +
      "若本机无密钥环（headless 常见）导致登录失败，可给 pi-web 服务设置 AGENT_CREDENTIAL_STORE=file 后重试。",
    pasteHint: null,
    successHint: null,
  });
}
