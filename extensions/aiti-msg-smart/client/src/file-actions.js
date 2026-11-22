/**
 * File card action-row ordering (pure, unit-testable).
 *
 * The file row renders built-in actions (Open / Reveal) interleaved with
 * external `msg-file-action` topic providers (e.g. Share). Ordering follows the
 * host slot convention (`meta.order`: ascending, unordered entries last), except
 * that an unordered provider falls between the two built-ins instead of after
 * them — so the default row reads Open → external (Share) → Reveal, and a
 * provider can still move itself anywhere by declaring `order`.
 */

/** Ascending order keys for the built-in file row actions. */
export const FILE_ACTION_ORDER = { open: 10, external: 20, reveal: 30 };

/** Effective order of one row entry (external provider or built-in descriptor). */
export function fileActionOrder(item) {
  const raw = item == null ? null : item.order;
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : FILE_ACTION_ORDER.external;
}

/** Stable ascending sort by effective order; registration order breaks ties. */
export function sortFileActions(items) {
  return (items || [])
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) => (fileActionOrder(a.it) - fileActionOrder(b.it)) || (a.idx - b.idx))
    .map((x) => x.it);
}
