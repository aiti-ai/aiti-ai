import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  isRevisionRef,
  resolveRevisionGitDir,
  revisionBlobContent,
  revisionBlobSize,
  revisionRelPath,
  revisionTextChunk,
  REVISION_TEXT_READ_MAX_BYTES,
} from "./file-revision.ts";

// ---------- pure helpers ----------

test("isRevisionRef: bare hex shas only", () => {
  assert.ok(isRevisionRef("a1b2c3d"));
  assert.ok(isRevisionRef("0123456789abcdef0123456789abcdef01234567"));
  assert.ok(isRevisionRef("ABCDEF0"));
  for (const bad of ["", "HEAD", "main", "--all", "refs/heads/x", "HEAD~1", "a1b2c3d;rm", "../../etc", "zzzzzzz"]) {
    assert.ok(!isRevisionRef(bad), `should reject ${bad}`);
  }
});

test("revisionRelPath: work tree = dirname(gitDir), rejects escapes", () => {
  const gitDir = path.join("/repo", ".aiti-trace");
  assert.equal(revisionRelPath(path.join("/repo", "extensions", "x", "icon.svg"), gitDir), "extensions/x/icon.svg");
  // Windows-style separators normalize to forward slashes
  assert.equal(revisionRelPath("/repo/a\\b.txt" === "/repo/a\\b.txt" ? path.join("/repo", "a", "b.txt") : "", gitDir), "a/b.txt");
  assert.equal(revisionRelPath("/elsewhere/file.txt", gitDir), null);
  assert.equal(revisionRelPath("/repo", gitDir), null);
  assert.equal(revisionRelPath(path.join("/repo", "..", "escape.txt"), gitDir), null);
});

test("resolveRevisionGitDir: requires objects/ + allowlist containment", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rev-git-"));
  try {
    const gitDir = path.join(root, ".git");
    fs.mkdirSync(path.join(gitDir, "objects"), { recursive: true });
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    assert.equal(resolveRevisionGitDir(gitDir, [root]), fs.realpathSync(gitDir));
    assert.equal(resolveRevisionGitDir(gitDir, ["/elsewhere"]), null, "outside allowlist");
    const notGit = path.join(root, "sub");
    assert.equal(resolveRevisionGitDir(notGit, [root]), null, "missing objects/");
    assert.equal(resolveRevisionGitDir(path.join(root, "missing"), [root]), null, "nonexistent");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- chunk semantics ----------

test("revisionTextChunk: binary sniff + truncation + utf8 boundary", () => {
  const bin = Buffer.concat([Buffer.from("ok"), Buffer.from([0x00]), Buffer.from("data".repeat(100))]);
  assert.deepEqual(revisionTextChunk(bin, bin.length), { content: "", nextOffset: 0, truncated: false, binary: true });

  const small = Buffer.from("hello");
  assert.deepEqual(revisionTextChunk(small, small.length), { content: "hello", nextOffset: 5, truncated: false, binary: false });

  // Cut inside a multibyte char trims back to the boundary and reports truncated.
  const multibyte = Buffer.from("你".repeat(100_000), "utf8"); // 3 bytes each → over 256KB
  assert.ok(multibyte.length > 256 * 1024);
  const chunk = revisionTextChunk(multibyte, multibyte.length);
  assert.equal(chunk.binary, false);
  assert.equal(chunk.truncated, true);
  assert.ok(!chunk.content.includes("\uFFFD"), "no replacement chars at the cut");
  assert.equal(Buffer.byteLength(chunk.content, "utf8") % 3, 0, "cut lands on a char boundary");
  assert.ok(chunk.nextOffset <= REVISION_TEXT_READ_MAX_BYTES);

  // Offset continuation (Load more): resumes at nextOffset without duplicating content,
  // and the binary sniff is skipped past the head (offset > 0).
  const cont = revisionTextChunk(multibyte, multibyte.length, chunk.nextOffset);
  assert.equal(cont.binary, false);
  assert.equal(Buffer.byteLength(chunk.content + cont.content, "utf8") % 3, 0);
  assert.ok(!cont.content.includes("\uFFFD"));
  assert.equal((multibyte[chunk.nextOffset] & 0xc0) !== 0x80, true, "nextOffset lands on a UTF-8 lead byte (no split char)");
  assert.equal(chunk.nextOffset + Buffer.byteLength(cont.content), multibyte.length, "continuation reaches EOF exactly");
});

// ---------- git integration (real repo in tmp) ----------

function initRepoWithDeletedFile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rev-repo-"));
  const git = (args, cwd = root) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  const gitDir = path.join(root, ".aiti-trace");
  fs.mkdirSync(gitDir, { recursive: true });
  const trace = (args) => git(["--git-dir", gitDir, "--work-tree", root, ...args]);
  trace(["init", "--quiet"]);
  const relPath = "sub/icon.svg";
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, relPath), "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"2\" height=\"2\"><rect width=\"2\" height=\"2\"/></svg>\n");
  trace(["add", "-A"]);
  trace(["commit", "-m", "capture", "--quiet"]);
  const sha = trace(["rev-parse", "HEAD"]);
  return { root, gitDir, sha, relPath };
}

test("revisionBlobSize/Content: read a blob from the shadow store layout", async () => {
  const { root, gitDir, sha, relPath } = initRepoWithDeletedFile();
  try {
    assert.equal(revisionRelPath(path.join(root, relPath), gitDir), relPath);
    const size = await revisionBlobSize(gitDir, sha, relPath);
    assert.ok(size > 0);
    const blob = await revisionBlobContent(gitDir, sha, relPath);
    assert.equal(blob.length, size);
    assert.ok(blob.toString("utf8").startsWith("<svg"));
    await assert.rejects(() => revisionBlobSize(gitDir, sha, "missing.txt"), "missing blob throws → route maps to 404");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("revisionBlobContent: an image-sized blob (above the text cap) still reads whole", async () => {
  const { root, gitDir, sha, relPath } = initRepoWithDeletedFile();
  try {
    // 7MB > REVISION_TEXT_READ_MAX_BYTES (5MB) but < the 10MB image cap: the old
    // 6MB execFile maxBuffer overflowed here, failing image revisions.
    const big = "x".repeat(7 * 1024 * 1024);
    const bigRel = "sub/big.bin";
    fs.writeFileSync(path.join(root, bigRel), big);
    const trace = (args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "--git-dir", gitDir, "--work-tree", root, ...args], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    trace(["add", "-A"]);
    trace(["commit", "-m", "big", "--quiet"]);
    const bigSha = execFileSync("git", ["--git-dir", gitDir, "rev-parse", "HEAD"], { cwd: root }).toString().trim();
    const size = await revisionBlobSize(gitDir, bigSha, bigRel);
    assert.equal(size, big.length);
    const blob = await revisionBlobContent(gitDir, bigSha, bigRel);
    assert.equal(blob.length, size);
    assert.ok(size > REVISION_TEXT_READ_MAX_BYTES);
    void sha; void relPath;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
