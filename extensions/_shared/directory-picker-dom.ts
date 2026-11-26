/**
 * Directory-picker DOM contract (pure, JSX-free so callers can import it for a predicate
 * without pulling the dialog into their chunk).
 *
 * The dialog is portaled to <body>, outside the trigger's DOM subtree. Dropdowns/panels that
 * close on "outside click" or on scroll would then tear the dialog down while the user is
 * still working in it (folder dock's title switcher, workspace dropdowns, filter menus).
 * Those handlers must skip targets matched by {@link isDirectoryPickerTarget}.
 */

/** Marker attribute on the dialog root (also the search root for the predicate below). */
export const DIRECTORY_PICKER_ATTR = "data-aiti-directory-picker";

/** True when the event target lives inside a mounted directory-picker dialog. */
export function isDirectoryPickerTarget(target: unknown): boolean {
  const el = target as Element | null;
  try {
    return typeof el?.closest === "function" && !!el.closest(`[${DIRECTORY_PICKER_ATTR}]`);
  } catch {
    return false;
  }
}
