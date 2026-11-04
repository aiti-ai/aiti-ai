/**
 * aiti-channels · platform 参数 schema —— 从 cc-connect 源码逐平台提取（2026-08-29 实证）
 *
 * 来源：/home/pi/workspace/cc-connect/platform/<type>/*.go 的 New() opts 读取 + required 校验。
 * 用途：
 *   1. 前端表单按 schema 动态渲染（每类型字段不同，替换旧的三件套 client_id/client_secret/agent_id）
 *   2. config-gen 按 fields 任意键值渲染 TOML（不再固定四字段）
 *   3. wizard 标记：feishu/weixin 支持 cc-connect 官方扫码授权（management /setup/<p>/begin|poll），
 *      面板「扫码授权」按钮经 aiti-channels 代理端点转发，授权完成自动回填凭证。
 *
 * 字段：key（TOML 键）label（中文）required*（缺失 cc-connect 启动报错）secret（password 框）
 *       ph（placeholder）num（数字）可选字段只列高频项，其余 cc-connect 均有默认值。
 */
export interface PlatformField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  num?: boolean;
  ph?: string;
}

export interface PlatformGuide {
  steps: string[];                    // 申请/获取凭证步骤
  link?: { label: string; url: string }; // 官方入口
  note?: string;                      // 额外说明（Stream 免公网、需公网回调等）
}

export interface PlatformSchema {
  type: string;      // cc-connect platform type（config.toml 的 platforms[].type）
  label: string;     // 中文名
  wizard?: "feishu" | "weixin"; // 支持官方扫码授权
  guide: PlatformGuide;
  fields: PlatformField[];
}

export const PLATFORM_SCHEMAS: PlatformSchema[] = [
  {
    type: "dingtalk", label: "钉钉",
    guide: {
      steps: [
        "登录钉钉开放平台（企业内部应用权限），应用开发 → 创建应用",
        "凭证与基础信息页：复制 AppKey（client_id）和 AppSecret（client_secret）",
        "应用能力 → 添加机器人 → 选 Stream 模式（免公网 IP）",
        "基础信息页复制 AgentId（数字，发工作通知必需）",
        "版本管理与发布 → 发布应用，然后在钉钉里搜机器人名字发消息即可激活会话",
      ],
      link: { label: "钉钉开放平台", url: "https://open-dev.dingtalk.com/" },
      note: "Stream 模式无需公网 IP/域名，本机直连钉钉服务器",
    },
    fields: [
      { key: "client_id", label: "AppKey (client_id)", required: true, ph: "钉钉开放平台应用 AppKey" },
      { key: "client_secret", label: "AppSecret (client_secret)", required: true, secret: true, ph: "钉钉应用 AppSecret" },
      { key: "agent_id", label: "AgentId", num: true, ph: "应用 AgentId（数字，工作通知必需）" },
      { key: "allow_from", label: "白名单 allow_from（可选）", ph: "员工 staffId，逗号分隔；空=不限" },
    ],
  },
  {
    type: "feishu", label: "飞书 / Lark", wizard: "feishu",
    guide: {
      steps: [
        "推荐：直接点下方「📱扫码授权」，飞书扫码后自动创建应用并回填 AppID/Secret",
        "手动方式：飞书开放平台 → 创建企业自建应用 → 凭证页复制 App ID / App Secret",
        "应用能力 → 添加机器人；权限开通 im:message 等；事件订阅选长连接模式",
        "版本管理与发布 → 发布，然后在飞书里给机器人发消息",
      ],
      link: { label: "飞书开放平台", url: "https://open.feishu.cn/" },
      note: "长连接（WebSocket）模式无需公网 IP",
    },
    fields: [
      { key: "app_id", label: "App ID", required: true, ph: "飞书应用 app_id（可扫码授权自动获取）" },
      { key: "app_secret", label: "App Secret", required: true, secret: true, ph: "飞书应用 app_secret（可扫码自动获取）" },
      { key: "allow_from", label: "白名单 allow_from（可选）", ph: "open_id，逗号分隔；空=不限" },
    ],
  },
  {
    type: "wechat", label: "微信（ilinkai）", wizard: "weixin",
    guide: {
      steps: [
        "微信通道走 ilinkai bot 协议，需要已有微信 bot token（扫码向导待接，暂手填）",
        "填入 token 后启动实例；白名单建议必填，避免陌生人触发",
      ],
      note: "个人微信 bot 属非官方通道，建议小号专用",
    },
    fields: [
      { key: "token", label: "Token", required: true, secret: true, ph: "微信 bot token（可扫码授权自动获取）" },
      { key: "base_url", label: "API 地址（可选）", ph: "缺省官方 ilinkai 地址" },
      { key: "allow_from", label: "白名单 allow_from（可选）", ph: "空=不限" },
    ],
  },
  {
    type: "telegram", label: "Telegram",
    guide: {
      steps: [
        "Telegram 里找 @BotFather，发 /newbot",
        "按提示起名，拿到 token（形如 123456:ABC-DEF…）",
        "把 token 填到下方，启动后在 Telegram 给你的机器人发 /start 激活",
      ],
      link: { label: "@BotFather", url: "https://t.me/BotFather" },
      note: "国内网络需代理；可选字段 proxy 支持代理配置",
    },
    fields: [
      { key: "token", label: "Bot Token", required: true, secret: true, ph: "@BotFather 发的 token（123456:ABC-…）" },
      { key: "allow_from", label: "白名单 allow_from（可选）", ph: "用户 id/username，逗号分隔" },
    ],
  },
  {
    type: "discord", label: "Discord",
    guide: {
      steps: [
        "Discord Developer Portal → New Application → Bot 页",
        "Reset Token 复制 token；同页打开 Message Content Intent",
        "OAuth2 → URL Generator 勾 bot + 权限 → 生成的链接在浏览器打开邀请进服务器",
      ],
      link: { label: "Discord Developer Portal", url: "https://discord.com/developers/applications" },
    },
    fields: [
      { key: "token", label: "Bot Token", required: true, secret: true, ph: "Discord Developer Portal 的 bot token" },
      { key: "guild_id", label: "服务器 ID（可选）", ph: "限定单个 guild" },
    ],
  },
  {
    type: "slack", label: "Slack",
    guide: {
      steps: [
        "api.slack.com/apps → Create New App（选 From scratch）",
        "Socket Mode 开启 → 拿 app_token（xapp-）",
        "OAuth & Permissions 装 Bot Token（xoxb-）并加 scopes：chat:write、channels:history、im:history、app_mentions:read",
        "Event Subscriptions 订阅 message.im / message.channels 等事件",
        "Install App 到工作区，把机器人拉进频道",
      ],
      link: { label: "Slack API", url: "https://api.slack.com/apps" },
      note: "Socket Mode 无需公网 IP",
    },
    fields: [
      { key: "bot_token", label: "Bot Token (xoxb-)", required: true, secret: true, ph: "xoxb-…（OAuth & Permissions）" },
      { key: "app_token", label: "App Token (xapp-)", required: true, secret: true, ph: "xapp-…（Socket Mode）" },
      { key: "allow_from", label: "白名单 allow_from（可选）", ph: "member id，逗号分隔" },
    ],
  },
  {
    type: "line", label: "LINE",
    guide: {
      steps: [
        "LINE Developers Console → 创建 Messaging API Channel",
        "Basic settings 拿 Channel secret；Messaging API 拿 Channel access token（点 Issue 长期 token）",
        "Webhook URL 填公网地址指向本机 port（需公网可达或内网穿透）",
      ],
      link: { label: "LINE Developers Console", url: "https://developers.line.biz/console/" },
      note: "需要公网可达的 webhook 回调地址",
    },
    fields: [
      { key: "channel_secret", label: "Channel Secret", required: true, secret: true, ph: "LINE Developers 后台" },
      { key: "channel_token", label: "Channel Access Token", required: true, secret: true, ph: "长期 token" },
      { key: "port", label: "回调监听端口（可选）", num: true, ph: "本地 webhook 端口，需公网可达" },
    ],
  },
  {
    type: "qq", label: "QQ（OneBot）",
    guide: {
      steps: [
        "自己先跑一个 OneBot 实现（如 NapCat / Lagrange，登录一个 QQ 号）",
        "实现里开正向 WebSocket 服务，拿到 ws 地址（如 ws://127.0.0.1:3001）",
        "填 ws_url；若实现设了 access token 则一并填",
      ],
      note: "本类型走自建 OneBot 服务，无需腾讯开放平台审核",
    },
    fields: [
      { key: "ws_url", label: "WS 地址", required: true, ph: "ws://127.0.0.1:3001（OneBot 实现）" },
      { key: "token", label: "Token（可选）", secret: true, ph: "OneBot access token" },
      { key: "allow_from", label: "白名单 allow_from（可选）", ph: "QQ 号，逗号分隔" },
    ],
  },
  {
    type: "qqbot", label: "QQ 机器人（开放平台）",
    guide: {
      steps: [
        "QQ 机器人开放平台 → 创建机器人（个人/企业主体）",
        "开发设置页复制 AppID 和 AppSecret",
        "配置沙箱/上线，扫码添加机器人后发消息",
      ],
      link: { label: "QQ 机器人开放平台", url: "https://q.qq.com/" },
    },
    fields: [
      { key: "app_id", label: "AppID", required: true, ph: "QQ 开放平台 AppID" },
      { key: "app_secret", label: "AppSecret", required: true, secret: true, ph: "QQ 开放平台 AppSecret" },
      { key: "sandbox", label: "沙箱（可选）", ph: "填 1 用沙箱环境" },
    ],
  },
  {
    type: "wecom", label: "企业微信",
    guide: {
      steps: [
        "企业微信管理后台 → 应用管理 → 创建应用",
        "复制 AgentId 和 Secret；我的企业页复制 CorpID",
        "接收消息模式（回调）需公网 URL，填 callback_token/callback_aes_key；不用回调则可不填",
      ],
      link: { label: "企业微信管理后台", url: "https://work.weixin.qq.com/" },
    },
    fields: [
      { key: "corp_id", label: "CorpID", required: true, ph: "企业微信企业 ID" },
      { key: "corp_secret", label: "CorpSecret", required: true, secret: true, ph: "应用 Secret" },
      { key: "agent_id", label: "AgentId", num: true, ph: "应用 AgentId" },
      { key: "callback_token", label: "回调 Token（回调模式）", secret: true },
      { key: "callback_aes_key", label: "回调 EncodingAESKey（回调模式）", secret: true },
    ],
  },
  {
    type: "matrix", label: "Matrix",
    guide: {
      steps: [
        "在目标 homeserver（如 matrix.org 或自建）注册一个机器人账号",
        "Element 客户端 → 设置 → 帮助与关于 → 复制 access_token",
        "填 homeserver 地址 + access_token + 机器人 user_id",
      ],
      link: { label: "matrix.org", url: "https://matrix.org/" },
    },
    fields: [
      { key: "homeserver", label: "Homeserver", required: true, ph: "https://matrix.org" },
      { key: "access_token", label: "Access Token", required: true, secret: true, ph: "矩阵账号 access_token" },
      { key: "user_id", label: "User ID", ph: "@bot:matrix.org" },
    ],
  },
  {
    type: "webex", label: "Webex",
    guide: {
      steps: [
        "developer.webex.com 登录 → My Apps → Create a Bot",
        "复制 Bot Access Token（People 页可重新生成）",
        "把机器人加进空间后 @它发消息",
      ],
      link: { label: "Webex for Developers", url: "https://developer.webex.com/" },
    },
    fields: [
      { key: "token", label: "Bot Token", required: true, secret: true, ph: "Webex for Developers bot token" },
    ],
  },
  {
    type: "yuanbao", label: "腾讯元宝",
    guide: {
      steps: [
        "需要元宝 bot token（内部/内测通道）",
        "填 bot_token，可选 ws_url 覆盖默认接入点",
      ],
    },
    fields: [
      { key: "bot_token", label: "Bot Token", required: true, secret: true, ph: "元宝 bot token" },
      { key: "ws_url", label: "WS 地址（可选）", ph: "缺省官方" },
    ],
  },
  {
    type: "googlechat", label: "Google Chat",
    guide: {
      steps: [
        "Google Cloud 控制台 → 启用 Google Chat API，创建 service account 并下载 JSON",
        "配置 Chat 应用 subscriptions（pubsub 模式）",
        "填凭据文件绝对路径 + subscription 名",
      ],
      link: { label: "Google Chat API", url: "https://developers.google.com/chat" },
      note: "配置门槛较高，推荐有 GCP 经验时使用",
    },
    fields: [
      { key: "credentials_file", label: "凭据文件路径", required: true, ph: "service account JSON 绝对路径" },
      { key: "subscription", label: "Subscription 名", required: true, ph: "Google Cloud pubsub subscription" },
    ],
  },
];

/** 按类型取 schema；未知类型返回 undefined（前端降级为通用键值编辑） */
export function platformSchema(type: string): PlatformSchema | undefined {
  return PLATFORM_SCHEMAS.find((p) => p.type === type);
}

/** 兼容旧表单平铺字段 → fields record（client_id/client_secret/agent_id/bot_name） */
export function legacyToFields(pl: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(pl || {})) {
    if (k === "type") continue;
    if (v !== undefined && v !== null && String(v) !== "") out[k] = String(v);
  }
  return out;
}
