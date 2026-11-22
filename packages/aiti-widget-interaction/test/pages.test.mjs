import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Our HTML pages must not use top-level await in their module script: the macOS 11
 * WKWebView silently skips such a script (the window renders, the page never connects).
 * Everything asynchronous goes inside an exported/async function instead.
 */
const PAGES = ["../page/interaction.html", "../page/custom-example.html"];

for (const relative of PAGES) {
  test(`${relative}: module script avoids top-level await`, () => {
    const html = readFileSync(new URL(relative, import.meta.url), "utf8");
    const match = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(match, "module script present");
    const body = match[1];
    // Top-level statements sit at column 0 in these files; indented awaits are inside functions.
    assert.ok(!/^await\s/m.test(body), "no bare top-level await");
    assert.ok(!/^(?:const|let|var)\b[^\n]*=\s*await\b/m.test(body), "no top-level `= await`");
  });
}
