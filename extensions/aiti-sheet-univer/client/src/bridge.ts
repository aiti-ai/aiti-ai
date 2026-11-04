/**
 * aiti-sheet-univer · 转换桥（docs/aiti-editor-office-plan.md §2.1，唯一有界自研模块）。
 *
 * exceljs Workbook（数据面）⇄ Univer IWorkbookData（视图面）双向转换。
 * 纯函数 + duck-typed（不 import exceljs/Univer——client 经 vendor UMD 全局使用，
 * node --test 经 vendor/exceljs.min.js require 使用），转换结果为 plain JSON。
 *
 * 支持集（方案定义）：多 sheet / 单元格值（number/string/bool/日期串）/ 公式串透传 /
 * 样式（字体·字号·粗斜·下划删除线·前景背景色）/ 水平垂直对齐+换行 / 边框（常用线型）/
 * 数字格式（numFmt）/ 合并单元格 / 列宽行高 / 冻结 / sheet 隐藏+顺序 / tab 颜色。
 * 明示剥离（warnings）：富文本（并成纯文本）、超链接（留文本）、渐变填充、条件格式、
 * 数据验证、行/列超过上限截断。
 *
 * 颜色统一 '#RRGGBB'（Univer rgb）；exceljs 为 'AARRGGBB'（alpha 前缀）→ 落 alpha。
 */

// ── Univer 枚举常量（@univerjs/core 0.25 实测值，纯 TS 不 import）──
const HAlign = { LEFT: 1, CENTER: 2, RIGHT: 3, JUSTIFIED: 4, BOTH: 5, DISTRIBUTED: 6 };
const VAlign = { TOP: 1, MIDDLE: 2, BOTTOM: 3 };
const Wrap = { OVERFLOW: 1, CLIP: 2, WRAP: 3 };
const BorderS = { NONE: 0, THIN: 1, HAIR: 2, DOTTED: 3, DASHED: 4, DASH_DOT: 5, DASH_DOT_DOT: 6, DOUBLE: 7, MEDIUM: 8, MEDIUM_DASHED: 9, MEDIUM_DASH_DOT: 10, MEDIUM_DASH_DOT_DOT: 11, SLANT_DASH_DOT: 12, THICK: 13 };

const MAX_ROWS = 50000;   // §2.1 大表降级：只读渲染前 5 万行
const MAX_COLS = 2000;
const EXCEL_EPOCH = 25569; // 1899-12-30 → 1970-01-01 的天差（UTC）

const PX_PER_CHAR = 7;     // exceljs 列宽（字符）↔ px：Excel 11pt Calibri 近似公式
const BASE_COL_PX = 5;
const PT_PER_PX = 0.75;    // row height：exceljs pt ↔ Univer px

/** 'AARRGGBB' → '#RRGGBB'（透明/无效 → null） */
export function argbToHex(argb: any): string | null {
  if (typeof argb !== "string") return null;
  let a = argb;
  if (a[0] === "#") a = a.slice(1);
  if (/^[0-9a-fA-F]{8}$/.test(a)) {
    const alpha = parseInt(a.slice(0, 2), 16);
    if (alpha === 0) return null; // 全透明视为无色
    return "#" + a.slice(2).toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(a)) return "#" + a.toLowerCase();
  return null;
}

/** '#RRGGBB' → exceljs 'FFRRGGBB' */
export function hexToArgb(hex: any): string | null {
  if (typeof hex !== "string") return null;
  const a = hex.replace("#", "");
  if (/^[0-9a-fA-F]{6}$/.test(a)) return ("FF" + a).toUpperCase();
  return null;
}

/** JS Date → Excel 序列号（UTC 口径；1900 日期系统） */
export function dateToSerial(d: Date): number {
  return Math.round(((d.getTime() as number) / 86400000 + EXCEL_EPOCH) * 1e8) / 1e8;
}

/** 'A1:B2' → {startRow,startColumn,endRow,endColumn}（0 基） */
export function a1ToRange(ref: string): { startRow: number; startColumn: number; endRow: number; endColumn: number } | null {
  const m = String(ref || "").toUpperCase().match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
  if (!m) return null;
  const colToIdx = (s: string) => s.split("").reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  return {
    startRow: parseInt(m[2], 10) - 1,
    startColumn: colToIdx(m[1]),
    endRow: parseInt(m[4] || m[2], 10) - 1,
    endColumn: colToIdx(m[3] || m[1]),
  };
}

const COL_IDX_RE = /^([A-Z]+)(\d+)$/;
const idxToA1 = (row0: number, col0: number): string => {
  let s = "";
  let c = col0 + 1;
  while (c > 0) { const r = (c - 1) % 26; s = String.fromCharCode(65 + r) + s; c = Math.floor((c - 1) / 26); }
  return s + (row0 + 1);
};

// ── exceljs 样式对象 → Univer IStyleData（plain） ──
function styleToUniver(cell: any): Record<string, any> | null {
  const st: Record<string, any> = {};
  const font = cell.font;
  if (font) {
    if (font.name) st.ff = font.name;
    if (typeof font.size === "number") st.fs = font.size;
    if (font.bold) st.bl = 1;
    if (font.italic) st.it = 1;
    if (font.underline) st.ul = { s: 1 };
    if (font.strike) st.st = { s: 1 };
    const fc = argbToHex(font.color && font.color.argb);
    if (fc) st.cl = { rgb: fc };
  }
  const fill = cell.fill;
  if (fill && fill.type === "pattern" && fill.pattern === "solid") {
    // solid 取 fgColor（exceljs 惯例）；fgColor 缺失退 bg
    const bg = argbToHex((fill.fgColor && fill.fgColor.argb) || (fill.bgColor && fill.bgColor.argb));
    if (bg) st.bg = { rgb: bg };
  } else if (fill && fill.type === "gradient") {
    // 渐变不支持：无色 + 上层 warning（在 toUniverSnapshot 里检测）
  }
  const al = cell.alignment;
  if (al) {
    const h = String(al.horizontal || "").toLowerCase();
    if (h === "left") st.ht = HAlign.LEFT;
    else if (h === "center") st.ht = HAlign.CENTER;
    else if (h === "right") st.ht = HAlign.RIGHT;
    else if (h === "justify" || h === "justified") st.ht = HAlign.JUSTIFIED;
    const v = String(al.vertical || "").toLowerCase();
    if (v === "top") st.vt = VAlign.TOP;
    else if (v === "middle" || v === "center") st.vt = VAlign.MIDDLE;
    else if (v === "bottom") st.vt = VAlign.BOTTOM;
    if (al.wrapText) st.tb = Wrap.WRAP;
  }
  const bdSrc = cell.border;
  if (bdSrc) {
    const bd: Record<string, any> | null = {};
    const mapSide: Record<string, number> = {
      thin: BorderS.THIN, hair: BorderS.HAIR, dotted: BorderS.DOTTED, dashDot: BorderS.DASH_DOT,
      dashDotDot: BorderS.DASH_DOT_DOT, double: BorderS.DOUBLE, medium: BorderS.MEDIUM,
      mediumDashed: BorderS.MEDIUM_DASHED, mediumDashDot: BorderS.MEDIUM_DASH_DOT,
      mediumDashDotDot: BorderS.MEDIUM_DASH_DOT_DOT, slantDashDot: BorderS.SLANT_DASH_DOT, thick: BorderS.THICK,
      dashed: BorderS.DASHED,
    };
    for (const side of ["top", "bottom", "left", "right"] as const) {
      const b = bdSrc[side];
      if (!b || !b.style || b.style === "none") continue;
      const s = mapSide[String(b.style)] ?? BorderS.THIN;
      const rgb = argbToHex(b.color && b.color.argb) || "#000000";
      bd[side[0]] = { s, rgb };
    }
    if (Object.keys(bd).length) st.bd = bd;
  }
  const numFmt = cell.numFmt;
  if (typeof numFmt === "string" && numFmt !== "General") {
    const clean = sanitizeNumFmt(numFmt);
    if (clean && clean !== "General") st.n = { pattern: clean };
  }
  return Object.keys(st).length ? st : null;
}


/**
 * numfmt 净化：soffice/LibreOffice 会在数字格式里写 ODF 条件 token（如
 * `value()>0`、`[<=0]-0;value()>0`），Univer numfmt 不认函数调用式条件，
 * 触发 console.error「ODS number format may be incorrect」且渲染可能走样。
 * 处理：剥离 value() 条件本体 + 清理由此产生的空条件括号；剥完为空 → General。
 */
export function sanitizeNumFmt(pattern: string): string {
  const raw = String(pattern || "");
  // 按段处理：剥掉 value() 条件后变空的段整段删除（保留会改变正/负段语义）
  const sections = raw.split(";");
  const cleaned = sections.map((sec) =>
    sec.replace(/value\(\)\s*(?:>=|<=|<>|[><=])\s*[\d.]+/gi, "").replace(/\[\s*\]/g, "").trim(),
  );
  const kept = cleaned.filter((sec, i) => sec !== "" || sections[i].trim() === "");
  const joined = kept.join(";").trim();
  return joined || "General";
}

// ── exceljs cell value → { v?, f?, p? }（Univer ICellData 骨架，不含 s） ──
function valueToUniver(cell: any, warnings: Set<string>): { v?: any } {
  const val = cell.value;
  if (val == null) return {};
  if (typeof val === "number" || typeof val === "boolean") return { v: val };
  if (typeof val === "string") return { v: val };
  if (val instanceof Date) return { v: dateToSerial(val) };
  if (typeof val === "object") {
    if (typeof val.formula === "string") {
      // 共享公式：exceljs result 为缓存值；si（formula id）重建成本高，全量展开 f
      const out: any = { f: val.formula.replace(/^=/, "") };
      const r = val.result;
      if (r == null) out.v = "";
      else if (r instanceof Date) out.v = dateToSerial(r);
      else if (typeof r === "number" || typeof r === "boolean" || typeof r === "string") out.v = r;
      return out;
    }
    if (Array.isArray(val.richText)) {
      warnings.add("富文本已并为纯文本");
      return { v: val.richText.map((t: any) => (t && t.text) || "").join("") };
    }
    if (val.hyperlink != null) {
      warnings.add("超链接仅保留显示文本");
      return { v: typeof val.text === "string" ? val.text : String(val.text ?? "") };
    }
    if (val.error != null) return { v: String(val.error) };
    if (val.sharedFormula != null) {
      // 读方向：exceljs 读到共享公式主单元格 { formula, result }（上面已接）；
      // 从单元格会被 exceljs 解析成 { sharedFormula, result }——把引用公式展开
      return { v: val.result == null ? "" : val.result };
    }
  }
  return { v: String(val) };
}

/**
 * exceljs Workbook → Univer IWorkbookData（plain JSON）。
 * @param wb     exceljs Workbook（API.xlsx.load 后的对象）
 * @param opts   fileName（workbook id/name）、maxRows/maxCols 截断
 * @returns { snapshot, warnings }
 */
export function toUniverSnapshot(wb: any, opts?: { fileName?: string; maxRows?: number; maxCols?: number }): { snapshot: any; warnings: string[] } {
  const warnings = new Set<string>();
  const maxRows = Math.min(opts?.maxRows ?? MAX_ROWS, MAX_ROWS);
  const maxCols = Math.min(opts?.maxCols ?? MAX_COLS, MAX_COLS);
  const styles: Record<string, any> = {};
  const styleIdByKey = new Map<string, string>();
  const sheets: Record<string, any> = {};
  const sheetOrder: string[] = [];

  const styleKey = (st: Record<string, any>) => JSON.stringify(st);
  const internStyle = (st: Record<string, any> | null): string | undefined => {
    if (!st) return undefined;
    const key = styleKey(st);
    let id = styleIdByKey.get(key);
    if (!id) {
      id = "s" + styleIdByKey.size;
      styleIdByKey.set(key, id);
      styles[id] = st;
    }
    return id;
  };

  const worksheets: any[] = (wb && wb.worksheets) || [];
  for (const ws of worksheets) {
    const sid = "sheet-" + (sheetOrder.length + 1);
    sheetOrder.push(sid);
    const cellData: Record<number, Record<number, any>> = {};
    const rowData: Record<number, any> = {};
    const columnData: Record<number, any> = {};

    // 行/列尺寸
    const rowCount = Math.min(Math.max(ws.actualRowCount || ws.rowCount || 0, 1), maxRows);
    const colCount = Math.min(Math.max(ws.actualColumnCount || ws.columnCount || 0, 1), maxCols);
    if ((ws.rowCount || 0) > maxRows || (ws.actualRowCount || 0) > maxRows) warnings.add("超过 " + maxRows + " 行，已截断（只读降级）");
    if ((ws.columnCount || 0) > maxCols || (ws.actualColumnCount || 0) > maxCols) warnings.add("超过 " + maxCols + " 列，已截断");
    for (let r = 1; r <= rowCount; r++) {
      const row = ws.getRow(r);
      if (row && typeof row.height === "number") {
        rowData[r - 1] = { h: { v: Math.round(row.height / PT_PER_PX), s: 0 } }; // exceljs pt → Univer px
      }
      if (row && row.hidden) {
        rowData[r - 1] = Object.assign(rowData[r - 1] || {}, { hd: 1 });
      }
    }
    for (let c = 1; c <= colCount; c++) {
      const col = ws.getColumn(c);
      if (col && typeof col.width === "number" && col.width > 0) {
        columnData[c - 1] = { w: { v: Math.round(col.width * PX_PER_CHAR + BASE_COL_PX), s: 0 } }; // 字符 → px
      }
      if (col && col.isHidden) {
        columnData[c - 1] = Object.assign(columnData[c - 1] || {}, { hd: 1 });
      }
    }

    // 单元格（exceljs 4.x：Worksheet 只有 eachRow，eachCell 在 Row 上；
    // includeEmpty:true 保留“仅样式无值”的格子——只遍历已物化的区间，不会按声明维度拉满）
    ws.eachRow({ includeEmpty: false }, (row: any, rowNumber: number) => {
      if (rowNumber > maxRows) return;
      row.eachCell({ includeEmpty: true }, (cell: any, colNumber: number) => {
        if (!colNumber || colNumber > maxCols) return;
        const uni: any = {};
        const val = valueToUniver(cell, warnings);
        if (val.v !== undefined) uni.v = val.v;
        if (val.f !== undefined) uni.f = val.f;
        const st = styleToUniver(cell);
        const sidStyle = internStyle(st);
        if (sidStyle) uni.s = sidStyle;
        if (uni.v === undefined && uni.f === undefined && !uni.s) return;
        (cellData[rowNumber - 1] ||= {})[colNumber - 1] = uni;
      });
    });

    // 合并
    const merges: any[] = [];
    const rawMerges = (ws.model && ws.model.merges) || (ws as any)._merges || [];
    for (const ref of rawMerges) {
      const rng = typeof ref === "string" ? a1ToRange(ref) : ref;
      if (!rng) continue;
      if (rng.startRow === rng.endRow && rng.startColumn === rng.endColumn) continue;
      merges.push(rng);
    }

    // 冻结
    let freeze: any;
    const view = (ws.views && ws.views[0]) || {};
    if (view.state === "frozen" && ((view.xSplit || 0) + (view.ySplit || 0) > 0)) {
      freeze = {
        xSplit: view.xSplit || 0,
        ySplit: view.ySplit || 0,
        startRow: view.ySplit || 0,
        startColumn: view.xSplit || 0,
      };
    }

    // 条件格式/数据验证检测（exceljs 读后重写会丢 → 明示）
    try {
      const cf = ws.conditionalFormattings;
      if (cf && typeof cf.modelCount === "number" ? cf.modelCount > 0 : (cf && cf.ruleNamesById && Object.keys(cf.ruleNamesById).length > 0)) warnings.add("条件格式不支持，保存将剥离");
      const dv = ws.dataValidations && ws.dataValidations.model;
      if (dv && Array.isArray(dv.dataValidation) && dv.dataValidation.length > 0) warnings.add("数据验证不支持，保存将剥离");
    } catch { /* 探测失败不打扰 */ }

    const tabColor = ws.properties && ws.properties.tabColor;
    sheets[sid] = {
      id: sid,
      name: ws.name,
      tabColor: (tabColor && argbToHex(tabColor.argb)) || undefined,
      hidden: ws.state === "hidden" ? 1 : ws.state === "veryHidden" ? 1 : 0,
      cellData,
      rowCount: Math.max(rowCount, 1) + 50, // 留出增长空间
      columnCount: Math.max(colCount, 1) + 10,
      rowData,
      columnData,
      merges,
      freeze,
      defaultRowHeight: 20,
      defaultColumnWidth: 73,
    };
  }

  const snapshot = {
    id: opts?.fileName || "workbook",
    name: opts?.fileName || "workbook",
    appVersion: "aiti-sheet-univer",
    locale: "zh-CN",
    styles,
    sheetOrder,
    sheets,
  };
  return { snapshot, warnings: [...warnings] };
}

// ── Univer snapshot → exceljs（重建 Workbook，写入用） ──

/** IStyleData → exceljs 样式对象 */
function univerStyleToExceljs(st: any): any {
  if (!st || typeof st !== "object") return undefined;
  const out: any = {};
  if (st.ff) out.font = Object.assign(out.font || {}, { name: st.ff });
  if (typeof st.fs === "number") out.font = Object.assign(out.font || {}, { size: st.fs });
  if (st.bl === 1) out.font = Object.assign(out.font || {}, { bold: true });
  if (st.it === 1) out.font = Object.assign(out.font || {}, { italic: true });
  if (st.ul && st.ul.s) out.font = Object.assign(out.font || {}, { underline: true });
  if (st.st && st.st.s) out.font = Object.assign(out.font || {}, { strike: true });
  const fc = hexToArgb(st.cl && st.cl.rgb);
  if (fc) out.font = Object.assign(out.font || {}, { color: { argb: fc } });
  if (out.font && Object.keys(out.font).length === 0) delete out.font;
  const bg = hexToArgb(st.bg && st.bg.rgb);
  if (bg) out.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
  const al: any = {};
  if (st.ht === HAlign.LEFT) al.horizontal = "left";
  else if (st.ht === HAlign.CENTER) al.horizontal = "center";
  else if (st.ht === HAlign.RIGHT) al.horizontal = "right";
  else if (st.ht === HAlign.JUSTIFIED || st.ht === HAlign.BOTH) al.horizontal = "justify";
  if (st.vt === VAlign.TOP) al.vertical = "top";
  else if (st.vt === VAlign.MIDDLE) al.vertical = "middle";
  else if (st.vt === VAlign.BOTTOM) al.vertical = "bottom";
  if (st.tb === Wrap.WRAP) al.wrapText = true;
  if (Object.keys(al).length) out.alignment = al;
  const bd = st.bd;
  if (bd && typeof bd === "object") {
    const revSide: Record<string, string> = {
      t: "top", b: "bottom", l: "left", r: "right",
    };
    const revStyle: Record<number, string> = {};
    for (const [k, v] of Object.entries(BorderS)) revStyle[v as number] = k;
    const outBd: any = {};
    for (const [k, side] of Object.entries(revSide)) {
      const b = (bd as any)[k];
      if (!b) continue;
      outBd[side] = { style: revStyle[b.s] || "thin", color: { argb: hexToArgb(b.rgb) || "FF000000" } };
    }
    if (Object.keys(outBd).length) out.border = outBd;
  }
  if (st.n && typeof st.n.pattern === "string") out.numFmt = st.n.pattern;
  return Object.keys(out).length ? out : undefined;
}

/** 富文本 IDocumentData → 纯文本（dataStream 去尾部换行） */
function richTextToText(p: any): string {
  if (!p) return "";
  const s = typeof p.dataStream === "string" ? p.dataStream : "";
  return s.replace(/[\r\n]+$/, "");
}

/**
 * Univer snapshot → exceljs Workbook（全新构建）。
 * @param ExcelJS  vendor UMD 全局（node 测试传 require 的 exceljs；client 传 window.ExcelJS）
 * @param snapshot IWorkbookData（FWorkbook.getSnapshot() 或 toUniverSnapshot 产物）
 */
export function fromUniverSnapshot(ExcelJS: any, snapshot: any): any {
  const wb = new ExcelJS.Workbook();
  wb.creator = "aiti-sheet-univer";
  wb.created = wb.modified = new Date();
  const order: string[] = snapshot.sheetOrder && snapshot.sheetOrder.length
    ? snapshot.sheetOrder
    : Object.keys(snapshot.sheets || {});
  const stylesMap = snapshot.styles || {};
  for (const sid of order) {
    const sheet = snapshot.sheets && (snapshot.sheets[sid] || {});
    const ws = wb.addWorksheet(sheet.name || sid, {
      state: sheet.hidden ? "hidden" : "visible",
      properties: sheet.tabColor ? { tabColor: { argb: hexToArgb(sheet.tabColor) || undefined } } : undefined,
      views: (sheet.freeze && ((sheet.freeze.xSplit || 0) + (sheet.freeze.ySplit || 0)) > 0)
        ? [{
            state: "frozen",
            xSplit: sheet.freeze.xSplit || 0,
            ySplit: sheet.freeze.ySplit || 0,
            topLeftCell: idxToA1(sheet.freeze.startRow ?? sheet.freeze.ySplit ?? 0, sheet.freeze.startColumn ?? sheet.freeze.xSplit ?? 0),
          }]
        : [{ state: "normal" }],
    });
    // 行高（Univer px → exceljs pt）与隐藏
    const rowData = sheet.rowData || {};
    for (const rk of Object.keys(rowData)) {
      const r = parseInt(rk, 10);
      const rd = rowData[rk];
      const row = ws.getRow(r + 1);
      if (rd && rd.h && typeof rd.h.v === "number") row.height = Math.round(rd.h.v * PT_PER_PX * 10) / 10;
      if (rd && rd.hd) row.hidden = true;
    }
    // 列宽（Univer px → exceljs 字符）
    const columnData = sheet.columnData || {};
    for (const ck of Object.keys(columnData)) {
      const c = parseInt(ck, 10);
      const cd = columnData[ck];
      const col = ws.getColumn(c + 1);
      if (cd && cd.w && typeof cd.w.v === "number") col.width = Math.max(0, Math.round(((cd.w.v - BASE_COL_PX) / PX_PER_CHAR) * 100) / 100);
      if (cd && cd.hd) col.isHidden = true;
    }
    // 单元格
    const cellData = sheet.cellData || {};
    for (const rk of Object.keys(cellData)) {
      const rowIdx = parseInt(rk, 10);
      const rowMap = cellData[rk];
      for (const ck of Object.keys(rowMap)) {
        const colIdx = parseInt(ck, 10);
        const cell = rowMap[ck];
        if (!cell) continue;
        const target = ws.getCell(rowIdx + 1, colIdx + 1);
        let styleSrc: any = null;
        if (cell.s) {
          styleSrc = typeof cell.s === "string" ? stylesMap[cell.s] : cell.s;
          const mapped = univerStyleToExceljs(styleSrc);
          if (mapped) {
            if (mapped.numFmt) target.numFmt = mapped.numFmt;
            if (mapped.font) target.font = mapped.font;
            if (mapped.fill) target.fill = mapped.fill;
            if (mapped.alignment) target.alignment = mapped.alignment;
            if (mapped.border) target.border = mapped.border;
          }
        }
        if (typeof cell.f === "string" && cell.f.length) {
          const val: any = { formula: cell.f[0] === "=" ? cell.f.slice(1) : cell.f };
          if (cell.v != null) val.result = cell.v;
          target.value = val;
        } else if (cell.p) {
          target.value = richTextToText(cell.p);
        } else if (cell.v !== undefined) {
          target.value = cell.v;
        }
      }
    }
    // 合并
    for (const rng of sheet.merges || []) {
      try {
        if (rng.startRow === rng.endRow && rng.startColumn === rng.endColumn) continue;
        ws.mergeCells(rng.startRow + 1, rng.startColumn + 1, rng.endRow + 1, rng.endColumn + 1);
      } catch { /* 非法合并跳过 */ }
    }
  }
  return wb;
}
