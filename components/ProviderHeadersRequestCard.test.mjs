import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

// ProviderHeadersRequestCard 用 useEffect 跑 SDK 懒加载——SSR 渲染只断言静态骨架（init 态文案 + 取消按钮 + SDK 挂载点）
const { ProviderHeadersRequestCard } = await jiti.import("./ProviderHeadersRequestCard.tsx");

const baseRequest = {
  requestId: "rh-1",
  providerId: "builtin:bigmodel-start-plan",
  modelRef: "builtin:bigmodel-start-plan/GLM-5.3-Flash",
  reason: "model-request",
  captchaConfig: { sceneId: "11xygtvd", prefix: "no8xfe", region: "cn" },
};

test("ProviderHeadersRequestCard renders skeleton with SDK mount points", () => {
  const html = renderToStaticMarkup(React.createElement(ProviderHeadersRequestCard, {
    request: baseRequest,
    onRespond: async () => true,
  }));
  assert.match(html, /data-testid="provider-headers-request-card"/);
  assert.match(html, /套餐通道安全验证/);
  assert.match(html, /模型请求/);
  // 取消按钮已移除（2fa0ac2：验证码只能完成（无感/滑块）或等 180s 后端兜底）
  assert.doesNotMatch(html, /provider-headers-cancel/);
  assert.match(html, /id="pi-captcha-element"/);
  assert.match(html, /id="pi-captcha-button"/);
  assert.match(html, /正在建立安全验证/);
  // error 态重试按钮在 init 态不渲染
  assert.doesNotMatch(html, /provider-headers-retry/);
});

test("ProviderHeadersRequestCard shows retry label for captcha-retry reason", () => {
  const html = renderToStaticMarkup(React.createElement(ProviderHeadersRequestCard, {
    request: { ...baseRequest, reason: "captcha-retry" },
    onRespond: async () => true,
  }));
  assert.match(html, /重试验证/);
});
