import type { BlockingExtensionUiRequest, ExtensionUiRequest } from "./types";

interface WindowNotificationLike {
  onclick: Notification["onclick"];
  close: () => void;
}

interface ServiceWorkerRegistrationLike {
  showNotification: (title: string, options?: NotificationOptions) => Promise<void>;
  getNotifications?: () => Promise<OpenNotificationLike[]>;
}

/** Tag base name for completion notifications (`<base>:<sessionId>` when a session exists, bare base name otherwise). */
export const SESSION_NOTIFICATION_TAG_PREFIX = "pi-session-complete";

/**
 * On-screen cap for completion notifications. Browser tag-based dedup only applies
 * within the same session, so notifications from concurrent sessions pile up
 * unboundedly (user feedback: "so many at once") — past the cap, a new notification
 * replaces the oldest one.
 */
export const SESSION_NOTIFICATION_LIMIT = 3;

/** Minimal shape of an existing notification that can be enumerated/closed (structural subset of Notification). */
export interface OpenNotificationLike {
  tag?: string;
  timestamp?: number;
  close: () => void;
}

/** Whether a tag belongs to the completion-notification pool (the bare base name, or `<base>:<sessionId>`). */
function isSessionNotificationTag(tag: unknown): tag is string {
  return typeof tag === "string"
    && (tag === SESSION_NOTIFICATION_TAG_PREFIX || tag.startsWith(`${SESSION_NOTIFICATION_TAG_PREFIX}:`));
}

/**
 * Compute which older completion notifications should be closed before showing
 * `incomingTag`, so that at most `limit` remain on screen afterwards.
 *
 * - `incomingTag` already exists (a duplicate for the same session is replaced by the
 *   browser rather than added) → press the total back down to `limit`;
 * - `incomingTag` does not exist (a new entry) → keep at most `limit - 1` older ones;
 * - Closing order: oldest first (missing timestamps count as oldest; stable sort
 *   preserves the original relative order).
 *
 * Non-completion notifications (extension input prompts etc.) are not part of this
 * pool: they neither count against the cap nor get closed.
 */
export function sessionNotificationsToClose<T extends OpenNotificationLike>(
  existing: ReadonlyArray<T>,
  incomingTag: string | undefined,
  limit = SESSION_NOTIFICATION_LIMIT,
): T[] {
  if (!isSessionNotificationTag(incomingTag)) return [];
  const open = existing
    .filter((n): n is T & { tag: string } => isSessionNotificationTag(n.tag))
    .slice()
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const replacesExisting = open.some((n) => n.tag === incomingTag);
  const keep = Math.max(0, replacesExisting ? limit : limit - 1);
  const overflow = open.length - keep;
  return overflow > 0 ? open.slice(0, overflow) : [];
}

/** Close overflowing completion notifications (best-effort; silently skip if enumeration is unavailable/fails, without affecting display). */
async function closeSessionNotificationOverflow(
  registration: ServiceWorkerRegistrationLike,
  incomingTag: string | undefined,
): Promise<void> {
  if (!registration.getNotifications) return;
  try {
    const open = await registration.getNotifications();
    for (const stale of sessionNotificationsToClose(open, incomingTag)) {
      try {
        stale.close();
      } catch {
        // A single failed close must not affect the rest of the cleanup or the display
      }
    }
  } catch {
    // Enumeration failed: degrade to the browser's native tag replacement (same session still won't stack)
  }
}

export interface BrowserNotificationEnvironment {
  createWindowNotification: (title: string, options?: NotificationOptions) => WindowNotificationLike;
  getServiceWorkerRegistration: (() => Promise<ServiceWorkerRegistrationLike | undefined>) | null;
}

export interface BrowserNotificationOptions {
  title: string;
  body: string;
  sessionUrl: string;
  onClick: () => void;
  tag?: string;
}

export type NotificationDelivery = "service-worker" | "window" | null;

type DocumentAttentionState = Pick<Document, "visibilityState" | "hasFocus">;

export function shouldShowBrowserNotification(
  attentionState: DocumentAttentionState = document,
): boolean {
  return attentionState.visibilityState !== "visible" || !attentionState.hasFocus();
}

export function isBlockingExtensionUiRequest(
  request: ExtensionUiRequest,
): request is BlockingExtensionUiRequest {
  switch (request.method) {
    case "select":
    case "confirm":
    case "input":
    case "editor":
      return true;
    case "custom":
      return request.closed !== true;
    default:
      return false;
  }
}

export function claimExtensionAttentionNotification(
  request: ExtensionUiRequest,
  notifiedRequestIds: Set<string>,
): request is BlockingExtensionUiRequest {
  if (!isBlockingExtensionUiRequest(request) || notifiedRequestIds.has(request.id)) return false;
  notifiedRequestIds.add(request.id);
  return true;
}

function getBrowserEnvironment(): BrowserNotificationEnvironment {
  return {
    createWindowNotification: (title, options) => new Notification(title, options),
    getServiceWorkerRegistration: "serviceWorker" in navigator
      ? () => navigator.serviceWorker.getRegistration()
      : null,
  };
}

export async function showBrowserNotification(
  options: BrowserNotificationOptions,
  environment: BrowserNotificationEnvironment = getBrowserEnvironment(),
): Promise<NotificationDelivery> {
  const notificationOptions: NotificationOptions = {
    body: options.body,
    ...(options.tag ? { tag: options.tag, renotify: true } : {}),
  };

  if (environment.getServiceWorkerRegistration) {
    try {
      const registration = await environment.getServiceWorkerRegistration();
      if (registration) {
        await closeSessionNotificationOverflow(registration, options.tag);
        await registration.showNotification(options.title, {
          ...notificationOptions,
          data: { url: options.sessionUrl },
        });
        return "service-worker";
      }
    } catch {
      // Fall back to a page notification where the constructor is supported.
    }
  }

  try {
    const notification = environment.createWindowNotification(options.title, notificationOptions);
    notification.onclick = () => {
      notification.close();
      options.onClick();
    };
    return "window";
  } catch {
    // Most mobile browsers expose Notification but require service-worker delivery.
    return null;
  }
}
