/**
 * aiti-zcode-agent · 受控登录 client（薄壳）。
 *
 * 全部 UI/轮询/文案模板在 ./controlled-login-dialog.mjs
 * （权威源 pi-web-ext/_shared/controlled-login-dialog.mjs 的部署副本，改动须双向同步）——
 * 本文件只传扩展专属配置。
 */
import { registerControlledLoginClient } from "./controlled-login-dialog.mjs";

export default function register(ctx) {
  registerControlledLoginClient(ctx, {
    extId: "aiti-zcode-agent",
    toolbarLabel: "登录 ZCode",
    title: "登录 ZCode（z.ai 编程套餐）",
    urlHint:
      "后端发起官方 zcode login，把授权链接交给你——在任意设备的浏览器打开并登录 Z.AI 账号授权即可；" +
      "凭据由官方 CLI 自动落盘并静默换取 coding-plan key，本页约 2s 内自动感知（窗口约 5 分钟）。" +
      "注意：受控登录仅支持 z.ai 通道；bigmodel 国内套餐请用 zcode.apiKeyOverride 手动填 key。",
    pasteHint: null,
    successHint: "凭据已落盘，正在后台静默换取 key，下轮对话自动生效。",
  });
}
