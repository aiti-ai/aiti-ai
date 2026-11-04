/**
 * 台账（§3.6）：<dataDir>/aiti-git-trace/state/ops/<sessionId>.jsonl
 *
 * 原子追加采用 tmp+rename 整文件重写（方案 §3.6 明确约定；M0 量级下成本可忽略）。
 * 读取容忍末行半写（崩溃残留）——解析失败的行仅在文件末尾时被忽略。
 * 台账是 op 编号恢复（§4）、UI/回撤预览的权威数据源。
 */
import fs from "node:fs";
import path from "node:path";
import type { LedgerRow } from "./types.ts";

/** tmp+rename 原子写 */
function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** 追加一行台账（幂等由调用方保证；串行调用） */
export function appendRow(file: string, row: LedgerRow): void {
  let prev = "";
  try {
    prev = fs.readFileSync(file, "utf8");
  } catch {
    /* first row */
  }
  atomicWrite(file, prev + JSON.stringify(row) + "\n");
}

/** 读全部台账行；解析失败的行忽略（仅末行半写场景；中间损坏行跳过并继续） */
export function readRows(file: string): LedgerRow[] {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows: LedgerRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (typeof obj?.op === "number") rows.push(obj as LedgerRow);
    } catch {
      /* 半写/损坏行：跳过 */
    }
  }
  return rows;
}

/** op 编号恢复（§4）：台账末行 op；无台账返回 0 */
export function recoverLastOp(file: string): number {
  const rows = readRows(file);
  let last = 0;
  for (const r of rows) if (typeof r.op === "number" && r.op > last) last = r.op;
  return last;
}
