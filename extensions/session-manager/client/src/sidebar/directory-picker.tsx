/**
 * sidebar/directory-picker — session-manager's binding of the shared directory picker.
 *
 * The dialog body lives in extensions/_shared/directory-picker.tsx (one shape on every
 * extension surface: Explorer-style breadcrumb + drive list + "New folder" row); this
 * module only hands it this extension's host-shim facilities (basePath URL builder,
 * i18n dictionary, portal, cross-extension service reader).
 *
 * Lazy chunk contract: sidebar-dock / sidebar-content / export-dialog /
 * new-session-workspace-picker createLazyModule(() => import("./sidebar/directory-picker"))
 * and pick the "DirectoryPicker" export — keep the name.
 */
import { apiUrl, createPortal, getExtService, t } from "../host-shim";
import { DirectoryPicker as SharedDirectoryPicker, type DirectoryPickerProps } from "@aiti-ai/ext-shared/directory-picker";

/** Host facilities for the shared dialog (read lazily by the component). */
const HOST = { apiUrl, t, getExtService, createPortal };

export type { DirectoryPickerProps as Props };

export function DirectoryPicker(props: DirectoryPickerProps) {
  return <SharedDirectoryPicker {...props} host={HOST} />;
}
