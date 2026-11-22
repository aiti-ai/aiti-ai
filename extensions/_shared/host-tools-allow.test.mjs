/**
 * host-tools-allow · G1 白名单纯逻辑单测（docs/pi-web-ext-host-tools-gate-plan.md §G1）
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

test("parse：空/readonly→只读子集；*/all→全量；清单→精确集合；坏输入回退只读", () => {
  assert.equal(parseHostToolsAllow(null), "readonly");
  assert.equal(parseHostToolsAllow(""), "readonly");
  assert.equal(parseHostToolsAllow("  readonly "), "readonly");
  assert.equal(parseHostToolsAllow("*"), "all");
  assert.equal(parseHostToolsAllow("all"), "all");
  const custom = parseHostToolsAllow("aiti_inbox, page_exec;; page_logs");
  assert.ok(custom instanceof Set);
  assert.deepEqual([...custom].sort(), ["aiti_inbox", "page_exec", "page_logs"]);
  assert.equal(parseHostToolsAllow("  ,  ;; "), "readonly"); // 全分隔符 → 回退缺省
});

test("filter：只读子集排除写类（page_exec/form_fill）；全量原样；清单精确", () => {
  const ro = filterHostToolsByAllow(TOOLS, "readonly").map((t) => t.name);
  assert.deepEqual(ro.sort(), ["aiti_inbox", "bridge_status", "page_snapshot"]);
  for (const n of HOST_TOOLS_READONLY_NAMES) {
    if (["page_exec", "form_fill"].includes(n)) throw new Error("写类不应进只读子集: " + n);
  }
  assert.equal(filterHostToolsByAllow(TOOLS, "all").length, TOOLS.length);
  const custom = filterHostToolsByAllow(TOOLS, new Set(["page_exec"]));
  assert.deepEqual(custom.map((t) => t.name), ["page_exec"]);
});

test("hostToolAllowed：单工具判定（attach 转发校验语义）", () => {
  assert.equal(hostToolAllowed("aiti_inbox", "readonly"), true);
  assert.equal(hostToolAllowed("page_exec", "readonly"), false);
  assert.equal(hostToolAllowed("form_fill", "readonly"), false);
  assert.equal(hostToolAllowed("page_exec", "all"), true);
  assert.equal(hostToolAllowed("page_exec", new Set(["page_exec"])), true);
  assert.equal(hostToolAllowed("aiti_inbox", new Set(["page_exec"])), false);
});
