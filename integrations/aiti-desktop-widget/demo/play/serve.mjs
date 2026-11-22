#!/usr/bin/env node
/**
 * Tiny Range-capable static server for the play demo.
 * Python's http.server does not implement Range, so seeking would not work.
 *
 *   node serve.mjs [port]        # default 18080, 127.0.0.1 only
 *   open http://127.0.0.1:18080/play.html
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 18080;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".lrc": "text/plain; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function safePath(url) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(url, "http://localhost").pathname); }
  catch { return null; }
  const rel = normalize(pathname).replace(/^([/\\])+/, "");
  const file = resolve(join(ROOT, rel));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return null;
  return file;
}

function headers(type, length, extra = {}) {
  return {
    "content-type": type,
    "content-length": String(length),
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}

const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("method not allowed");
    return;
  }
  let file = safePath(req.url || "/");
  if (!file) { res.writeHead(403); res.end("forbidden"); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end("not found"); return; }
  const size = statSync(file).size;
  const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (!range) {
    res.writeHead(200, headers(type, size));
    if (req.method === "HEAD") res.end(); else createReadStream(file).pipe(res);
    return;
  }
  const start = range[1] ? Number(range[1]) : 0;
  const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    res.writeHead(416, { "content-range": `bytes */${size}` });
    res.end();
    return;
  }
  res.writeHead(206, headers(type, end - start + 1, {
    "content-range": `bytes ${start}-${end}/${size}`,
  }));
  if (req.method === "HEAD") res.end(); else createReadStream(file, { start, end }).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`aiti play demo: http://127.0.0.1:${PORT}/play.html`);
});
