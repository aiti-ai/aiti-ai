/** 会话请求卡插槽契约（与宿主 lib/ext/types.ts 同形——扩展仓外，类型级文档；结构以宿主为准）。 */

export interface SessionRequestAnswer {
  action: "accept" | "decline";
  answers?: Record<string, string | string[]>;
  message?: string;
  optionId?: string;
  captchaVerifyParam?: string;
  region?: string;
  error?: string;
}

export interface SessionRequestCardProps {
  request: {
    requestId: string;
    kind: string;
    family: "interaction" | "permission" | "provider_headers";
    capability: string;
    toolName?: string;
    prompt?: string;
    plan?: string;
    url?: string;
    launchUrl?: string;
    input?: unknown;
    options?: Array<{ optionId?: string; kind?: string; name?: string }>;
    captchaConfig?: { sceneId: string; prefix: string; region: string };
    providerId?: string;
    modelRef?: string;
    reason?: "model-request" | "captcha-retry";
  };
  respond: (answer: SessionRequestAnswer) => Promise<boolean>;
}
