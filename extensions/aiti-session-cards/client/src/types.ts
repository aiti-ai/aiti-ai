/** 会话请求卡插槽契约（与宿主 lib/ext/types.ts SessionRequestPayload/SessionRequestAnswer 同形——
 *  扩展仓外，类型级文档；结构以宿主为准）。 */

export interface SessionRequestQuestion {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

export interface SessionRequestPayload {
  requestId: string;
  /** 路由键：interaction:plan_approval / interaction:ask_user / interaction:open_url /
   *  interaction:generic / permission / provider_headers / 后端自定义。 */
  kind: string;
  family: "interaction" | "permission" | "provider_headers";
  capability: string;
  toolName?: string;
  prompt?: string;
  plan?: string;
  url?: string;
  launchUrl?: string;
  questions?: SessionRequestQuestion[];
  input?: unknown;
  options?: Array<{ optionId?: string; kind?: string; name?: string }>;
  captchaConfig?: { sceneId: string; prefix: string; region: string };
  providerId?: string;
  modelRef?: string;
  reason?: "model-request" | "captcha-retry";
}

export interface SessionRequestAnswer {
  action: "accept" | "decline";
  answers?: Record<string, string | string[]>;
  message?: string;
  optionId?: string;
  captchaVerifyParam?: string;
  error?: string;
}

export interface SessionRequestCardProps {
  request: SessionRequestPayload;
  respond: (answer: SessionRequestAnswer) => Promise<boolean>;
}
