/**
 * host-tools-allow · G1 allowlist pure-logic unit tests (docs/pi-web-ext-host-tools-gate-plan.md §G1)
 * Run: node scripts/test-web-ext.mjs --only host-tools-allow
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHostToolsAllow, filterHostToolsByAllow, hostToolAllowed, HOST_TOOLS_READONLY_NAMES,
} from "./host-tools-allow.ts";

const TOOLS = [
  { name: "aiti_inbox" }, { name: "page_snapshot" }, { name: "bridge_status" },
  { name: "page_exec" }, { name: "form_fill" },
];

test("parse: empty/readonly->read-only subset; */all->everything; list->exact set; bad input falls back to readonly", () => {
  assert.equal(parseHostToolsAllow(null), "readonly");
  assert.equal(parseHostToolsAllow(""), "readonly");
  assert.equal(parseHostToolsAllow("  readonly "), "readonly");
  assert.equal(parseHostToolsAllow("*"), "all");
  assert.equal(parseHostToolsAllow("all"), "all");
  const custom = parseHostToolsAllow("aiti_inbox, page_exec;; page_logs");
  assert.ok(custom instanceof Set);
  assert.deepEqual([...custom].sort(), ["aiti_inbox", "page_exec", "page_logs"]);
  assert.equal(parseHostToolsAllow("  ,  ;; "), "readonly"); // separators only -> fall back to the default
});

test("filter: the read-only subset excludes write-class (page_exec/form_fill); everything passes as-is; list is exact", () => {
  const ro = filterHostToolsByAllow(TOOLS, "readonly").map((t) => t.name);
  assert.deepEqual(ro.sort(), ["aiti_inbox", "bridge_status", "page_snapshot"]);
  for (const n of HOST_TOOLS_READONLY_NAMES) {
    if (["page_exec", "form_fill"].includes(n)) throw new Error("write-class tools must not enter the read-only subset: " + n);
  }
  assert.equal(filterHostToolsByAllow(TOOLS, "all").length, TOOLS.length);
  const custom = filterHostToolsByAllow(TOOLS, new Set(["page_exec"]));
  assert.deepEqual(custom.map((t) => t.name), ["page_exec"]);
});

test("hostToolAllowed: single-tool decision (attach forwarding-check semantics)", () => {
  assert.equal(hostToolAllowed("aiti_inbox", "readonly"), true);
  assert.equal(hostToolAllowed("page_exec", "readonly"), false);
  assert.equal(hostToolAllowed("form_fill", "readonly"), false);
  assert.equal(hostToolAllowed("page_exec", "all"), true);
  assert.equal(hostToolAllowed("page_exec", new Set(["page_exec"])), true);
  assert.equal(hostToolAllowed("aiti_inbox", new Set(["page_exec"])), false);
});
