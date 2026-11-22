/**
 * aiti-qoder-agent · 受控登录 client（薄壳）。
 *
 * 全部 UI/轮询/文案模板在 ./controlled-login-dialog.mjs
 * （权威源 pi-web-ext/_shared/controlled-login-dialog.mjs 的部署副本，改动须双向同步）——
 * 本文件只传扩展专属配置。
 */
import { registerControlledLoginClient } from "./controlled-login-dialog.mjs";

export default function register(ctx) {
  registerControlledLoginClient(ctx, {
    extId: "aiti-qoder-agent",
    toolbarLabel: "登录 Qoder",
    title: "登录 Qoder",
    urlHint:
      "后端发起官方 qodercli/qoderclicn login（无浏览器通道），把授权链接交给你——在任意设备的浏览器打开并登录 Qoder 账号授权即可；" +
      "凭据由官方 CLI 自动落盘（cn/intl 变体按本机安装自动选择），本页约 2s 内自动感知。" +
      "若本机无密钥环导致失败，可改用 qoder-pat 档（个人访问令牌）登录。",
    pasteHint: null,
    successHint: "登录完成后 credits/模型目录能力自动恢复（WASM 客户端按凭据文件重读）。",
  });
}
