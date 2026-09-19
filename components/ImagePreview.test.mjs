import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ImagePreview.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("composer attachments open in the shared preview with a separate remove button", async () => {
  const inputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(inputSource, /import \{ ImagePreview \} from "\.\/ImagePreview"/);
  assert.match(
    inputSource,
    /<ImagePreview src=\{`data:\${img.mimeType};base64,\${img.data}`} style=\{\{ borderRadius: 6 \}\}>[\s\S]*?<img[\s\S]*?src=\{img\.previewUrl\}[\s\S]*?<\/ImagePreview>\s*<button\s*type="button"\s*onClick=\{\(\) => removeImage\(i\)\}/,
  );
});

test("uses a native modal dialog and restores focus to its trigger", () => {
  assert.match(source, /useRef<HTMLDialogElement>\(null\)/);
  assert.match(source, /dialog\.showModal\(\)/);
  assert.match(source, /closeButtonRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /const trigger = triggerRef\.current[\s\S]*?trigger\?\.isConnected[\s\S]*?trigger\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(source, /createPortal/);
});

test("Escape closes image preview without reaching global shortcuts", () => {
  assert.match(
    source,
    /const closePreview = \(\) => \{[\s\S]*?dialogRef\.current\?\.open[\s\S]*?dialogRef\.current\.close\(\)[\s\S]*?setOpen\(false\)/,
  );
  assert.match(
    source,
    /event\.key !== "Escape"[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?closePreview\(\)/,
  );
  assert.match(
    source,
    /onCancel=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?closePreview\(\)/,
  );
});

test("closes only when the backdrop itself is clicked", () => {
  assert.match(source, /event\.target === event\.currentTarget[\s\S]*?closePreview\(\)/);
});

test("keeps the preview and Pi-style close button inside mobile safe areas", () => {
  assert.match(
    cssSource,
    /\.image-preview-dialog \{[\s\S]*?env\(safe-area-inset-top\)[\s\S]*?env\(safe-area-inset-right\)[\s\S]*?env\(safe-area-inset-bottom\)[\s\S]*?env\(safe-area-inset-left\)/,
  );
  // The dialog carries all four safe-area insets; the close button sits at a
  // fixed 12px inside that already-inset dialog (right: env() floated the
  // button ~38px off the edge on tablets — see globals.css comment).
  assert.match(
    cssSource,
    /\.image-preview-close \{[\s\S]*?top: max\(12px, env\(safe-area-inset-top\)\)[\s\S]*?right: 12px;[\s\S]*?border-radius: 6px[\s\S]*?background: var\(--bg-panel\)/,
  );
  assert.match(cssSource, /@media \(pointer: coarse\) \{[\s\S]*?\.image-preview-close \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
  assert.match(source, /<path d="M6 6l12 12M18 6 6 18" \/>/);
});

test("clicking delegates to the file-editor extension viewer, falling back to the upstream lightbox", () => {
  // Entry bridge: the file-editor extension's unified viewer (floating dialog; a lazily-loaded extension
  // is materialized first); the image tab mechanism has been removed
  assert.match(source, /import \{ openImageInEditorViewer \} from "\.\/editor-image-preview"/);
  assert.match(
    source,
    /const openPreview = \(\) => \{[\s\S]*?void openImageInEditorViewer\(src, \{ alt \}\)\.then\(\(handled\) => \{[\s\S]*?if \(!handled\) setOpen\(true\);[\s\S]*?\}\);\s*\};/,
  );
  assert.match(source, /onClick=\{openPreview\}/);
  // The fallback path (upstream native lightbox dialog) must be kept intact
  assert.match(source, /dialog\.showModal\(\)/);
});
