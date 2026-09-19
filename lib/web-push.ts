import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import webpush from "web-push";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { runOutcomeNotifies, truncateRunError, type SessionLastRun } from "./run-outcome";
import { enLocale } from "./i18n/messages/en";
import { zhCNLocale } from "./i18n/messages/zh-CN";
import { getAgentDir } from "./session-reader";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  locale: string;
}

interface PushStateFile {
  vapidKeys: { publicKey: string; privateKey: string };
  subscriptions: PushSubscriptionRecord[];
}

interface WebPushEnvironment {
  send: (
    subscription: PushSubscriptionRecord,
    payload: string,
    vapidKeys: PushStateFile["vapidKeys"],
  ) => Promise<void>;
  loadState: () => PushStateFile | null;
  saveState: (state: PushStateFile) => void;
  generateVapidKeys: () => PushStateFile["vapidKeys"];
  listSessions: () => Promise<SessionInfo[]>;
}

export interface WebPushNotifier {
  getVapidPublicKey: () => string;
  addSubscription: (subscription: PushSubscriptionRecord) => void;
  notifySessionComplete: (sessionId: string, outcome?: SessionLastRun) => Promise<void>;
}

function stateFilePath(): string {
  return join(getAgentDir(), "web-push.json");
}

/**
 * VAPID subject must be a valid `mailto:` or `https:` URL. Apple's push
 * service rejects requests whose subject is not a syntactically valid URL
 * (e.g. the previously used `mailto:pi-web@localhost`, which Apple answers
 * with 403 BadJwtToken), so default to the project homepage and let operators
 * override it via PI_WEB_PUSH_SUBJECT.
 */
export function vapidSubject(): string {
  const configured = process.env.PI_WEB_PUSH_SUBJECT?.trim();
  if (configured) return configured;
  return "https://github.com/agegr/pi-web";
}

// Ask the push service to deliver immediately. Lower urgencies let idle
// devices (especially iOS) defer delivery to an arbitrary later window.
export const PUSH_OPTIONS = { TTL: 2419200, urgency: "high" as const };

function getDefaultEnvironment(): WebPushEnvironment {
  return {
    async send(subscription, payload, vapidKeys) {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        payload,
        {
          vapidDetails: {
            subject: vapidSubject(),
            publicKey: vapidKeys.publicKey,
            privateKey: vapidKeys.privateKey,
          },
          TTL: PUSH_OPTIONS.TTL,
          urgency: PUSH_OPTIONS.urgency,
        },
      );
    },
    loadState() {
      const path = stateFilePath();
      if (!existsSync(path)) return null;
      try {
        return JSON.parse(readFileSync(path, "utf8")) as PushStateFile;
      } catch {
        return null;
      }
    },
    saveState(state) {
      const path = stateFilePath();
      mkdirSync(dirname(path), { recursive: true });
      writePrivateFileAtomicSync(path, JSON.stringify(state));
    },
    generateVapidKeys: () => webpush.generateVAPIDKeys(),
    async listSessions() {
      try {
        return await SessionManager.listAll();
      } catch {
        // Session list is best-effort; fall back to the generic title.
        return [];
      }
    },
  };
}

function pushStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

/**
 * Locale lookup for push payloads. The browser reports its UI locale when it
 * subscribes; unknown locales fall back to English.
 */
const NOTIFICATION_I18N_KEYS = {
  sessionComplete: "i18n.sessionComplete",
  taskFinished: "i18n.taskFinished",
  taskFinishedWithContext: "i18n.taskFinishedWithContext",
  sessionFailed: "i18n.sessionFailed",
  taskFailed: "i18n.taskFailed",
  taskFailedWithContext: "i18n.taskFailedWithContext",
  taskFailedWithError: "i18n.taskFailedWithError",
  taskFailedWithContextAndError: "i18n.taskFailedWithContextAndError",
} as const;

export type NotificationTextKey = keyof typeof NOTIFICATION_I18N_KEYS;

export const NOTIFICATION_FALLBACKS: Record<NotificationTextKey, string> = {
  sessionComplete: "Session complete",
  taskFinished: "Task finished.",
  taskFinishedWithContext: "{project} · Task finished",
  sessionFailed: "Session failed",
  taskFailed: "Task failed.",
  taskFailedWithContext: "{project} · Task failed",
  taskFailedWithError: "Task failed: {error}",
  taskFailedWithContextAndError: "{project} · Task failed: {error}",
};

export function localeText(
  locale: string,
  key: NotificationTextKey,
  params?: { project?: string; error?: string },
): string {
  const messageKey = NOTIFICATION_I18N_KEYS[key];
  const message = locale === "zh-CN"
    ? zhCNLocale.messages[messageKey]
    : enLocale.messages[messageKey];
  const template = message ?? NOTIFICATION_FALLBACKS[key];
  return params
    ? template
      .replace(/\{project\}/g, params.project ?? "")
      .replace(/\{error\}/g, params.error ?? "")
    : template;
}

/** Project name for the session working directory (last path segment), used as the project label in notifications. */
function projectBasename(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const base = cwd.split(/[\\/]/).filter(Boolean).pop();
  return base || null;
}

export function createWebPushNotifier(environment: WebPushEnvironment): WebPushNotifier {
  const state: PushStateFile = (() => {
    const loaded = environment.loadState();
    if (loaded?.vapidKeys?.publicKey && loaded.vapidKeys.privateKey) return loaded;
    return { vapidKeys: environment.generateVapidKeys(), subscriptions: [] };
  })();
  const saveState = () => {
    environment.saveState(state);
  };

  return {
    getVapidPublicKey() {
      saveState();
      return state.vapidKeys.publicKey;
    },
    addSubscription(subscription) {
      state.subscriptions = [
        ...state.subscriptions.filter((s) => s.endpoint !== subscription.endpoint),
        subscription,
      ];
      saveState();
    },
    async notifySessionComplete(sessionId, outcome) {
      if (state.subscriptions.length === 0) return;
      // Terminal-state triage: user-initiated stops (aborted) are never notified; interrupted has no clear
      // completion moment (nothing to notify about).
      if (outcome && !runOutcomeNotifies(outcome.status)) return;
      const session = (await environment.listSessions()).find((s) => s.id === sessionId);
      const sessionName = session?.name;
      const projectLabel = projectBasename(session?.cwd);
      const failed = outcome?.status === "failed";
      const errorSummary = failed ? truncateRunError(outcome?.error, 120) : "";
      const payloadFor = (locale: string) => ({
        title: sessionName ?? localeText(locale, failed ? "sessionFailed" : "sessionComplete"),
        body: failed
          ? (projectLabel
              ? errorSummary
                ? localeText(locale, "taskFailedWithContextAndError", { project: projectLabel, error: errorSummary })
                : localeText(locale, "taskFailedWithContext", { project: projectLabel })
              : errorSummary
                ? localeText(locale, "taskFailedWithError", { error: errorSummary })
                : localeText(locale, "taskFailed"))
          : projectLabel
            ? localeText(locale, "taskFinishedWithContext", { project: projectLabel })
            : localeText(locale, "taskFinished"),
        url: `/?session=${encodeURIComponent(sessionId)}`,
        tag: `pi-session-complete:${sessionId}`,
      });

      let pruned = false;
      for (const subscription of [...state.subscriptions]) {
        try {
          await environment.send(
            subscription,
            JSON.stringify(payloadFor(subscription.locale)),
            state.vapidKeys,
          );
        } catch (error) {
          const statusCode = pushStatusCode(error);
          if (statusCode === 404 || statusCode === 410) {
            state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
            pruned = true;
          }
        }
      }
      if (pruned) saveState();
    },
  };
}

declare global {
  var __piWebPushNotifier: Promise<WebPushNotifier> | undefined;
}

function getNotifier(): Promise<WebPushNotifier> {
  if (!globalThis.__piWebPushNotifier) {
    globalThis.__piWebPushNotifier = Promise.resolve().then(() => createWebPushNotifier(getDefaultEnvironment()));
  }
  return globalThis.__piWebPushNotifier;
}

export function getVapidPublicKey(): Promise<string> {
  return getNotifier().then((notifier) => notifier.getVapidPublicKey());
}

export function addSubscription(subscription: PushSubscriptionRecord): Promise<void> {
  return getNotifier().then((notifier) => notifier.addSubscription(subscription));
}

export async function notifySessionComplete(sessionId: string, outcome?: SessionLastRun): Promise<void> {
  const notifier = await getNotifier();
  await notifier.notifySessionComplete(sessionId, outcome);
}
