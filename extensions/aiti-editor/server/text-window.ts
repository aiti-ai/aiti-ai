/**
 * aiti-editor · chunked text reading for large files (server side only).
 *
 * Why this module exists: /raw reads a whole file and JSON-encodes it on the
 * pi-web main thread, which freezes every session in the host process for
 * seconds on multi-MB files. The large-file viewer only ever needs a bounded
 * window, aligned to line/character boundaries, so it can page forever without
 * loading the whole document.
 *
 * All IO here is async and bounded (<= one chunk), and long scans yield between
 * chunks so the host event loop keeps serving SSE/agent traffic.
 */

import { open as openAsync, stat as statAsync } from "node:fs/promises";

export interface TextWindow {
  content: string;
  /** Byte offset this window starts at (may be aligned for UTF-16). */
  startOffset: number;
  /** Byte offset the next window starts at (=== startOffset + bytes consumed). */
  nextOffset: number;
  /** Newline count inside `content`. */
  lines: number;
  eof: boolean;
  totalSize: number;
  encoding: string;
}

const UTF16 = new Set(["utf-16le", "utf-16be"]);

function normalizeEncoding(enc: string | undefined): string {
  const e = String(enc || "utf-8").toLowerCase();
  if (e === "utf8") return "utf-8";
  if (e === "utf16le" || e === "utf-16le") return "utf-16le";
  if (e === "utf16be" || e === "utf-16be") return "utf-16be";
  if (e === "gbk" || e === "gb18030") return "gbk";
  if (e === "latin1" || e === "iso-8859-1") return "latin1";
  return "utf-8";
}

/** True when a newline starts at byte i for the given encoding. */
function isNewlineAt(buf: Buffer, i: number, encoding: string): boolean {
  if (encoding === "utf-16le") return buf[i] === 0x0a && buf[i + 1] === 0x00;
  if (encoding === "utf-16be") return buf[i] === 0x00 && buf[i + 1] === 0x0a;
  return buf[i] === 0x0a;
}

function decodeChunk(buf: Buffer, start: number, end: number, encoding: string): string {
  if (encoding === "utf-16le") return new TextDecoder("utf-16le", { ignoreBOM: true }).decode(buf.subarray(start, end));
  if (encoding === "utf-16be") {
    const b = Buffer.from(buf.subarray(start, end));
    if (b.length % 2 === 1) return new TextDecoder("utf-16le", { ignoreBOM: true }).decode(b.subarray(0, b.length - 1).swap16());
    return new TextDecoder("utf-16le", { ignoreBOM: true }).decode(b.swap16());
  }
  if (encoding === "gbk") return new TextDecoder("gbk", { ignoreBOM: true }).decode(buf.subarray(start, end));
  if (encoding === "latin1") return buf.toString("latin1", start, end);
  return buf.toString("utf8", start, end);
}

/**
 * Read one window. The window ends at the last complete line that fits in
 * `maxBytes`/`maxLines`; when a single line is longer than the budget the
 * window is cut at a character boundary so the text stays decodable.
 */
export async function readTextWindow(
  filePath: string,
  offset: number,
  maxBytes: number,
  maxLines: number,
  encodingIn?: string,
): Promise<TextWindow> {
  const encoding = normalizeEncoding(encodingIn);
  const unit = UTF16.has(encoding) ? 2 : 1;
  const st = await statAsync(filePath);
  const size = st.size;
  let start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  if (unit === 2) start -= start % 2;
  if (start > size) start = size;
  const budget = Math.max(1, Math.floor(maxBytes));

  // +8 slack bytes let us find a newline that straddles the budget boundary.
  const readLen = Math.min(budget + 8, Math.max(0, size - start));
  const fh = await openAsync(filePath, "r");
  let bytesRead = 0;
  const buf = Buffer.alloc(readLen);
  try {
    if (readLen > 0) {
      const r = await fh.read(buf, 0, readLen, start);
      bytesRead = r.bytesRead;
    }
  } finally {
    await fh.close();
  }
  if (bytesRead === 0) {
    return { content: "", startOffset: start, nextOffset: start, lines: 0, eof: true, totalSize: size, encoding };
  }

  // BOM at the very beginning belongs to the file, not to the first line.
  let bodyStart = 0;
  if (start === 0) {
    if (encoding === "utf-8" && bytesRead >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bodyStart = 3;
    else if (UTF16.has(encoding) && bytesRead >= 2) {
      const le = buf[0] === 0xff && buf[1] === 0xfe;
      const be = buf[0] === 0xfe && buf[1] === 0xff;
      if (le || be) bodyStart = 2;
    }
  }

  const atEof = start + bytesRead >= size;
  let end = Math.min(bytesRead, budget + bodyStart);
  if (end % unit !== 0) end -= end % unit;

  // Prefer ending on a newline (keeps pages line-aligned and decoding safe).
  let lastNl = -1;
  for (let i = bodyStart; i + unit <= end; i += unit) {
    if (isNewlineAt(buf, i, encoding)) lastNl = i + unit;
  }
  if (lastNl > 0) {
    end = lastNl;
  } else if (!atEof) {
    // No newline in budget (one huge line): back off to a character boundary.
    if (encoding === "utf-8") {
      while (end > bodyStart && (buf[end] & 0xc0) === 0x80) end--;
    }
  }

  // Cap by lines as well (short lines: 512KB can be tens of thousands of lines).
  if (maxLines > 0) {
    let lines = 0;
    for (let i = bodyStart; i + unit <= end; i += unit) {
      if (!isNewlineAt(buf, i, encoding)) continue;
      lines++;
      if (lines >= maxLines) { end = i + unit; break; }
    }
  }

  const content = decodeChunk(buf, bodyStart, end, encoding);
  let lines = 0;
  for (let i = bodyStart; i + unit <= end; i += unit) if (isNewlineAt(buf, i, encoding)) lines++;
  const consumed = end;
  return {
    content,
    startOffset: start,
    nextOffset: start + consumed,
    lines,
    eof: start + bytesRead >= size,
    totalSize: size,
    encoding,
  };
}

export interface LineCount {
  lines: number;
  /** True when the scan stopped at the budget (count is a lower bound). */
  partial: boolean;
  scannedBytes: number;
  totalSize: number;
}

/** Count newlines in bounded chunks, yielding to the event loop between chunks. */
export async function countFileLines(filePath: string, maxScanBytes = 64 * 1024 * 1024): Promise<LineCount> {
  const st = await statAsync(filePath);
  const size = st.size;
  const chunk = 1 << 20;
  const fh = await openAsync(filePath, "r");
  let pos = 0;
  let lines = 0;
  try {
    while (pos < size && pos < maxScanBytes) {
      const len = Math.min(chunk, size - pos, maxScanBytes - pos);
      const buf = Buffer.allocUnsafe(len);
      const r = await fh.read(buf, 0, len, pos);
      if (r.bytesRead <= 0) break;
      const view = buf.subarray(0, r.bytesRead);
      let i = view.indexOf(0x0a);
      while (i !== -1) { lines++; i = view.indexOf(0x0a, i + 1); }
      pos += r.bytesRead;
      // Yield so a 100MB scan never blocks the host process.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    await fh.close();
  }
  if (pos >= size) lines += 1; // last line without trailing newline
  return { lines, partial: pos < size, scannedBytes: pos, totalSize: size };
}
