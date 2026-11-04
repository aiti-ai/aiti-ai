/**
 * P2-1（lineage-closure）：plan-sandbox 引擎「拷贝 + 内容哈希校验」收编。
 *
 * 权威源 = pi-ext/plan-sandbox/（本目录 providers/ops/fsview/mission 为其拷贝部署）。
 * 本测试把两份内容哈希对齐（已登记的双向差异除外）——引擎任何一边改动而未同步，
 * 此处立即 fail，杜绝 ~2000 行级双实现的静默漂移。新差异须双向同步或登记进 KNOWN_DIFFS。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = (...p) => join(fileURLToPath(new URL(".", import.meta.url)), ...p);
const AUTHORITY = here("../../../pi-ext/plan-sandbox/");
const FILES = ["providers.ts", "ops.ts", "fsview.ts", "mission.ts", "accept-core.ts"];

/** 权威源/拷贝之间的已登记差异（正则 → 替换），除此之外任何字节差 = 漂移 fail。 */
const KNOWN_DIFFS = {
  // pi-ext 侧为 e2e 测试补了导出；web 拷贝内不需要（仅本扩展消费）
  "providers.ts": { auth: [[/^export class LinuxProvider/m, "class LinuxProvider"]], copy: [] },
  // 拷贝头部的拷贝部署声明（仅拷贝有）
  "mission.ts": { auth: [], copy: [[/^ \* \[拷贝部署\][^\n]*\n/m, ""]] },
  "accept-core.ts": { auth: [], copy: [[/^ \* \[拷贝部署\][^\n]*\n/m, ""]] },
};

for (const f of FILES) {
  test(`引擎拷贝与权威源一致：${f}`, () => {
    let auth = readFileSync(join(AUTHORITY, f), "utf8");
    let copy = readFileSync(here(f), "utf8");
    for (const [re, to] of KNOWN_DIFFS[f]?.auth ?? []) auth = auth.replace(re, to);
    for (const [re, to] of KNOWN_DIFFS[f]?.copy ?? []) copy = copy.replace(re, to);
    assert.equal(
      auth,
      copy,
      `${f} 与权威源 pi-ext/plan-sandbox/${f} 存在未登记漂移——引擎改动须双向同步，或把差异登记进 KNOWN_DIFFS`,
    );
  });
}
