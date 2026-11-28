/**
 * aiti-quickstart · directory picker binding (shared dialog).
 *
 * The dialog body lives in extensions/_shared/directory-picker.tsx; this module only
 * hands it this extension's host-shim facilities (basePath URL builder, i18n dictionary,
 * portal, cross-extension service reader). Replaces the inlined aiti-folder
 * DirectoryBrowser (bare list, arrow rows) so the hub shows the same picker as the
 * sidebar.
 */
import { apiUrl, createPortal, extSvc, t } from "./host-shim";
import { DirectoryPicker as SharedDirectoryPicker, type DirectoryPickerProps } from "@aiti-ai/ext-shared/directory-picker";

/** Host facilities for the shared dialog (read lazily by the component). */
const HOST = { apiUrl, t, getExtService: extSvc, createPortal };

export type { DirectoryPickerProps };

export function DirectoryPicker(props: DirectoryPickerProps) {
  return <SharedDirectoryPicker {...props} host={HOST} />;
}
