import type { BlockingExtensionUiRequest, ExtensionUiRequest } from "./types";

interface WindowNotificationLike {
  onclick: Notification["onclick"];
  close: () => void;
}

interface ServiceWorkerRegistrationLike {
  showNotification: (title: string, options?: NotificationOptions) => Promise<void>;
  getNotifications?: () => Promise<OpenNotificationLike[]>;
}

/** 完成类通知的 tag 基名（有会话时为 `基名:<sessionId>`，无会话兜底为基名本身）。 */
export const SESSION_NOTIFICATION_TAG_PREFIX = "pi-session-complete";

/**
 * 完成类通知同屏上限。浏览器按 tag 去重只对同一会话生效，多会话并发完成时
 * 通知会无限堆叠（用户反馈「一次弹出这么多」）——超出上限时新通知替换最旧的。
 */
export const SESSION_NOTIFICATION_LIMIT = 3;

/** 可枚举/可关闭的既有通知的最小形状（Notification 的结构子集）。 */
export interface OpenNotificationLike {
  tag?: string;
  timestamp?: number;
  close: () => void;
}

/** 判定 tag 是否属于完成类通知池（基名本身，或 `基名:<sessionId>`）。 */
function isSessionNotificationTag(tag: unknown): tag is string {
  return typeof tag === "string"
    && (tag === SESSION_NOTIFICATION_TAG_PREFIX || tag.startsWith(`${SESSION_NOTIFICATION_TAG_PREFIX}:`));
}

/**
 * 计算显示 `incomingTag` 之前应关闭的旧完成类通知，使显示后不超过 `limit` 条。
 *
 * - `incomingTag` 已存在（同一会话的重复通知会被浏览器替换而非新增）→ 把总量压回 `limit`；
 * - `incomingTag` 不存在（新增一条）→ 旧通知最多保留 `limit - 1` 条；
 * - 关闭顺序：最旧优先（无时间戳视为最旧；稳定排序保持原相对顺序）。
 *
 * 非完成类通知（扩展输入提示等）不属于本池，既不计入上限也不被关闭。
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

/** 关闭溢出的完成类通知（best-effort；枚举不可用/失败时静默跳过，不影响展示）。 */
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
        // 单条关闭失败不影响其余清理与展示
      }
    }
  } catch {
    // 枚举失败退化为浏览器原生 tag 替换（同一会话仍不堆叠）
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
