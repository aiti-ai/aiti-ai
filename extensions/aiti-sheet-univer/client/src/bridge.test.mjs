/**
 * bridge tests — exceljs ⇄ Univer 转换桥往返（fixtures 钉行为）。
 *
 * Run: node --test pi-web-ext/aiti-sheet-univer/client/src/bridge.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ExcelJS = require("../../node_modules/exceljs"); // dist CJS

const {
  toUniverSnapshot,
  fromUniverSnapshot,
  argbToHex,
  hexToArgb,
  dateToSerial,
  a1ToRange,
  sanitizeNumFmt,
} = await import("./bridge.ts");

/** 构造带样式的 fixture 工作簿 */
async function buildFixture() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "fixture";
  const ws = wb.addWorksheet("数据", { views: [{ state: "frozen", xSplit: 1, ySplit: 1 }] });
  // 表头（加粗 + 底色 + 居中 + 边框）
  ws.getCell("A1").value = "名称";
  ws.getCell("A1").font = { bold: true, size: 12, name: "Arial", color: { argb: "FFFFFFFF" } };
  ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
  ws.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
  ws.getCell("A1").border = { top: { style: "thin", color: { argb: "FF000000" } }, bottom: { style: "double", color: { argb: "FF111111" } } };
  ws.getCell("B1").value = "数量";
  ws.getCell("B1").font = { bold: true };
  // 数据行
  ws.getCell("A2").value = "苹果";
  ws.getCell("B2").value = 3.5;
  ws.getCell("B2").numFmt = "0.00%";
  ws.getCell("A3").value = true;
  ws.getCell("B3").value = { formula: "B2*2", result: 7 };
  const d = new Date(Date.UTC(2026, 8, 6));
  ws.getCell("A4").value = d;
  ws.getCell("A4").numFmt = "yyyy-mm-dd";
  // 合并 A5:B5
  ws.getCell("A5").value = "合并单元格";
  ws.mergeCells("A5:B5");
  // 列宽/行高
  ws.getColumn(1).width = 20;
  ws.getColumn(2).width = 12.5;
  ws.getRow(2).height = 30;
  // 隐藏 sheet + tab 色 + 公式引用
  const ws2 = wb.addWorksheet("配置", { state: "hidden", properties: { tabColor: { argb: "FFFF0000" } } });
  ws2.getCell("A1").value = "阈值";
  ws2.getCell("A2").value = 100;
  ws.getCell("B5").value = { formula: "B2+配置!A2", result: 103.5 };
  const buf = await wb.xlsx.writeBuffer();
  return { buf };
}

async function loadFixture() {
  const { buf } = await buildFixture();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

test("颜色/序列号/A1 工具函数", () => {
  assert.equal(argbToHex("FF4472C4"), "#4472c4");
  assert.equal(argbToHex("004472C4"), null); // 全透明
  assert.equal(argbToHex("4472C4"), "#4472c4");
  assert.equal(hexToArgb("#4472c4"), "FF4472C4");
  assert.equal(dateToSerial(new Date(Date.UTC(2026, 8, 6))), 46271);
  assert.deepEqual(a1ToRange("A5:B5"), { startRow: 4, startColumn: 0, endRow: 4, endColumn: 1 });
  assert.deepEqual(a1ToRange("C2"), { startRow: 1, startColumn: 2, endRow: 1, endColumn: 2 });
});

test("toUniverSnapshot：值/公式/样式/合并/冻结/列宽行高/隐藏 sheet", async () => {
  const wb = await loadFixture();
  const { snapshot, warnings } = toUniverSnapshot(wb, { fileName: "t.xlsx" });
  assert.equal(snapshot.name, "t.xlsx");
  assert.deepEqual(snapshot.sheetOrder, ["sheet-1", "sheet-2"]);
  const ws1 = snapshot.sheets["sheet-1"];
  assert.equal(ws1.name, "数据");
  // 表头样式
  const head = ws1.cellData[0][0];
  assert.equal(head.v, "名称");
  const st = snapshot.styles[head.s];
  assert.equal(st.bl, 1);
  assert.equal(st.fs, 12);
  assert.equal(st.ff, "Arial");
  assert.equal(st.cl.rgb, "#ffffff");
  assert.equal(st.bg.rgb, "#4472c4");
  assert.equal(st.ht, 2); // center
  assert.equal(st.vt, 2); // middle
  assert.equal(st.bd.t.s, 1); // thin
  assert.equal(st.bd.b.s, 7); // double
  // 公式
  const b3 = ws1.cellData[2][1];
  assert.equal(b3.f, "B2*2");
  assert.equal(b3.v, 7);
  // 百分比 numFmt
  const b2 = ws1.cellData[1][1];
  assert.equal(snapshot.styles[b2.s].n.pattern, "0.00%");
  // 日期 → 序列号 + numFmt
  const a4 = ws1.cellData[3][0];
  assert.equal(a4.v, 46271);
  assert.equal(snapshot.styles[a4.s].n.pattern, "yyyy-mm-dd");
  // 合并
  assert.deepEqual(ws1.merges, [{ startRow: 4, startColumn: 0, endRow: 4, endColumn: 1 }]);
  // 冻结
  assert.deepEqual(ws1.freeze, { xSplit: 1, ySplit: 1, startRow: 1, startColumn: 1 });
  // 列宽（字符 → px）：20*7+5=145；12.5*7+5≈93
  assert.equal(ws1.columnData[0].w.v, 145);
  assert.equal(ws1.columnData[1].w.v, 93);
  // 行高（pt → px）：30/0.75=40
  assert.equal(ws1.rowData[1].h.v, 40);
  // 隐藏 sheet
  const ws2 = snapshot.sheets["sheet-2"];
  assert.equal(ws2.hidden, 1);
  assert.equal(ws2.tabColor, "#ff0000");
  // 无警告（fixture 无富文本/超链接等）
  assert.deepEqual(warnings, []);
});

test("fromUniverSnapshot → Excel 可读：往返保持值/公式/合并/冻结/样式", async () => {
  const wb = await loadFixture();
  const { snapshot } = toUniverSnapshot(wb, { fileName: "t.xlsx" });
  const wb2 = fromUniverSnapshot(ExcelJS, snapshot);
  const buf2 = await wb2.xlsx.writeBuffer();
  const wb3 = new ExcelJS.Workbook();
  await wb3.xlsx.load(buf2);

  // sheet 顺序与隐藏
  assert.deepEqual(wb3.worksheets.map((w) => w.name), ["数据", "配置"]);
  const ws1 = wb3.getWorksheet("数据");
  const ws2 = wb3.getWorksheet("配置");
  assert.equal(ws2.state, "hidden");
  // 值
  assert.equal(ws1.getCell("A1").value, "名称");
  assert.equal(ws1.getCell("A2").value, "苹果");
  assert.equal(ws1.getCell("B2").value, 3.5);
  assert.equal(ws1.getCell("A3").value, true);
  // 公式
  assert.equal(ws1.getCell("B3").value.formula, "B2*2");
  assert.equal(ws1.getCell("B3").value.result, 7);
  // 跨 sheet 公式
  assert.equal(ws1.getCell("B5").value.formula, "B2+配置!A2");
  // 样式往返
  assert.equal(ws1.getCell("A1").font.bold, true);
  assert.equal(ws1.getCell("A1").font.size, 12);
  assert.equal(ws1.getCell("A1").font.name, "Arial");
  assert.equal(ws1.getCell("A1").fill.fgColor.argb, "FF4472C4");
  assert.equal(ws1.getCell("A1").alignment.horizontal, "center");
  assert.equal(ws1.getCell("A1").border.top.style.toLowerCase(), "thin"); // exceljs 读回线型大写
  assert.equal(ws1.getCell("A1").border.bottom.style.toLowerCase(), "double");
  // numFmt
  assert.equal(ws1.getCell("B2").numFmt, "0.00%");
  // 日期格式（写序列号 + 格式；exceljs 读回按格式还原 Date——Excel 渲染等价）
  assert.equal(ws1.getCell("A4").numFmt, "yyyy-mm-dd");
  assert.equal(new Date(ws1.getCell("A4").value).toISOString(), "2026-09-06T00:00:00.000Z");
  // 合并
  const merges = ws1.model.merges.map(String).sort();
  assert.deepEqual(merges, ["A5:B5"]);
  // 冻结
  assert.equal(ws1.views[0].state, "frozen");
  assert.equal(ws1.views[0].xSplit, 1);
  assert.equal(ws1.views[0].ySplit, 1);
  // 列宽行高（往返近似：字符→px→字符）
  assert.ok(Math.abs(ws1.getColumn(1).width - 20) < 1.5, "col width round-trip, got " + ws1.getColumn(1).width);
  assert.ok(Math.abs(ws1.getRow(2).height - 30) < 2, "row height round-trip, got " + ws1.getRow(2).height);
});

test("编辑场景：Univer snapshot 改值后重建 → 改动落盘", async () => {
  const wb = await loadFixture();
  const { snapshot } = toUniverSnapshot(wb, { fileName: "t.xlsx" });
  // 模拟 Univer 编辑：B2 改 5.5、A6 新增文本
  snapshot.sheets["sheet-1"].cellData[1][1].v = 5.5;
  snapshot.sheets["sheet-1"].cellData[5] = { 0: { v: "新行" } };
  const wb2 = fromUniverSnapshot(ExcelJS, snapshot);
  const buf2 = await wb2.xlsx.writeBuffer();
  const wb3 = new ExcelJS.Workbook();
  await wb3.xlsx.load(buf2);
  const ws1 = wb3.getWorksheet("数据");
  assert.equal(ws1.getCell("B2").value, 5.5);
  assert.equal(ws1.getCell("A6").value, "新行");
  assert.equal(ws1.getCell("A2").value, "苹果"); // 其余未动
});

test("明示剥离：富文本并纯文本 + 截断警告", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("S");
  ws.getCell("A1").value = { richText: [{ font: { bold: true }, text: "粗" }, { text: "细" }] };
  ws.getCell("A2").value = { text: "链接", hyperlink: "https://example.com" };
  const { snapshot, warnings } = toUniverSnapshot(wb, { fileName: "w.xlsx" });
  assert.equal(snapshot.sheets["sheet-1"].cellData[0][0].v, "粗细");
  assert.equal(snapshot.sheets["sheet-1"].cellData[1][0].v, "链接");
  assert.ok(warnings.some((w) => w.includes("富文本")));
  assert.ok(warnings.some((w) => w.includes("超链接")));
});

test("sanitizeNumFmt：剥离 ODF value() 条件（soffice 产物 → Univer 不再报 ODS 告警）", () => {
  assert.equal(sanitizeNumFmt("[<=0]-0;value()>0"), "[<=0]-0"); // 剥空的条件段整段删除
  assert.equal(sanitizeNumFmt("0.0%;value()>0"), "0.0%");
  assert.equal(sanitizeNumFmt("value() > 100"), "General");
  // 正常格式不受影响
  assert.equal(sanitizeNumFmt("0.00%"), "0.00%");
  assert.equal(sanitizeNumFmt("yyyy-mm-dd"), "yyyy-mm-dd");
  // Excel 合法条件格式保留
  assert.equal(sanitizeNumFmt("[Red][>100]0.00"), "[Red][>100]0.00");
});

test("空工作簿/空 sheet 安全", async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("空");
  const { snapshot } = toUniverSnapshot(wb, { fileName: "e.xlsx" });
  assert.equal(Object.keys(snapshot.sheets).length, 1);
  const wb2 = fromUniverSnapshot(ExcelJS, snapshot);
  const buf2 = await wb2.xlsx.writeBuffer();
  assert.ok(buf2.byteLength > 0);
  const wb3 = new ExcelJS.Workbook();
  await wb3.xlsx.load(buf2);
  assert.equal(wb3.getWorksheet("空").name, "空");
});
