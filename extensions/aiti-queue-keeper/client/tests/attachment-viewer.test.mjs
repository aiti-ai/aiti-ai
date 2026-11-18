/**
 * Attachment viewer on queue rows — clicking the row's image marker opens a
 * preview overlay listing the entry's images with download links (2026-11-18).
 *
 * Images travel only in the export view (the live projection strips base64),
 * so the click path must go through actions.exportAll and pick the entry by
 * per-kind index. In-panel zoom/download reuses the editor extension's
 * unified viewer seam (window.__aitiEditor.openImagePreview) when present.
 *
 * Static source assertions (same pattern as steer-send-gating.test.mjs:
 * no imports, zero side effects).
 * Run: node --test client/tests/attachment-viewer.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f) => readFileSync(join(srcRoot, f), "utf8");

test("row marker is clickable and fetches images via actions.exportAll", () => {
  const row = read("QueueRow.tsx");
  assert.match(row, /export function entryImagesFromExport/, "per-kind index picker must be exported for tests");
  assert.match(row, /actions\.exportAll\(\)/, "image data must come from the export view (live view strips base64)");
  assert.match(row, /entryImagesFromExport\(data\.live/, "picker must run against the export live list");
  assert.match(row, /onImageClick=\{canViewAttachments/, "marker button is gated on having attachments");
});

test("preview delegates to the editor viewer seam and falls back to the inline overlay", () => {
  const row = read("QueueRow.tsx");
  assert.match(row, /await ensureMaterialized\("aiti-editor"\)/, "lazy editor client must be pulled explicitly (ctx.ensureMaterialized — the official cross-extension bootstrap API, works on old hosts too)");
  assert.match(row, /__aitiEditor/, "after materialization the raw window seam carries the open call");
  assert.match(row, /download=\{`queued-image-/, "inline fallback keeps its own <a download> link");
  assert.match(row, /imgs\.length === 1/, "single image opens the message-style full viewer directly (no intermediate overlay)");
  const shim = read("host-shim.ts");
  assert.match(shim, /ensureMaterialized/, "host-shim must delegate ctx.ensureMaterialized");
});

test("i18n: viewer keys exist in all three locales", () => {
  const index = read(join("..", "..", "index.ts"));
  for (const key of ["chat.queueViewAttachments", "chat.queueAttachmentsTitle", "chat.queueAttachmentImage", "chat.queueAttachmentDownload"]) {
    const hits = index.split(`"${key}"`).length - 1;
    assert.equal(hits, 3, `${key} must be present in en / zh-CN / zh-TW (got ${hits})`);
  }
});
