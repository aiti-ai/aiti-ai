import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { workerData, parentPort } from "node:worker_threads";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
function escSeg(seg) {
  let r = "";
  for (const ch of seg) {
    if (ch === "*") r += "[^/]*";
    else if (ch === "?") r += "[^/]";
    else r += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return r;
}
function compileIgnoreGlob(glob) {
  let body = glob;
  let pre = "";
  let tail = "(?:/.*)?";
  if (body === "**") return /^.*$/;
  const anchored = body.includes("/");
  if (body.endsWith("/**")) {
    body = body.slice(0, -3);
    tail = "/.*";
  } else if (body.endsWith("/")) {
    body = body.slice(0, -1);
    tail = "/.*";
  }
  if (!anchored) pre += "(?:.*/)?";
  if (body.startsWith("**/")) {
    pre += "(?:.*/)?";
    body = body.slice(3);
  } else if (body.startsWith("**")) {
    pre += ".*";
    body = body.slice(2);
  }
  if (!body) return new RegExp("^" + pre + (tail === "/.*" ? "/.*" : "") + "$");
  if (body.startsWith("/")) body = body.slice(1);
  const segs = body.split("/**/");
  return new RegExp("^" + pre + segs.map(escSeg).join("(?:.*/)?") + tail + "$");
}
function compileIgnoreLines(text) {
  const out = [];
  for (let raw of String(text || "").split(/\r?\n/)) {
    raw = raw.replace(/\s+$/, "");
    if (!raw || raw.startsWith("#")) continue;
    let neg = false;
    if (raw.startsWith("!")) {
      neg = true;
      raw = raw.slice(1);
    }
    let dirOnly = raw.endsWith("/");
    if (dirOnly) raw = raw.slice(0, -1);
    if (!raw) continue;
    out.push({ neg, dirOnly, re: compileIgnoreGlob(raw) });
  }
  return out;
}
function matchRules(rules, rel) {
  let decision = null;
  for (const r of rules) {
    if (r.re.test(rel)) decision = !r.neg;
  }
  return decision;
}
const SCHEMA_VERSION = "2";
const TAG_LOGIC_VERSION = "3";
const INDEX_LOGIC_VERSION = "1";
const KEYSEP = "\0";
const TAG_RE = /(^|[^\p{L}\p{N}_#&\/])#([\p{L}\p{N}_][\p{L}\p{N}_\-\/]{0,63}[\p{L}\p{N}_])/gmu;
function normalizeTag(raw) {
  let s = String(raw ?? "").trim().replace(/^#+/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "").trim();
  if (!s || s.length > 64) return null;
  const segs = s.split("/");
  if (segs.length > 6) return null;
  for (const seg of segs) {
    if (!seg || !/^[\p{L}\p{N}_\-]+$/u.test(seg)) return null;
  }
  if (!/[\p{L}_]/u.test(s)) return null;
  return { key: s.toLowerCase(), display: s };
}
function parseFrontMatter(text) {
  const out = { tags: [] };
  const lines = text.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== "---") return { data: out, bodyStart: 0 };
  const fmLines = [];
  let i = 1;
  let closed = false;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") {
      i++;
      closed = true;
      break;
    }
    fmLines.push(lines[i]);
  }
  if (!closed) return { data: out, bodyStart: 0 };
  let off = 0;
  for (let k = 0; k < i && k < lines.length; k++) off += lines[k].length + 1;
  for (let j = 0; j < fmLines.length; j++) {
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(fmLines[j]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "tags") {
      if (val.startsWith("[") && val.endsWith("]")) {
        out.tags.push(...splitFlowList(val.slice(1, -1)));
      } else if (val === "") {
        for (j++; j < fmLines.length; j++) {
          const bm = /^\s*-\s+(.*)$/.exec(fmLines[j]);
          if (!bm) break;
          const v = stripVal(bm[1]);
          if (v) out.tags.push(v);
        }
      } else {
        const v = stripVal(val);
        if (v) out.tags.push(v);
      }
    } else if (key === "title" && val) {
      out.title = unquote(val);
    }
  }
  return { data: out, bodyStart: Math.min(off, text.length) };
}
function splitFlowList(inner) {
  const parts = [];
  let cur = "";
  let q = "";
  for (const ch of inner) {
    if (q) {
      if (ch === q) q = "";
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      continue;
    }
    if (ch === ",") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(stripVal).filter(Boolean);
}
function stripVal(v) {
  return unquote(v.trim().replace(/^#+/, "").trim());
}
function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && (s[0] === '"' && s[s.length - 1] === '"' || s[0] === "'" && s[s.length - 1] === "'")) {
    return s.slice(1, -1).trim();
  }
  return s;
}
function stripFences(text) {
  const out = [];
  let fenceCh = "";
  let fenceLen = 0;
  for (const l of text.split(/\r?\n/)) {
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (m) {
      const marker = m[1];
      if (!fenceCh) {
        fenceCh = marker[0];
        fenceLen = marker.length;
        continue;
      }
      if (marker[0] === fenceCh && marker.length >= fenceLen && m[2].trim() === "") fenceCh = "";
      continue;
    }
    if (fenceCh) continue;
    out.push(l);
  }
  return out.join("\n");
}
function extractBigrams(text) {
  const set = /* @__PURE__ */ new Set();
  const chars = [...String(text ?? "")];
  const WORD_CHAR = /[\p{L}\p{N}]/u;
  let prev = "";
  for (const ch of chars) {
    if (/\s/u.test(ch)) {
      prev = "";
      continue;
    }
    if (prev && WORD_CHAR.test(prev) && WORD_CHAR.test(ch)) {
      const g = (prev + ch).toLowerCase();
      if ([...g].length === 2) set.add(g);
    }
    prev = ch;
  }
  return set;
}
function inlineTagScan(body) {
  let t = stripFences(body).replace(/<!--[\s\S]*?-->/g, "\n");
  const found = [];
  for (let line of t.split("\n")) {
    if (/^(\s{4,}|\t)/.test(line)) continue;
    line = line.replace(/`[^`\n]*`/g, " ");
    line = line.replace(/\]\([^)\n]*\)/g, "] ");
    line = line.replace(/https?:\/\/[^\s)]+/g, " ");
    TAG_RE.lastIndex = 0;
    let m;
    while (m = TAG_RE.exec(line)) {
      found.push(m[2]);
    }
  }
  return found;
}
function extractHeadings(body) {
  const out = [];
  const lines = stripFences(body).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(lines[i]);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/\s#+\s*$/, "").trim() || m[2].trim(), line: i + 1 });
  }
  return out;
}
function extractLinks(body) {
  const t = stripFences(body).replace(/`[^`\n]*`/g, " ");
  const out = [];
  let m;
  const MD = /\[[^\]\n]*\]\(([^)\s]+?\.md)(#[^)\s]*)?\)/gi;
  while (m = MD.exec(t)) out.push({ kind: "md", target: m[1] });
  const WIKI = /\[\[([^\]|\n#]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
  while (m = WIKI.exec(t)) out.push({ kind: "wiki", target: m[1].trim() });
  const AT = /(?<![\w.\/\-@])@([\w.\-\/]+\.md)\b/g;
  while (m = AT.exec(t)) out.push({ kind: "at", target: m[1] });
  return out;
}
function parseMarkdown(text) {
  const fm = parseFrontMatter(text);
  const body = text.slice(fm.bodyStart);
  const headings = extractHeadings(body);
  let title = fm.data.title;
  if (!title) {
    const h1 = headings.find((h) => h.level === 1);
    if (h1) title = h1.text;
  }
  return {
    title: title || void 0,
    fmTags: fm.data.tags,
    inlineTags: inlineTagScan(body),
    headings,
    links: extractLinks(body),
    body,
    wordCount: body.length
  };
}
const JUNK_DIR_WORDS = "tmp|temp|scratch|sandbox|playground|debug|wip|draft|backup|bak|copy|old|new|untitled|work|workdir|working|cache|run|test|foo|bar|baz|foobar|asdf|qwer|zxcv|asdfgh|qwerty|xxx|yyy|zzz|aaaa|新建文件夹|未命名|临时|备份|副本|最终版?|最新|final|测试";
const JUNK_DIR_WORD_RE = new RegExp(String.raw`^(?:` + JUNK_DIR_WORDS + String.raw`)(?:[._-].*)?$`, "i");
const JUNK_DIR_WORD_NUM_RE = new RegExp(String.raw`^(?:` + JUNK_DIR_WORDS + String.raw`)\d*$`, "i");
const SINGLE_CHAR_RE = /^[a-z]$/i;
const REPEAT_CHAR_RE = /^(.)\1{2,}$/u;
const KEYBOARD_MASH_RE = /^(?:asdf|qwer|zxcv|qwerty|asdfgh|haha)/i;
const HIGH_ENTROPY_RE = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])[a-zA-Z0-9]{10,}$/;
const HEX8_RE = /^[0-9a-f]{8,}$/i;
function isDateLikeDigits(name) {
  return /^\d{4}$/.test(name) && /^(19|20)/.test(name) || /^\d{1,2}$/.test(name) || /^(19|20)\d{2}[-_]?(0[1-9]|1[0-2])([-_]?\d{1,2})?$/.test(name) || /^(19|20)\d{6}$/.test(name);
}
function isRandomDirName(name) {
  if (/[0-9a-f]{16,}/i.test(name)) return true;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(name)) return true;
  if (/[a-z_-]+[_-]?\d{6,}$/i.test(name)) return true;
  if (/^\d+([-_]\d+)*$/.test(name) && !isDateLikeDigits(name)) return true;
  if (!/[a-z\u4e00-\u9fa5]/i.test(name) && !isDateLikeDigits(name)) return true;
  if (JUNK_DIR_WORD_RE.test(name)) return true;
  if (JUNK_DIR_WORD_NUM_RE.test(name)) return true;
  if (SINGLE_CHAR_RE.test(name)) return true;
  if (REPEAT_CHAR_RE.test(name)) return true;
  if (KEYBOARD_MASH_RE.test(name)) return true;
  if (HIGH_ENTROPY_RE.test(name)) return true;
  if (HEX8_RE.test(name) && name.length >= 8 && !isDateLikeDigits(name)) return true;
  return false;
}
function derivePathTags(rel, maxDepth = 6) {
  const dir = dirname(rel).replace(/\\/g, "/");
  if (!dir || dir === ".") return [];
  const segs = dir.split("/").filter(Boolean);
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (let i = segs.length - 1; i >= 0 && out.length < maxDepth; i--) {
    const seg = segs[i];
    if (!/^[\p{L}\p{N}_\-]+$/u.test(seg)) continue;
    if (isRandomDirName(seg)) continue;
    if (!seen.has(seg)) {
      seen.add(seg);
      out.push(seg);
    }
  }
  return out;
}
function contentHash(s) {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}
function isExcluded(name, excludes2) {
  if (excludes2.has(name)) return true;
  for (const pat of excludes2) {
    if (pat.includes("*")) {
      const re = new RegExp("^" + pat.split("*").map(escapeRe).join(".*") + "$");
      if (re.test(name)) return true;
    }
  }
  return false;
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const IGNORE_FILES = [".gitignore", ".aitiignore", ".dockerignore"];
function parseIgnoreSet(text) {
  return { rules: compileIgnoreLines(text) };
}
function isIgnoredPath(stack, rel) {
  for (let i = stack.items.length - 1; i >= 0; i--) {
    const item = stack.items[i];
    const relToBase = item.base ? rel.slice(item.base.length + 1) : rel;
    if (!relToBase) continue;
    const d = matchRules(item.set.rules, relToBase);
    if (d !== null) return d;
  }
  return false;
}
function loadIgnoreSet(dirAbs) {
  let set = null;
  for (const f of IGNORE_FILES) {
    const p = dirAbs + "/" + f;
    if (!existsSync(p)) continue;
    try {
      const parsed = parseIgnoreSet(readFileSync(p, "utf8"));
      if (!set) set = { rules: [] };
      set.rules.push(...parsed.rules);
    } catch {
    }
  }
  return set;
}
function walkFiles(root, excludes2, relPrefix = "", out = [], stack = { items: [] }) {
  const dirAbs = relPrefix ? root + "/" + relPrefix : root;
  let entries = [];
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return out;
  }
  const own = loadIgnoreSet(dirAbs);
  const myStack = own ? { items: stack.items.concat({ base: relPrefix, set: own }) } : stack;
  for (const e of entries) {
    if (e.name.startsWith(".git")) continue;
    if (isExcluded(e.name, excludes2)) continue;
    const rel = relPrefix ? relPrefix + "/" + e.name : e.name;
    const abs = root + "/" + rel;
    if (e.isDirectory()) {
      if (isIgnoredPath(myStack, rel)) continue;
      walkFiles(root, excludes2, rel, out, myStack);
    } else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) {
      if (isIgnoredPath(myStack, rel)) continue;
      try {
        const st = statSync(abs);
        out.push({ abs, rel, mtimeMs: Math.round(st.mtimeMs), size: st.size });
      } catch {
      }
    }
  }
  return out;
}
function resolveAbs(target, roots) {
  let t = target.replace(/\\/g, "/");
  if (t.startsWith("~")) t = homedir() + t.slice(1);
  for (const r0 of roots) {
    const r = r0.replace(/\/+$/, "");
    if (t.startsWith(r + "/")) return { root: r, rel: t.slice(r.length + 1) };
  }
  return null;
}
function linkCandidates(target, docRel) {
  const norm = (p) => {
    const segs = [];
    for (const s of p.replace(/\\/g, "/").split("/")) {
      if (!s || s === ".") continue;
      if (s === "..") segs.pop();
      else segs.push(s);
    }
    return segs.join("/");
  };
  const raw = target.replace(/\\/g, "/");
  const dir = dirname(docRel).replace(/\\/g, "/");
  const c1 = norm((dir && dir !== "." ? dir + "/" : "") + raw);
  const c2 = norm(raw);
  return c1 === c2 ? [c1] : [c1, c2];
}
function initSchema(db2) {
  db2.exec(`
    CREATE TABLE IF NOT EXISTS docs(
      id INTEGER PRIMARY KEY,
      root TEXT NOT NULL,
      relpath TEXT NOT NULL,
      title TEXT,
      mtime_ms INTEGER,
      size INTEGER,
      hash TEXT,
      headings_json TEXT,
      links_json TEXT,
      word_count INTEGER DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      indexed_at INTEGER,
      rank REAL NOT NULL DEFAULT 0,
      rank_norm REAL NOT NULL DEFAULT 0,
      UNIQUE(root, relpath));
    CREATE TABLE IF NOT EXISTS tags(
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      display TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS doc_tags(
      doc_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('frontmatter','inline','path','ui')),
      UNIQUE(doc_id, tag_id, source));
    CREATE TABLE IF NOT EXISTS doc_links(
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      UNIQUE(from_id, to_id));
    CREATE TABLE IF NOT EXISTS doc_sessions(
      doc_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      first_op INTEGER,
      last_op INTEGER,
      op_count INTEGER DEFAULT 0,
      UNIQUE(doc_id, session_id));
    CREATE TABLE IF NOT EXISTS pending_session_docs(
      root TEXT NOT NULL,
      path TEXT NOT NULL,
      sid TEXT NOT NULL,
      first_op INTEGER,
      last_op INTEGER,
      op_count INTEGER DEFAULT 0,
      UNIQUE(root, path, sid));
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      title, headings, tags_text, body, path UNINDEXED, doc_id UNINDEXED,
      tokenize='trigram');
    CREATE TABLE IF NOT EXISTS doc_bigrams(
      doc_id INTEGER NOT NULL,
      gram TEXT NOT NULL,
      UNIQUE(doc_id, gram));
    CREATE INDEX IF NOT EXISTS idx_doc_bigrams_gram ON doc_bigrams(gram);
  `);
  db2.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(SCHEMA_VERSION);
}
function docKey(root, rel) {
  return root + KEYSEP + rel;
}
function compareMap(db2) {
  const rows = db2.prepare("SELECT id, root, relpath, mtime_ms, size, deleted FROM docs").all();
  const map = /* @__PURE__ */ new Map();
  for (const r of rows) map.set(docKey(r.root, r.relpath), { id: r.id, mtimeMs: r.mtime_ms, size: r.size, deleted: r.deleted });
  return map;
}
function upsertDoc(db2, rec) {
  const now = Date.now();
  db2.exec("BEGIN");
  try {
    let id = 0;
    const row = db2.prepare("SELECT id FROM docs WHERE root=? AND relpath=?").get(rec.root, rec.rel);
    if (row) {
      id = row.id;
      db2.prepare("UPDATE docs SET deleted=0 WHERE id=?").run(id);
    } else {
      const rn = db2.prepare("SELECT id FROM docs WHERE root=? AND hash=? AND deleted=1 ORDER BY indexed_at DESC LIMIT 1").get(rec.root, rec.hash);
      if (rn) {
        id = rn.id;
        db2.prepare("UPDATE docs SET relpath=?, deleted=0 WHERE id=?").run(rec.rel, id);
        db2.prepare("DELETE FROM doc_tags WHERE doc_id=?").run(id);
        db2.prepare("DELETE FROM doc_links WHERE from_id=?").run(id);
      } else {
        const ins = db2.prepare("INSERT INTO docs(root, relpath, deleted, indexed_at) VALUES(?,?,0,?)").run(rec.root, rec.rel, now);
        id = Number(ins.lastInsertRowid);
      }
    }
    const tagSet = [];
    const push = (raw, source) => {
      const n = normalizeTag(raw);
      if (n && !tagSet.some((t) => t.key === n.key && t.source === source)) tagSet.push({ ...n, source });
    };
    for (const tg of rec.parsed.fmTags) push(tg, "frontmatter");
    for (const tg of rec.parsed.inlineTags) push(tg, "inline");
    for (const tg of rec.pathTags) push(tg, "path");
    db2.prepare("DELETE FROM doc_tags WHERE doc_id=?").run(id);
    const ensureTag = db2.prepare("INSERT OR IGNORE INTO tags(key, display) VALUES(?, ?)");
    const getTag = db2.prepare("SELECT id FROM tags WHERE key=?");
    const insDT = db2.prepare("INSERT OR IGNORE INTO doc_tags(doc_id, tag_id, source) VALUES(?,?,?)");
    for (const t of tagSet) {
      ensureTag.run(t.key, t.display);
      const tr = getTag.get(t.key);
      insDT.run(id, tr.id, t.source);
    }
    db2.prepare("UPDATE docs SET title=?, mtime_ms=?, size=?, hash=?, headings_json=?, links_json=?, word_count=?, indexed_at=? WHERE id=?").run(
      rec.parsed.title ?? null,
      rec.mtimeMs,
      rec.size,
      rec.hash,
      JSON.stringify(rec.parsed.headings),
      JSON.stringify(rec.parsed.links),
      rec.parsed.wordCount,
      now,
      id
    );
    db2.prepare("DELETE FROM fts WHERE doc_id=?").run(id);
    db2.prepare("INSERT INTO fts(title, headings, tags_text, body, path, doc_id) VALUES(?,?,?,?,?,?)").run(
      rec.parsed.title ?? "",
      rec.parsed.headings.map((h) => h.text).join(" "),
      tagSet.map((t) => t.key).join(" "),
      rec.parsed.body,
      rec.root + "/" + rec.rel,
      id
    );
    db2.prepare("DELETE FROM doc_bigrams WHERE doc_id=?").run(id);
    const gramSrc = (rec.parsed.title ?? "") + "\n" + rec.parsed.headings.map((h) => h.text).join("\n") + "\n" + rec.parsed.body;
    const grams = [...extractBigrams(gramSrc)];
    if (grams.length) {
      const insG = db2.prepare("INSERT OR IGNORE INTO doc_bigrams(doc_id, gram) VALUES(?,?)");
      for (const g of grams) insG.run(id, g);
    }
    db2.exec("COMMIT");
    return id;
  } catch (e) {
    try {
      db2.exec("ROLLBACK");
    } catch {
    }
    throw e;
  }
}
function markMissingDeleted(db2, seenKeys) {
  const rows = db2.prepare("SELECT id, root, relpath FROM docs WHERE deleted=0").all();
  const del = db2.prepare("UPDATE docs SET deleted=1 WHERE id=?");
  const delFts = db2.prepare("DELETE FROM fts WHERE doc_id=?");
  let n = 0;
  for (const r of rows) {
    if (!seenKeys.has(docKey(r.root, r.relpath))) {
      del.run(r.id);
      delFts.run(r.id);
      n++;
    }
  }
  return n;
}
function purgeExpired(db2, beforeMs) {
  const rows = db2.prepare("SELECT id FROM docs WHERE deleted=1 AND indexed_at < ?").all(beforeMs);
  for (const r of rows) {
    db2.prepare("DELETE FROM doc_tags WHERE doc_id=?").run(r.id);
    db2.prepare("DELETE FROM doc_links WHERE from_id=? OR to_id=?").run(r.id, r.id);
    db2.prepare("DELETE FROM doc_sessions WHERE doc_id=?").run(r.id);
    db2.prepare("DELETE FROM fts WHERE doc_id=?").run(r.id);
    db2.prepare("DELETE FROM docs WHERE id=?").run(r.id);
  }
  return rows.length;
}
function markOneDeleted(db2, root, rel) {
  const r = db2.prepare("SELECT id FROM docs WHERE root=? AND relpath=? AND deleted=0").get(root, rel);
  if (!r) return false;
  db2.prepare("UPDATE docs SET deleted=1 WHERE id=?").run(r.id);
  db2.prepare("DELETE FROM fts WHERE doc_id=?").run(r.id);
  return true;
}
function resolveLink(lk, docRoot, docRel, byKey, roots) {
  const t = lk.target.replace(/\\/g, "/");
  if (t.startsWith("/") || t.startsWith("~")) {
    const abs = resolveAbs(t, roots);
    return abs ? byKey.get(docKey(abs.root, abs.rel)) ?? 0 : 0;
  }
  const tryCands = (tt) => {
    for (const c of linkCandidates(tt, docRel)) {
      const id2 = byKey.get(docKey(docRoot, c));
      if (id2) return id2;
    }
    return 0;
  };
  let id = tryCands(t);
  if (!id && !/\.(md|markdown)$/i.test(t)) id = tryCands(t + ".md");
  return id;
}
function rebuildAllLinks(db2, roots) {
  const docs = db2.prepare("SELECT id, root, relpath, links_json FROM docs WHERE deleted=0").all();
  const byKey = /* @__PURE__ */ new Map();
  for (const d of docs) byKey.set(docKey(d.root, d.relpath), d.id);
  db2.exec("DELETE FROM doc_links");
  const ins = db2.prepare("INSERT OR REPLACE INTO doc_links(from_id, to_id, weight) VALUES(?,?,?)");
  const counts = /* @__PURE__ */ new Map();
  let dangling = 0;
  for (const d of docs) {
    let links = [];
    try {
      links = JSON.parse(d.links_json || "[]");
    } catch {
    }
    for (const lk of links) {
      const toId = resolveLink(lk, d.root, d.relpath, byKey, roots);
      if (!toId) {
        dangling++;
        continue;
      }
      if (toId === d.id) continue;
      const k = d.id + KEYSEP + toId;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of counts) {
    const parts = k.split(KEYSEP);
    ins.run(Number(parts[0]), Number(parts[1]), Math.min(n, 5));
  }
  return { edges: counts.size, dangling };
}
function computeRank(db2) {
  const ids = db2.prepare("SELECT id FROM docs WHERE deleted=0").all().map((r2) => r2.id);
  const N = ids.length;
  if (!N) return;
  const idx = new Map(ids.map((id, i) => [id, i]));
  const out = new Float64Array(N);
  const edges = [];
  for (const e of db2.prepare("SELECT from_id, to_id, weight FROM doc_links").all()) {
    const f = idx.get(e.from_id);
    const t = idx.get(e.to_id);
    if (f === void 0 || t === void 0) continue;
    edges.push({ f, t, w: e.weight });
    out[f] += e.weight;
  }
  const d = 0.85;
  let r = new Float64Array(N).fill(1 / N);
  const base = (1 - d) / N;
  for (let it = 0; it < 30; it++) {
    let danglingMass = 0;
    for (let i = 0; i < N; i++) if (out[i] === 0) danglingMass += r[i];
    const nr = new Float64Array(N).fill(base + d * danglingMass / N);
    for (const e of edges) nr[e.t] += d * r[e.f] * e.w / out[e.f];
    let diff = 0;
    for (let i = 0; i < N; i++) diff += Math.abs(nr[i] - r[i]);
    r = nr;
    if (diff < 1e-7) break;
  }
  let max = 0;
  for (const v of r) if (v > max) max = v;
  const setR = db2.prepare("UPDATE docs SET rank=?, rank_norm=? WHERE id=?");
  db2.exec("BEGIN");
  for (let i = 0; i < N; i++) setR.run(r[i], max > 0 ? r[i] / max : 0, ids[i]);
  db2.exec("COMMIT");
}
const { dbPath, cfg } = workerData;
mkdirSync(dbPath.replace(/\/[^/]+$/, ""), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL;");
db.exec("PRAGMA synchronous=NORMAL;");
db.exec("PRAGMA busy_timeout=5000");
initSchema(db);
const excludes = new Set(cfg.excludes);
const scan = { running: false, done: 0, total: 0, current: "", changed: 0, lastAt: 0, lastError: "" };
let scanSeq = 0;
let graphTimer = null;
const post = (msg) => {
  try {
    parentPort.postMessage(msg);
  } catch {
  }
};
const log = (msg) => post({ type: "log", msg });
function scanLockAcquire() {
  const row = db.prepare("SELECT value FROM meta WHERE key='scan_lock'").get();
  if (row) {
    const parts = String(row.value).split(":");
    const pid = Number(parts[0]);
    if (pid !== process.pid && Date.now() - Number(parts[1]) < 12e4) {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
      }
    }
  }
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('scan_lock', ?)").run(process.pid + ":" + Date.now());
  return true;
}
function scanLockRelease() {
  try {
    db.prepare("DELETE FROM meta WHERE key='scan_lock' AND value LIKE ?").run(process.pid + ":%");
  } catch {
  }
}
function reindexOne(root, rel) {
  const abs = root + "/" + rel;
  if (!existsSync(abs)) {
    if (markOneDeleted(db, root, rel)) scheduleGraph();
    return;
  }
  try {
    const st = statSync(abs);
    let text = readFileSync(abs, "utf8");
    let headOnly = false;
    if (st.size > cfg.maxFileKB * 1024) {
      text = text.slice(0, 4096);
      headOnly = true;
    }
    const parsed = parseMarkdown(text);
    if (headOnly) {
      parsed.body = "";
      parsed.wordCount = 0;
      parsed.inlineTags = [];
      parsed.links = [];
      parsed.headings = [];
    }
    upsertDoc(db, { root, rel, mtimeMs: Math.round(st.mtimeMs), size: st.size, hash: contentHash(text), parsed, pathTags: derivePathTags(rel) });
    drainPending();
    post({ type: "doc-updated", root, rel });
    scheduleGraph();
  } catch (e) {
    scan.lastError = rel + ": " + String(e?.message ?? e);
  }
}
function scheduleGraph() {
  clearTimeout(graphTimer);
  graphTimer = setTimeout(() => {
    try {
      const r = rebuildAllLinks(db, cfg.roots);
      computeRank(db);
      post({ type: "graph-updated", edges: r.edges });
    } catch {
    }
  }, 3e3);
}
async function scanAll(fullOpt) {
  let full = fullOpt;
  if (scan.running) {
    post({ type: "scan-skipped", reason: "in progress" });
    return;
  }
  if (!scanLockAcquire()) {
    post({ type: "scan-skipped", reason: "another instance scanning" });
    return;
  }
  scan.running = true;
  scan.done = 0;
  scan.total = 0;
  scan.changed = 0;
  scan.current = "";
  scan.lastError = "";
  const seq = ++scanSeq;
  const t0 = Date.now();
  try {
    const lv = db.prepare("SELECT value FROM meta WHERE key='tag_logic_version'").get();
    if (lv?.value !== TAG_LOGIC_VERSION) {
      full = true;
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('tag_logic_version', ?)").run(TAG_LOGIC_VERSION);
    }
    const iv = db.prepare("SELECT value FROM meta WHERE key='index_logic_version'").get();
    if (iv?.value !== INDEX_LOGIC_VERSION) {
      full = true;
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('index_logic_version', ?)").run(INDEX_LOGIC_VERSION);
    }
    const files = [];
    for (const root of cfg.roots) {
      for (const f of walkFiles(root, excludes)) files.push({ ...f, root });
    }
    scan.total = files.length;
    post({ type: "scan-start", total: scan.total, full });
    const map = compareMap(db);
    const seen = /* @__PURE__ */ new Set();
    for (const f of files) {
      if (seq !== scanSeq) {
        post({ type: "scan-aborted" });
        return;
      }
      const key = f.root + "\0" + f.rel;
      seen.add(key);
      const prev = map.get(key);
      if (!full && prev && !prev.deleted && prev.mtimeMs === f.mtimeMs && prev.size === f.size) {
        scan.done++;
        continue;
      }
      scan.current = f.rel;
      try {
        let text = readFileSync(f.abs, "utf8");
        if (f.size > cfg.maxFileKB * 1024) {
          text = text.slice(0, 4096);
          const parsed = parseMarkdown(text);
          parsed.body = "";
          parsed.wordCount = 0;
          parsed.inlineTags = [];
          parsed.links = [];
          parsed.headings = [];
          upsertDoc(db, { root: f.root, rel: f.rel, mtimeMs: f.mtimeMs, size: f.size, hash: contentHash(text), parsed, pathTags: derivePathTags(f.rel) });
        } else {
          upsertDoc(db, {
            root: f.root,
            rel: f.rel,
            mtimeMs: f.mtimeMs,
            size: f.size,
            hash: contentHash(text),
            parsed: parseMarkdown(text),
            pathTags: derivePathTags(f.rel)
          });
        }
        scan.changed++;
      } catch (e) {
        scan.lastError = f.rel + ": " + String(e?.message ?? e);
      }
      scan.done++;
      if (scan.done % 25 === 0) post({ type: "scan-progress", done: scan.done, total: scan.total, current: scan.current });
    }
    const deleted = markMissingDeleted(db, seen);
    purgeExpired(db, Date.now() - 30 * 864e5);
    const drained = drainPending();
    const links = rebuildAllLinks(db, cfg.roots);
    computeRank(db);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
    }
    scan.lastAt = Date.now();
    if (full) {
      setTimeout(() => {
        try {
          db.exec("VACUUM;");
          post({ type: "log", msg: "VACUUM 完成" });
        } catch {
        }
      }, 3e4);
    }
    post({ type: "scan-done", total: scan.total, changed: scan.changed, deleted, drained, edges: links.edges, dangling: links.dangling, ms: scan.lastAt - t0 });
  } catch (e) {
    scan.lastError = String(e?.message ?? e);
    post({ type: "log", msg: "scanAll: " + scan.lastError });
  } finally {
    scan.running = false;
    scanLockRelease();
  }
}
const SESSION_UPSERT = `INSERT INTO doc_sessions(doc_id, session_id, first_op, last_op, op_count) VALUES(?,?,?,?,?)
  ON CONFLICT(doc_id, session_id) DO UPDATE SET
    first_op=MIN(COALESCE(first_op, excluded.first_op), excluded.first_op),
    last_op=MAX(COALESCE(last_op, 0), excluded.last_op),
    op_count=excluded.op_count`;
function applySessionOps(sid, rows) {
  let touched = 0;
  const byDoc = /* @__PURE__ */ new Map();
  const pendings = /* @__PURE__ */ new Map();
  for (const r of rows ?? []) {
    for (const st of r?.stores ?? []) {
      const storeRoot = typeof st?.root === "string" ? st.root.replace(/\/+$/, "") : "";
      if (!storeRoot) continue;
      for (const p of st?.paths ?? []) {
        let mapped = null;
        for (const scanRoot of cfg.roots) {
          const sr = scanRoot.replace(/\/+$/, "");
          let rel;
          if (storeRoot === sr) rel = String(p);
          else if (storeRoot.startsWith(sr + "/")) rel = storeRoot.slice(sr.length + 1) + "/" + p;
          else continue;
          mapped = { sr, rel };
          break;
        }
        if (!mapped) continue;
        const d = db.prepare("SELECT id FROM docs WHERE root=? AND relpath=?").get(mapped.sr, mapped.rel);
        const t0 = Number(r.t0) || 0, t1 = Number(r.t1) || 0;
        if (d) {
          const cur = byDoc.get(d.id) ?? { first: t0, last: t1, count: 0 };
          cur.first = Math.min(cur.first || t0, t0);
          cur.last = Math.max(cur.last, t1);
          cur.count++;
          byDoc.set(d.id, cur);
        } else {
          const k = mapped.sr + "\0" + mapped.rel;
          const cur = pendings.get(k) ?? { sr: mapped.sr, rel: mapped.rel, first: t0, last: t1, count: 0 };
          cur.first = Math.min(cur.first || t0, t0);
          cur.last = Math.max(cur.last, t1);
          cur.count++;
          pendings.set(k, cur);
        }
      }
    }
  }
  if (!byDoc.size && !pendings.size) return 0;
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM doc_sessions WHERE session_id=?").run(sid);
    for (const [docId, v] of byDoc) {
      db.prepare(SESSION_UPSERT).run(docId, sid, v.first, v.last, v.count);
    }
    for (const v of pendings.values()) {
      db.prepare(`INSERT INTO pending_session_docs(root, path, sid, first_op, last_op, op_count) VALUES(?,?,?,?,?,?)
        ON CONFLICT(root, path, sid) DO UPDATE SET
          first_op=MIN(COALESCE(first_op, excluded.first_op), excluded.first_op),
          last_op=MAX(COALESCE(last_op, 0), excluded.last_op),
          op_count=excluded.op_count`).run(v.sr, v.rel, sid, v.first, v.last, v.count);
    }
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
    }
    throw e;
  }
  touched = byDoc.size;
  if (pendings.size) drainPending();
  scheduleGraph();
  return touched;
}
function drainPending() {
  const rows = db.prepare(`SELECT p.rowid rid, d.id doc_id, p.sid, p.first_op, p.last_op, p.op_count
    FROM pending_session_docs p JOIN docs d ON d.root=p.root AND d.relpath=p.path AND d.deleted=0`).all();
  if (!rows.length) return 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      db.prepare(SESSION_UPSERT).run(r.doc_id, r.sid, r.first_op, r.last_op, r.op_count);
      db.prepare("DELETE FROM pending_session_docs WHERE rowid=?").run(r.rid);
    }
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
    }
    throw e;
  }
  return rows.length;
}
parentPort.on("message", (m) => {
  try {
    if (m?.cmd === "scan") void scanAll(!!m.full);
    else if (m?.cmd === "reindex" && typeof m.root === "string" && typeof m.rel === "string") reindexOne(m.root, m.rel);
    else if (m?.cmd === "session-ops" && typeof m.sid === "string") {
      const n = applySessionOps(m.sid, Array.isArray(m.rows) ? m.rows : []);
      if (n) post({ type: "session-ops-done", sid: m.sid, docs: n });
    } else if (m?.cmd === "abort") scanSeq++;
  } catch (e) {
    log("message handler: " + String(e?.message ?? e));
  }
});
post({ type: "ready" });
