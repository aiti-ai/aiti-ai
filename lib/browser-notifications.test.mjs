import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

// Through jiti: the module now imports the request classification, which Node's
// own loader cannot resolve from an extensionless specifier.
async function loadSubject() {
  return jiti.import("./browser-notifications.ts");
}

test("uses a service worker notification when a registration is available", async () => {
  const { showBrowserNotification } = await loadSubject();
  const shown = [];
  let constructorCalled = false;

  const delivery = await showBrowserNotification({
    title: "Session complete",
    body: "Task finished.",
    sessionUrl: "/?session=session-1",
    tag: "session-complete:session-1",
    onClick: () => assert.fail("service worker owns the click handler"),
  }, {
    createWindowNotification: () => {
      constructorCalled = true;
      throw new Error("unexpected constructor call");
    },
    getServiceWorkerRegistration: async () => ({
      showNotification: async (title, options) => shown.push({ title, options }),
    }),
  });

  assert.equal(delivery, "service-worker");
  assert.equal(constructorCalled, false);
  assert.deepEqual(shown, [{
    title: "Session complete",
    options: {
      body: "Task finished.",
      tag: "session-complete:session-1",
      // #701: a repeated completion notification with the same tag needs renotify to
      // pop again (otherwise the browser dedupes and silently drops it)
      renotify: true,
      data: { url: "/?session=session-1" },
    },
  }]);
});

test("falls back to a page notification and wires its click handler", async () => {
  const { showBrowserNotification } = await loadSubject();
  let notificationOptions;
  let clicked = false;
  let closed = false;
  const notification = {
    onclick: null,
    close: () => { closed = true; },
  };

  const delivery = await showBrowserNotification({
    title: "Session complete",
    body: "Task finished.",
    sessionUrl: "/?session=session-1",
    onClick: () => { clicked = true; },
  }, {
    createWindowNotification: (title, options) => {
      notificationOptions = { title, options };
      return notification;
    },
    getServiceWorkerRegistration: async () => {
      throw new Error("service worker unavailable");
    },
  });

  assert.equal(delivery, "window");
  assert.deepEqual(notificationOptions, {
    title: "Session complete",
    options: { body: "Task finished." },
  });

  notification.onclick();
  assert.equal(closed, true);
  assert.equal(clicked, true);
});

test("silently skips notification when neither delivery mechanism works", async () => {
  const { showBrowserNotification } = await loadSubject();

  const delivery = await showBrowserNotification({
    title: "Session complete",
    body: "Task finished.",
    sessionUrl: "/",
    onClick: () => {},
  }, {
    createWindowNotification: () => {
      throw new TypeError("Illegal constructor");
    },
    getServiceWorkerRegistration: null,
  });

  assert.equal(delivery, null);
});

test("shows notifications when the page is hidden", async () => {
  const { shouldShowBrowserNotification } = await loadSubject();
  let focusChecked = false;

  assert.equal(shouldShowBrowserNotification({
    visibilityState: "hidden",
    hasFocus: () => {
      focusChecked = true;
      return true;
    },
  }), true);
  assert.equal(focusChecked, false);
});

test("shows notifications when the visible page is unfocused", async () => {
  const { shouldShowBrowserNotification } = await loadSubject();

  assert.equal(shouldShowBrowserNotification({
    visibilityState: "visible",
    hasFocus: () => false,
  }), true);
});

test("skips notifications only when the visible page is focused", async () => {
  const { shouldShowBrowserNotification } = await loadSubject();

  assert.equal(shouldShowBrowserNotification({
    visibilityState: "visible",
    hasFocus: () => true,
  }), false);
});

test("closes overflow session notifications before showing via service worker", async () => {
  const { showBrowserNotification } = await loadSubject();
  const closed = [];
  const shown = [];
  const existing = [
    { tag: "pi-session-complete:a", timestamp: 1, close: () => closed.push("a") },
    { tag: "pi-session-complete:b", timestamp: 2, close: () => closed.push("b") },
    { tag: "pi-session-complete:c", timestamp: 3, close: () => closed.push("c") },
  ];

  const delivery = await showBrowserNotification({
    title: "Session complete",
    body: "Task finished.",
    sessionUrl: "/?session=d",
    tag: "pi-session-complete:d",
    onClick: () => {},
  }, {
    createWindowNotification: () => {
      throw new Error("unexpected constructor call");
    },
    getServiceWorkerRegistration: async () => ({
      showNotification: async (title, options) => { shown.push({ title, options }); },
      getNotifications: async () => existing,
    }),
  });

  // 3 existing + 1 new → keep only 2 old notifications, close the oldest (a), then show the new one.
  assert.equal(delivery, "service-worker");
  assert.deepEqual(closed, ["a"]);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.tag, "pi-session-complete:d");
});

test("still shows the notification when listing open notifications fails", async () => {
  const { showBrowserNotification } = await loadSubject();
  const shown = [];

  const delivery = await showBrowserNotification({
    title: "Session complete",
    body: "Task finished.",
    sessionUrl: "/?session=a",
    tag: "pi-session-complete:a",
    onClick: () => {},
  }, {
    createWindowNotification: () => {
      throw new Error("unexpected constructor call");
    },
    getServiceWorkerRegistration: async () => ({
      showNotification: async (title, options) => { shown.push({ title, options }); },
      getNotifications: async () => {
        throw new Error("getNotifications unavailable");
      },
    }),
  });

  assert.equal(delivery, "service-worker");
  assert.equal(shown.length, 1);
});

test("selects only the oldest overflow of session-complete notifications", async () => {
  const { sessionNotificationsToClose } = await loadSubject();
  const existing = [
    { tag: "pi-session-complete:same", timestamp: 5, close() {} },
    { tag: "pi-session-complete:old-1", timestamp: 1, close() {} },
    { tag: "pi-session-complete:old-2", timestamp: 2, close() {} },
    { tag: "pi-session-complete:old-3", timestamp: 3, close() {} },
    { tag: "pi-extension-ui:ask", timestamp: 0, close() {} },
  ];

  // Same-tag replacement (no new entry): 4 completion notifications trimmed back to 3, closing the oldest old-1.
  assert.deepEqual(
    sessionNotificationsToClose(existing, "pi-session-complete:same").map((n) => n.tag),
    ["pi-session-complete:old-1"],
  );
  // New tag (new entry): at most 2 old notifications retained, closing the oldest old-1 and old-2.
  assert.deepEqual(
    sessionNotificationsToClose(existing, "pi-session-complete:brand-new").map((n) => n.tag),
    ["pi-session-complete:old-1", "pi-session-complete:old-2"],
  );
  // Non-completion notifications (extension input prompts) are not part of this notification pool: no cleanup.
  assert.deepEqual(sessionNotificationsToClose(existing, "pi-extension-ui:ask"), []);
  // Old notifications without a timestamp count as the oldest and close first.
  assert.deepEqual(
    sessionNotificationsToClose([
      { tag: "pi-session-complete:no-ts", close() {} },
      { tag: "pi-session-complete:newer", timestamp: 1, close() {} },
    ], "pi-session-complete:incoming", 2).map((n) => n.tag),
    ["pi-session-complete:no-ts"],
  );
  // The no-session fallback tag (the bare base name) also belongs to the completion pool;
  // similar but distinct tags do not participate.
  assert.deepEqual(
    sessionNotificationsToClose([
      { tag: "pi-session-complete", timestamp: 1, close() {} },
      { tag: "pi-session-complete-extra", timestamp: 2, close() {} },
    ], "pi-session-complete:incoming", 1).map((n) => n.tag),
    ["pi-session-complete"],
  );
});

test("claims only blocking extension requests and deduplicates their ids", async () => {
  const { claimExtensionAttentionNotification } = await loadSubject();
  const notifiedIds = new Set();
  const confirmRequest = {
    type: "extension_ui_request",
    id: "confirm-1",
    method: "confirm",
    title: "Approve",
    message: "Continue?",
  };

  assert.equal(claimExtensionAttentionNotification(confirmRequest, notifiedIds), true);
  assert.equal(claimExtensionAttentionNotification(confirmRequest, notifiedIds), false);
  for (const request of [
    { type: "extension_ui_request", id: "select-1", method: "select", title: "Choose", options: ["A"] },
    { type: "extension_ui_request", id: "input-1", method: "input", title: "Enter value" },
    { type: "extension_ui_request", id: "editor-1", method: "editor", title: "Edit value" },
  ]) {
    assert.equal(claimExtensionAttentionNotification(request, notifiedIds), true);
  }
  assert.equal(claimExtensionAttentionNotification({
    type: "extension_ui_request",
    id: "notice-1",
    method: "notify",
    message: "Informational",
  }, notifiedIds), false);
  assert.equal(claimExtensionAttentionNotification({
    type: "extension_ui_request",
    id: "custom-closed",
    method: "custom",
    lines: [],
    closed: true,
  }, notifiedIds), false);
  assert.equal(claimExtensionAttentionNotification({
    type: "extension_ui_request",
    id: "custom-open",
    method: "custom",
    lines: ["Waiting for input"],
  }, notifiedIds), true);
  assert.deepEqual([...notifiedIds], ["confirm-1", "select-1", "input-1", "editor-1", "custom-open"]);
});
