// Session request card seam tests (agent capability UI de-coring P1, docs/pi-web-agent-capability-ui-ext-plan.md §6):
// routing selection (kind/backend/priority) + fallback card rendering (permission/open_url/plan/provider_headers families).
// SSR rendering via renderToStaticMarkup (same pattern as ProviderHeadersRequestCard.test.mjs).
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
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

test("pickSessionRequestCard: kind match + backend filter + highest priority wins", () => {
  const item = (id, kinds, backend, priority) => ({ id, meta: { kinds, backend, priority }, render: () => null });
  const items = [
    item("generic", ["interaction:generic"], undefined, 0),
    item("zcode-plan", ["interaction:plan_approval"], "zcode", 5),
    item("plan-any", ["interaction:plan_approval"], "*", 3),
    item("perm", ["permission"], undefined, 0),
  ];

  assert.equal(pickSessionRequestCard(items, { kind: "interaction:plan_approval" }, "zcode")?.id, "zcode-plan");
  // backend mismatch (cursor session) → wildcard item takes over
  assert.equal(pickSessionRequestCard(items, { kind: "interaction:plan_approval" }, "cursor")?.id, "plan-any");
  // no backendSource (local session) → wildcard item takes over
  assert.equal(pickSessionRequestCard(items, { kind: "interaction:plan_approval" }, undefined)?.id, "plan-any");
  // generic hit
  assert.equal(pickSessionRequestCard(items, { kind: "interaction:generic" }, "zcode")?.id, "generic");
  // items without a declared backend match every backend
  assert.equal(pickSessionRequestCard(items, { kind: "permission" }, "zcode")?.id, "perm");
  // no match → null (falls to the fallback)
  assert.equal(pickSessionRequestCard(items, { kind: "provider_headers" }, "zcode"), null);
  // items missing kinds in meta / missing meta entirely don't participate
  assert.equal(pickSessionRequestCard([{ id: "x", render: () => null }, { id: "y", meta: {} }], { kind: "permission" }, "zcode"), null);
  // declarative items without render don't count as a hit: even a high priority doesn't win (otherwise, after ExtSlot
  // filtering, "a hit that renders blank" would skip the fallback)
  assert.equal(pickSessionRequestCard([
    { id: "declarative", meta: { kinds: ["permission"], priority: 99 } },
    item("perm", ["permission"], undefined, 0),
  ], { kind: "permission" }, "zcode")?.id, "perm");
  assert.equal(pickSessionRequestCard([{ id: "declarative", meta: { kinds: ["permission"], priority: 99 } }], { kind: "permission" }, "zcode"), null);
});

test("MinimalRequestCard: permission family — buttons generated from the options table + input summary (SSR)", () => {
  const respond = async () => true;
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(MinimalRequestCard, {
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
  })));
  assert.match(html, /Tool authorization request/);
  assert.match(html, /Bash/);
  assert.match(html, /command: ls -la \/tmp/);
  assert.match(html, /Allow once/);
  assert.match(html, /Always deny/);
  assert.match(html, /session-request-fallback-card/);
});

test("MinimalRequestCard: permission without options → allow/reject fallback; open_url → open the login page (SSR)", () => {
  const respond = async () => true;
  const permHtml = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(MinimalRequestCard, {
    request: { requestId: "p2", kind: "permission", family: "permission", capability: "respondPermission", toolName: "Read" },
    onRespond: respond,
  })));
  assert.match(permHtml, /Allow/);
  assert.match(permHtml, /Deny/);

  const urlHtml = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(MinimalRequestCard, {
    request: {
      requestId: "o1", kind: "interaction:open_url", family: "interaction", capability: "respondInteraction",
      url: "https://example.com/oauth?x=1", launchUrl: "http://127.0.0.1:8777/login/o1",
    },
    onRespond: respond,
  })));
  assert.match(urlHtml, /Login authorization/);
  assert.match(urlHtml, /Open login page/);
  assert.match(urlHtml, /Copy link/);
  // floating-dialog extension contract (plan §2.1): the interaction fallback card carries the floating-window markers (same keys as inside the extension)
  assert.match(urlHtml, /data-ext-float="1"/);
  assert.match(urlHtml, /data-ext-float-key="piweb-interaction-card"/);
  assert.doesNotMatch(permHtml, /data-ext-float=/); // the permission card, originally in core, has no floating-window contract — stays attribute-free
});

test("MinimalRequestCard: an ask with no dedicated body still shows the input summary and default answer actions (SSR)", () => {
  const respond = async () => true;
  const authHtml = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(MinimalRequestCard, {
    request: {
      requestId: "ta1", kind: "interaction:tool_auth", family: "interaction", capability: "respondInteraction",
      toolName: "EnterPlanMode", input: { reason: "enter plan mode first" },
    },
    onRespond: respond,
  })));
  assert.match(authHtml, /Tool authorization request/);
  assert.match(authHtml, /EnterPlanMode/);
  // a pending ask must never render a card with no way out
  assert.match(authHtml, /reason: enter plan mode first/);
  assert.match(authHtml, /Deny/);
  assert.match(authHtml, /Allow/);

  const emptyPlanHtml = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(MinimalRequestCard, {
    request: {
      requestId: "ta2", kind: "interaction:plan_approval", family: "interaction", capability: "respondInteraction",
      toolName: "ExitPlanMode", input: { allowedPrompts: [{ prompt: "run tests", tool: "Bash" }] },
    },
    onRespond: respond,
  })));
  assert.match(emptyPlanHtml, /Plan approval/);
  assert.match(emptyPlanHtml, /run tests/);
  assert.match(emptyPlanHtml, /Approve plan/);
});

test("MinimalRequestCard: plan_approval renders markdown text directly + ask_user lists options + provider_headers without SDK offers only cancel", () => {
  const respond = async () => true;
  const planHtml = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(MinimalRequestCard, {
    request: {
      requestId: "pl1", kind: "interaction:plan_approval", family: "interaction", capability: "respondInteraction",
      plan: "# 方案\n- 第一步\n- 第二步",
    },
    onRespond: respond,
  })));
  assert.match(planHtml, /Plan approval/);
  assert.match(planHtml, /第一步/);
  assert.match(planHtml, /Approve plan/);

  const askHtml = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(MinimalRequestCard, {
    request: {
      requestId: "a1", kind: "interaction:ask_user", family: "interaction", capability: "respondInteraction",
      questions: [{ question: "选一个", options: [{ label: "甲" }, { label: "乙" }] }],
    },
    onRespond: respond,
  })));
  assert.match(askHtml, /选一个/);
  assert.match(askHtml, /甲 \/ 乙/);

  const capHtml = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(MinimalRequestCard, {
    request: {
      requestId: "c1", kind: "provider_headers", family: "provider_headers", capability: "respondProviderHeaders",
      reason: "captcha-retry", captchaConfig: { sceneId: "s", prefix: "p", region: "cn" },
    },
    onRespond: respond,
  })));
  assert.match(capHtml, /Provider security verification/);
  assert.match(capHtml, /Retry verification/);
  assert.match(capHtml, /Cancel turn/);
  // the fallback has no official SDK mount point (the SDK lives in the zcode-agent extension's client)
  assert.doesNotMatch(capHtml, /pi-captcha-element/);
});

test("source contract: the SessionRequestSlot mount point and the useAgentSession derived state exist as a pair", async () => {
  const slotSource = await readFile(new URL("./SessionRequestSlot.tsx", import.meta.url), "utf8");
  const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  assert.match(slotSource, /useExtSlotItems\("sessionRequestCard"\)/);
  assert.match(slotSource, /only=\{winner\.id\}/);
  assert.match(hookSource, /const sessionRequest = useMemo<SessionRequestPayload \| null>/);
  assert.match(hookSource, /respondToSessionRequest/);
});
