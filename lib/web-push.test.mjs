import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./web-push.ts");
}

const { createWebPushNotifier, localeText } = await loadSubject();

function makeEnvironment({
  initialState = null,
  sessions = [
    { id: "session-1", cwd: "/home/user/my-project", name: "My session", firstMessage: "hi" },
  ],
  errorFor = () => null,
} = {}) {
  let state = initialState;
  let saved = null;
  const sent = [];

  const env = {
    send: async (subscription, payload, vapidKeys) => {
      sent.push({ subscription, payload, vapidKeys });
      const error = errorFor(subscription);
      if (error) throw error;
    },
    loadState: () => state,
    saveState: (s) => { saved = s; },
    generateVapidKeys: () => ({ publicKey: "pub-key", privateKey: "priv-key" }),
    listSessions: async () => sessions,
  };

  return {
    notifier: createWebPushNotifier(env),
    sent,
    getSaved: () => saved,
  };
}

const SUB_EN = {
  endpoint: "https://push.example.com/en",
  keys: { p256dh: "p256dh-en", auth: "auth-en" },
  locale: "en",
};
const SUB_ZH = {
  endpoint: "https://push.example.com/zh",
  keys: { p256dh: "p256dh-zh", auth: "auth-zh" },
  locale: "zh-CN",
};

test("generates and persists VAPID keys when no state exists", () => {
  const { notifier, getSaved } = makeEnvironment();

  assert.equal(notifier.getVapidPublicKey(), "pub-key");
  assert.deepEqual(getSaved(), {
    vapidKeys: { publicKey: "pub-key", privateKey: "priv-key" },
    subscriptions: [],
  });
});

test("reuses persisted VAPID keys", () => {
  const { notifier } = makeEnvironment({
    initialState: {
      vapidKeys: { publicKey: "persisted-pub", privateKey: "persisted-priv" },
      subscriptions: [],
    },
  });

  assert.equal(notifier.getVapidPublicKey(), "persisted-pub");
});

test("addSubscription upserts by endpoint and persists", () => {
  const { notifier, getSaved } = makeEnvironment();

  notifier.addSubscription(SUB_EN);
  notifier.addSubscription(SUB_ZH);
  notifier.addSubscription({ ...SUB_EN, locale: "zh-CN" });

  const saved = getSaved();
  assert.equal(saved.subscriptions.length, 2);
  const updated = saved.subscriptions.find((s) => s.endpoint === SUB_EN.endpoint);
  assert.equal(updated.locale, "zh-CN");
});

test("addSubscription persists even after getVapidPublicKey already saved", () => {
  const { notifier, getSaved } = makeEnvironment();

  notifier.getVapidPublicKey(); // first save
  notifier.addSubscription(SUB_EN);

  assert.equal(getSaved().subscriptions.length, 1);
});

test("notifySessionComplete sends localized payloads with the session name", async () => {
  const { notifier, sent } = makeEnvironment();
  notifier.addSubscription(SUB_EN);
  notifier.addSubscription(SUB_ZH);

  await notifier.notifySessionComplete("session-1");

  assert.equal(sent.length, 2);
  const en = sent.find((s) => s.subscription.endpoint === SUB_EN.endpoint);
  const zh = sent.find((s) => s.subscription.endpoint === SUB_ZH.endpoint);
  assert.deepEqual(JSON.parse(en.payload), {
    title: "My session",
    body: "my-project · Task finished",
    url: "/?session=session-1",
    tag: "pi-session-complete:session-1",
  });
  assert.deepEqual(JSON.parse(zh.payload), {
    title: "My session",
    body: "my-project · 任务已完成",
    url: "/?session=session-1",
    tag: "pi-session-complete:session-1",
  });
});

test("notifySessionComplete falls back to the localized generic title and plain body without a session", async () => {
  const { notifier, sent } = makeEnvironment({ sessions: [] });
  notifier.addSubscription(SUB_ZH);

  await notifier.notifySessionComplete("unknown-session");

  assert.deepEqual(JSON.parse(sent[0].payload), {
    title: "任务完成",
    body: "任务已完成。",
    url: "/?session=unknown-session",
    tag: "pi-session-complete:unknown-session",
  });
});

test("notifySessionComplete prunes subscriptions dropped by the push service", async () => {
  const { notifier, sent, getSaved } = makeEnvironment({
    errorFor: (subscription) => subscription.endpoint === SUB_ZH.endpoint ? { statusCode: 410 } : null,
  });
  notifier.addSubscription(SUB_EN);
  notifier.addSubscription(SUB_ZH);

  await notifier.notifySessionComplete("session-1");

  assert.equal(sent.length, 2);
  const saved = getSaved();
  assert.deepEqual(saved.subscriptions.map((s) => s.endpoint), [SUB_EN.endpoint]);
});

test("localeText falls back to English for unknown locales", () => {
  assert.equal(localeText("zh-CN", "taskFinished"), "任务已完成。");
  assert.equal(localeText("ja", "taskFinished"), "Task finished.");
  assert.equal(localeText("en", "sessionComplete"), "Session complete");
});

test("push requests immediate delivery with a long TTL", async () => {
  const { PUSH_OPTIONS } = await loadSubject();

  // iOS may defer non-high-urgency pushes to an arbitrary later window.
  assert.equal(PUSH_OPTIONS.urgency, "high");
  assert.equal(PUSH_OPTIONS.TTL, 2419200);
});

test("vapidSubject defaults to a valid https URL, not mailto:localhost", async () => {
  const { vapidSubject } = await loadSubject();
  const subject = vapidSubject();
  assert.doesNotMatch(subject, /@localhost$/);
  assert.ok(subject.startsWith("https://") || subject.startsWith("mailto:"), subject);
});

test("notifySessionComplete reports failed runs with the error summary", async () => {
  const { notifier, sent } = makeEnvironment();
  notifier.addSubscription(SUB_EN);
  notifier.addSubscription(SUB_ZH);

  await notifier.notifySessionComplete("session-1", {
    status: "failed",
    at: "2026-09-15T03:51:45.997Z",
    error: "Cannot read properties of undefined (reading 'totalTokens')",
  });

  assert.equal(sent.length, 2);
  const en = JSON.parse(sent.find((s) => s.subscription.endpoint === SUB_EN.endpoint).payload);
  const zh = JSON.parse(sent.find((s) => s.subscription.endpoint === SUB_ZH.endpoint).payload);
  assert.equal(en.title, "My session");
  assert.equal(en.body, "my-project · Task failed: Cannot read properties of undefined (reading 'totalTokens')");
  assert.equal(zh.body, "my-project · 任务失败：Cannot read properties of undefined (reading 'totalTokens')");
  assert.equal(zh.tag, "pi-session-complete:session-1");
});

test("notifySessionComplete: failed without error text still reports failure (no dangling colon)", async () => {
  const { notifier, sent } = makeEnvironment();
  notifier.addSubscription(SUB_ZH);
  await notifier.notifySessionComplete("session-1", { status: "failed", at: "2026-09-15T00:00:00Z" });
  assert.equal(JSON.parse(sent[0].payload).body, "my-project · 任务失败");
});

test("notifySessionComplete truncates long error messages to 120 chars", async () => {
  const { notifier, sent } = makeEnvironment();
  notifier.addSubscription(SUB_EN);
  await notifier.notifySessionComplete("session-1", { status: "failed", at: "2026-09-15T00:00:00Z", error: "x".repeat(500) + "\nsecond line" });
  const body = JSON.parse(sent[0].payload).body;
  // "my-project · Task failed: " + 120-char summary
  const summary = body.slice("my-project · Task failed: ".length);
  assert.equal(summary.length, 120);
  assert.ok(summary.endsWith("…"));
  assert.ok(!body.includes("\n"));
});

test("notifySessionComplete does not push for aborted or interrupted runs", async () => {
  const { notifier, sent } = makeEnvironment();
  notifier.addSubscription(SUB_EN);
  await notifier.notifySessionComplete("session-1", { status: "aborted", at: "2026-09-15T00:00:00Z" });
  await notifier.notifySessionComplete("session-1", { status: "interrupted", at: "2026-09-15T00:00:00Z" });
  assert.equal(sent.length, 0);
});

test("localeText: failed keys interpolate project and error", () => {
  assert.equal(localeText("zh-CN", "taskFailedWithError", { error: "boom" }), "任务失败：boom");
  assert.equal(localeText("zh-CN", "taskFailedWithContextAndError", { project: "p", error: "boom" }), "p · 任务失败：boom");
  assert.equal(localeText("en", "sessionFailed"), "Session failed");
  assert.equal(localeText("ja", "taskFailedWithContextAndError", { project: "p", error: "boom" }), "p · Task failed: boom");
});
