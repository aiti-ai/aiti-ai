import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../app/api/files/[...path]/route.ts", import.meta.url), "utf8");

test("provides a debounced file search UI and opens selected results", () => {
  assert.match(source, /searchQuery/);
  // POST body shape: cwd stays out of the URL (safe for access logs), apiUrl adds the basePath
  assert.match(source, /apiUrl\("\/api\/file-index"\)/);
  assert.match(source, /JSON\.stringify\(\{ cwd, q: query \}\)/);
  assert.match(source, /setTimeout\(\(\) =>/);
  assert.match(source, /onOpenFile\(node\.fullPath, node\.name\)/);
});

test("renders search results with the existing expandable file tree", () => {
  assert.match(source, /buildSearchTree/);
  assert.match(source, /searchRoots\.map/);
  assert.match(source, /<TreeNode/);
  assert.match(source, /expandedPaths=\{searchExpanded\}/);
});

test("search result rows offer mention and download actions like the file tree", () => {
  assert.match(source, /onAtMention\(getRelativeFilePath\(node\.fullPath, cwd\), node\.isDir\)/);
  assert.match(source, /<MentionIcon \/>/);
  // Downloads were upgraded from the direct ?type=download link to two-step ticketed downloads
  // (POST /api/files/ticket → GET /api/files/_t/<ticket>); search result rows and the file tree
  // both go through downloadViaTicket. Assert the action wiring here plus that the ticket
  // mechanism itself is still in place.
  assert.match(source, /downloadViaTicket\(node\.fullPath\)/);
  assert.match(source, /\/api\/files\/ticket/);
  assert.match(source, /\/api\/files\/_t\/\$\{encodeURIComponent\(data\.ticket\)\}/);
});

test("keeps search on the bounded index and reports request failures", () => {
  assert.match(source, /setSearchError\(true\)/);
  assert.match(source, /role="alert"/);
  assert.doesNotMatch(apiSource, /type === "search"|searchFiles/);
});
