// 会话请求卡接缝测试（agent 能力 UI 去核化 P1，docs/pi-web-agent-capability-ui-ext-plan.md §6）：
// 路由选择（kind/backend/priority）+ 兜底卡渲染（permission/open_url/plan/provider_headers 家族）。
// SSR 渲染用 renderToStaticMarkup（ProviderHeadersRequestCard.test.mjs 同范式）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { pickSessionRequestCard, MinimalRequestCard } = await jiti.import("./SessionRequestSlot.tsx");

test("pickSessionRequestCard: kind 匹配 + backend 过滤 + priority 最高者胜出", () => {
  const item = (id, kinds, backend, priority) => ({ id, meta: { kinds, backend, priority }, render: () => null });
  const items = [
    item("generic", ["interaction:generic"], undefined, 0),
    item("zcode-plan", ["interaction:plan_approval"], "zcode", 5),
    item("plan-any", ["interaction:plan_approval"], "*", 3),
    item("perm", ["permission"], undefined, 0),
  ];

  assert.equal(pickSessionRequestCard(items, { kind: "interaction:plan_approval" }, "zcode")?.id, "zcode-plan");
  // backend 不匹配（cursor 会话）→ 通配项接管
  assert.equal(pickSessionRequestCard(items, { kind: "interaction:plan_approval" }, "cursor")?.id, "plan-any");
  // 无 backendSource（本地会话）→ 通配项接管
  assert.equal(pickSessionRequestCard(items, { kind: "interaction:plan_approval" }, undefined)?.id, "plan-any");
  // generic 命中
  assert.equal(pickSessionRequestCard(items, { kind: "interaction:generic" }, "zcode")?.id, "generic");
  // 未声明 backend 的条目通配所有后端
  assert.equal(pickSessionRequestCard(items, { kind: "permission" }, "zcode")?.id, "perm");
  // 无匹配 → null（落兜底）
  assert.equal(pickSessionRequestCard(items, { kind: "provider_headers" }, "zcode"), null);
  // meta 缺 kinds / 缺 meta 的条目不参与
  assert.equal(pickSessionRequestCard([{ id: "x", render: () => null }, { id: "y", meta: {} }], { kind: "permission" }, "zcode"), null);
  // 无 render 的声明式条目不算命中：高 priority 也不胜出（否则 ExtSlot 过滤后「命中即空白」跳过兜底）
  assert.equal(pickSessionRequestCard([
    { id: "declarative", meta: { kinds: ["permission"], priority: 99 } },
    item("perm", ["permission"], undefined, 0),
  ], { kind: "permission" }, "zcode")?.id, "perm");
  assert.equal(pickSessionRequestCard([{ id: "declarative", meta: { kinds: ["permission"], priority: 99 } }], { kind: "permission" }, "zcode"), null);
});

test("MinimalRequestCard: permission 家族——options 表生成按钮 + 入参摘要（SSR）", () => {
  const respond = async () => true;
  const html = renderToStaticMarkup(React.createElement(MinimalRequestCard, {
    request: {
      requestId: "p1", kind: "permission", family: "permission", capability: "respondPermission",
      toolName: "Bash",
      input: { command: "ls -la /tmp" },
      options: [
        { optionId: "a1", kind: "allow_once", name: "" },
        { optionId: "r1", kind: "reject_always", name: "" },
      ],
    },
    onRespond: respond,
  }));
  assert.match(html, /工具授权请求/);
  assert.match(html, /Bash/);
  assert.match(html, /command: ls -la \/tmp/);
  assert.match(html, /本次允许/);
  assert.match(html, /总是拒绝/);
  assert.match(html, /session-request-fallback-card/);
});

test("MinimalRequestCard: permission 无 options → 允许/拒绝回退；open_url → 打开登录页（SSR）", () => {
  const respond = async () => true;
  const permHtml = renderToStaticMarkup(React.createElement(MinimalRequestCard, {
    request: { requestId: "p2", kind: "permission", family: "permission", capability: "respondPermission", toolName: "Read" },
    onRespond: respond,
  }));
  assert.match(permHtml, /允许/);
  assert.match(permHtml, /拒绝/);

  const urlHtml = renderToStaticMarkup(React.createElement(MinimalRequestCard, {
    request: {
      requestId: "o1", kind: "interaction:open_url", family: "interaction", capability: "respondInteraction",
      url: "https://example.com/oauth?x=1", launchUrl: "http://127.0.0.1:8777/login/o1",
    },
    onRespond: respond,
  }));
  assert.match(urlHtml, /登录授权/);
  assert.match(urlHtml, /打开登录页/);
  assert.match(urlHtml, /复制链接/);
  // aiti-float 浮窗契约（方案 §2.1）：interaction 兜底卡带浮窗标记（与扩展内同 key）
  assert.match(urlHtml, /data-ext-float="1"/);
  assert.match(urlHtml, /data-ext-float-key="piweb-interaction-card"/);
  assert.doesNotMatch(permHtml, /data-ext-float=/); // permission 原 core 卡无浮窗契约，保持无属性
});

test("MinimalRequestCard: plan_approval 直出 markdown 文本 + ask_user 罗列选项 + provider_headers 无 SDK 只给取消", () => {
  const respond = async () => true;
  const planHtml = renderToStaticMarkup(React.createElement(MinimalRequestCard, {
    request: {
      requestId: "pl1", kind: "interaction:plan_approval", family: "interaction", capability: "respondInteraction",
      plan: "# 方案\n- 第一步\n- 第二步",
    },
    onRespond: respond,
  }));
  assert.match(planHtml, /方案审批/);
  assert.match(planHtml, /第一步/);
  assert.match(planHtml, /批准方案/);

  const askHtml = renderToStaticMarkup(React.createElement(MinimalRequestCard, {
    request: {
      requestId: "a1", kind: "interaction:ask_user", family: "interaction", capability: "respondInteraction",
      questions: [{ question: "选一个", options: [{ label: "甲" }, { label: "乙" }] }],
    },
    onRespond: respond,
  }));
  assert.match(askHtml, /选一个/);
  assert.match(askHtml, /甲 \/ 乙/);

  const capHtml = renderToStaticMarkup(React.createElement(MinimalRequestCard, {
    request: {
      requestId: "c1", kind: "provider_headers", family: "provider_headers", capability: "respondProviderHeaders",
      reason: "captcha-retry", captchaConfig: { sceneId: "s", prefix: "p", region: "cn" },
    },
    onRespond: respond,
  }));
  assert.match(capHtml, /套餐通道安全验证/);
  assert.match(capHtml, /重试验证/);
  assert.match(capHtml, /取消本轮/);
  // 兜底不含官方 SDK 挂载点（SDK 在 aiti-zcode-agent client）
  assert.doesNotMatch(capHtml, /pi-captcha-element/);
});

test("source contract: SessionRequestSlot 挂点与 useAgentSession 派生单状态成对存在", async () => {
  const slotSource = await readFile(new URL("./SessionRequestSlot.tsx", import.meta.url), "utf8");
  const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  assert.match(slotSource, /useExtSlotItems\("sessionRequestCard"\)/);
  assert.match(slotSource, /only=\{winner\.id\}/);
  assert.match(hookSource, /const sessionRequest = useMemo<SessionRequestPayload \| null>/);
  assert.match(hookSource, /respondToSessionRequest/);
});
