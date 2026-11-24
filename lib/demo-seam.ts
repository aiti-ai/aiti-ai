/**
 * Demo seam — optional, no-op by default overrides used by the standalone
 * static demo build (aiti-demos). Production keeps every resolver null, so
 * behavior is byte-for-byte the normal host path.
 *
 * Two seams only (see aiti-demos/docs/plan):
 *  - media URL resolver: GET-only file consumers (<img>/<video>/<iframe>/
 *    EventSource) go through short-lived ticket URLs; the demo maps those to
 *    static snapshot assets.
 *  - full-history opener: the server renders an HTML export; the demo renders
 *    the transcript in a Blob window instead.
 */

export type MediaUrlResolver = (url: string) => string;

let mediaUrlResolver: MediaUrlResolver | null = null;

/** Install the demo's static-asset resolver (null restores the host behavior). */
export function setMediaUrlResolver(resolver: MediaUrlResolver | null): void {
  mediaUrlResolver = resolver;
}

/** Resolve a GET-only media URL; returns the input unchanged in production. */
export function resolveMediaUrl(url: string): string {
  return mediaUrlResolver ? mediaUrlResolver(url) : url;
}

export type FullHistoryOpener = (sessionId: string, url: string) => void;

let fullHistoryOpener: FullHistoryOpener | null = null;

/** Install the demo's in-browser history renderer (null restores the host behavior). */
export function setFullHistoryOpener(opener: FullHistoryOpener | null): void {
  fullHistoryOpener = opener;
}

/** Open a session's full history; the host opens the server-rendered export. */
export function openFullHistory(sessionId: string, url: string): void {
  if (fullHistoryOpener) {
    fullHistoryOpener(sessionId, url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export type TitleDecorator = (title: string) => string;

let titleDecorator: TitleDecorator | null = null;

/** Install a window-title decorator (null restores the host title verbatim). */
export function setTitleDecorator(decorator: TitleDecorator | null): void {
  titleDecorator = decorator;
}

/** Apply the decorator (identity in production) — used where the title is written. */
export function decorateTitle(title: string): string {
  return titleDecorator ? titleDecorator(title) : title;
}
