/**
 * aiti-folder · directory picker binding (shared dialog).
 *
 * The dialog body lives in extensions/_shared/directory-picker.tsx; this module only
 * hands it this extension's host-shim facilities. i18n goes through comp-i18n's `ct`
 * (component dictionary first, host t fallback) because this extension's reusable
 * components get inlined into other extensions at build time — the caller's dictionary
 * never carries directoryPicker.* keys.
 *
 * Replaces the retired hand-rolled `directory-browser.tsx` (bare list, arrow rows).
 */
import { apiUrl, createPortal, extSvc } from "./host-shim";
import { ct as t } from "./comp-i18n";
import { DirectoryPicker as SharedDirectoryPicker, type DirectoryPickerProps } from "../../../_shared/directory-picker";

/** Host facilities for the shared dialog (read lazily by the component). */
const HOST = { apiUrl, t, getExtService: extSvc, createPortal };

export type { DirectoryPickerProps };

export function DirectoryPicker(props: DirectoryPickerProps) {
  return <SharedDirectoryPicker {...props} host={HOST} />;
}
