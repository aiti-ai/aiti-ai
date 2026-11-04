/**
 * aiti-claude-code-agent · 受控登录 client（薄壳，paste-relay 模式）。
 *
 * 全部 UI/轮询/文案模板在 ./controlled-login-dialog.mjs
 * （权威源 pi-web-ext/_shared/controlled-login-dialog.mjs 的部署副本，改动须双向同步）——
 * 本文件只传扩展专属配置。
 */
import { registerControlledLoginClient } from "./controlled-login-dialog.mjs";

export default function register(ctx) {
  registerControlledLoginClient(ctx, {
    extId: "aiti-claude-code-agent",
    toolbarLabel: "登录 Claude Code",
    title: "登录 Claude Code",
    pasteHint:
      "后端发起官方 claude auth login（Claude 订阅档），把授权链接交给你——" +
      "在任意设备的浏览器打开并登录授权后，Claude 的完成页会显示一段一次性 code：" +
      "把它（或整个回调链接）复制到下方输入框提交，后端原样喂给 login 进程即完成登录。" +
      "code 一次性且时效短，请拿到后尽快提交。",
    successHint: null,
  });
}
