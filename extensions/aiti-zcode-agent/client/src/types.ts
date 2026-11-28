/** Session-request-card slot contract (mirrors the host lib/ext/types.ts — host lives in another repo, type-level doc only; the host shape is authoritative). */

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
