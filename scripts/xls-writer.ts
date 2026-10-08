// Writes Excel 97-2003 .xls workbooks (BIFF8, MS-XLS) for benchmark evidence:
// a Compound File Binary container holding one Workbook stream. Covers what
// case spreadsheets need: several sheets, text, numbers and dates, the
// "#,##0.00" amount format, solid cell fills from the default palette, a bold
// font and column widths. No formulas: totals are stored as values.

import CFB from "cfb";

/** A solid cell fill, by its colour in Excel's default palette: yellow #FFFF00, grey #C0C0C0, tan #FFCC99. */
export type XlsFill = "yellow" | "grey" | "tan";

/**
 * One cell: a string or number as is, or an object for a date (ISO
 * yyyy-mm-dd), an amount shown as #,##0.00, a fill or bold text. null leaves
 * the cell empty.
 */
export type XlsCell =
  | null
  | string
  | number
  | { text?: string; number?: number; date?: string; format?: "amount"; fill?: XlsFill; bold?: boolean };

export interface XlsSheet {
  name: string;
  /** Column widths in characters, from column A. */
  widths?: number[];
  /** Rows from row 1; each row's cells from column A. */
  rows: XlsCell[][];
}

/** A workbook as stored in a case's xls-sources/<name>.json. */
export interface XlsSource {
  sheets: XlsSheet[];
}

/** Indices in the default BIFF8 palette (MS-XLS 2.5.161). */
const PALETTE_INDEX: Record<XlsFill, number> = { yellow: 0x0d, grey: 0x16, tan: 0x2f };
/** Built-in number format 4 is "#,##0.00"; custom formats start at 164. */
const FMT_AMOUNT = 4;
const FMT_DATE = 164;
const DATE_FORMAT = "yyyy-mm-dd";
/** Days from Excel's 1900 date system epoch (1899-12-30, leap-year bug included) to 1970-01-01. */
const EXCEL_EPOCH_DAYS = 25569;
/** Excel needs the Workbook stream outside the ministream, so at least 4096 bytes. */
const MIN_STREAM = 4096;

const record = (type: number, body: Buffer) => {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(body.length, 2);
  return Buffer.concat([header, body]);
};
const u16 = (...values: number[]) => {
  const b = Buffer.alloc(2 * values.length);
  values.forEach((v, i) => b.writeUInt16LE(v, 2 * i));
  return b;
};
/** XLUnicodeString: 16-bit length, flags (UTF-16), characters. */
const unicodeString = (s: string) => Buffer.concat([u16(s.length), Buffer.from([1]), Buffer.from(s, "utf16le")]);
/** ShortXLUnicodeString: 8-bit length, flags (UTF-16), characters. */
const shortString = (s: string) => Buffer.concat([Buffer.from([s.length, 1]), Buffer.from(s, "utf16le")]);

function bof(dt: number) {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(0x0600, 0); // BIFF8
  b.writeUInt16LE(dt, 2); // 0x0005 workbook globals, 0x0010 worksheet
  b.writeUInt16LE(0x0dbb, 4); // build
  b.writeUInt16LE(0x07cc, 6); // year
  b.writeUInt32LE(0x000100c1, 8); // file history flags
  b.writeUInt32LE(0x00000006, 12); // lowest BIFF version
  return record(0x0809, b);
}

function font(bold: boolean) {
  const b = Buffer.alloc(14);
  b.writeUInt16LE(200, 0); // 10 pt, in twips
  b.writeUInt16LE(0, 2);
  b.writeUInt16LE(0x7fff, 4); // automatic colour
  b.writeUInt16LE(bold ? 700 : 400, 6);
  return record(0x0031, Buffer.concat([b, shortString("Arial")]));
}

/** An XF record (MS-XLS 2.4.353): a style XF, or a cell XF with a format, font and fill. */
function xf({ style, fmt = 0, font = 0, fill }: { style: boolean; fmt?: number; font?: number; fill?: number }) {
  const b = Buffer.alloc(20);
  b.writeUInt16LE(font, 0);
  b.writeUInt16LE(fmt, 2);
  // Locked; style XFs have the style flag and parent 0xFFF, cell XFs parent 0 (Normal).
  b.writeUInt16LE(style ? 0xfff5 : 0x0001, 4);
  b[6] = 0x20; // bottom-aligned
  // For a cell XF, the attributes it sets itself rather than inherit: number format, font, fill.
  b[9] = style ? 0 : 0x04 | 0x08 | (fill === undefined ? 0 : 0x40);
  // Fill pattern (bits 26-31): 1 is solid.
  b.writeUInt32LE(fill === undefined ? 0 : 1 << 26, 14);
  // Pattern colours: foreground (the fill) and background; 64 and 65 are the system defaults.
  b.writeUInt16LE((fill ?? 0x40) | (0x41 << 7), 18);
  return record(0x00e0, b);
}

function dateSerial(iso: string): number {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(ms)) throw new Error(`invalid date "${iso}"`);
  return ms / 86_400_000 + EXCEL_EPOCH_DAYS;
}

const columnName = (col: number) => {
  let name = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

/** Builds the .xls file for a workbook. Output is deterministic. */
export function buildXls(source: XlsSource): Buffer {
  if (source.sheets.length === 0) throw new Error("a workbook needs at least one sheet");

  // Cell XFs, one per distinct (format, font, fill); 0-14 are style XFs and 15 the default cell XF.
  const cellXfs: { fmt: number; font: number; fill?: number }[] = [];
  const xfIndex = (fmt: number, font: number, fill?: number) => {
    let i = cellXfs.findIndex((x) => x.fmt === fmt && x.font === font && x.fill === fill);
    if (i < 0) i = cellXfs.push({ fmt, font, fill }) - 1;
    return 16 + i;
  };

  const sheetStreams = source.sheets.map((sheet, sheetNo) => {
    if (sheet.name.length === 0 || sheet.name.length > 31 || /[[\]:*?/\\]/.test(sheet.name)) {
      throw new Error(`invalid sheet name "${sheet.name}"`);
    }
    const cells: Buffer[] = [];
    let lastCol = 0;
    sheet.rows.forEach((row, r) => {
      row.forEach((cell, c) => {
        if (cell === null) return;
        const where = `${sheet.name}!${columnName(c)}${r + 1}`;
        const spec = typeof cell === "object" ? cell : typeof cell === "number" ? { number: cell } : { text: cell };
        const kinds = [spec.text, spec.number, spec.date].filter((v) => v !== undefined).length;
        if (kinds !== 1) throw new Error(`${where}: a cell holds exactly one of text, number or date`);
        const fmt = spec.date !== undefined ? FMT_DATE : spec.format === "amount" ? FMT_AMOUNT : 0;
        // Font index 4 doesn't exist in BIFF8: the second font written is index 1.
        const ixfe = xfIndex(fmt, spec.bold ? 1 : 0, spec.fill === undefined ? undefined : PALETTE_INDEX[spec.fill]);
        const head = u16(r, c, ixfe);
        if (spec.text !== undefined) {
          cells.push(record(0x0204, Buffer.concat([head, unicodeString(spec.text)]))); // LABEL
        } else {
          const value = Buffer.alloc(8);
          value.writeDoubleLE(spec.number ?? dateSerial(spec.date!), 0);
          cells.push(record(0x0203, Buffer.concat([head, value]))); // NUMBER
        }
        lastCol = Math.max(lastCol, c);
      });
    });

    const dimensions = Buffer.alloc(14);
    dimensions.writeUInt32LE(0, 0);
    dimensions.writeUInt32LE(sheet.rows.length, 4); // last row + 1
    dimensions.writeUInt16LE(0, 8);
    dimensions.writeUInt16LE(lastCol + 1, 10);
    const widths = (sheet.widths ?? []).map((w, c) => record(0x007d, u16(c, c, Math.round(w * 256), 15, 0, 0))); // COLINFO
    // WINDOW2: gridlines, headers, zeros, outline symbols; the first sheet is selected and shown.
    const window2 = record(0x023e, Buffer.concat([u16(sheetNo === 0 ? 0x06b6 : 0x00b6, 0, 0, 0x40, 0, 0, 0), Buffer.alloc(4)]));
    return Buffer.concat([bof(0x0010), ...widths, record(0x0200, dimensions), ...cells, window2, record(0x000a, Buffer.alloc(0))]);
  });

  const formats = [record(0x041e, Buffer.concat([u16(FMT_DATE), unicodeString(DATE_FORMAT)]))];
  const window1 = record(0x003d, u16(0, 0, 0x4000, 0x2000, 0x0038, 0, 0, 1, 600));
  const xfs = [
    xf({ style: true }),
    ...Array.from({ length: 14 }, () => xf({ style: true })),
    xf({ style: false }),
    ...cellXfs.map((x) => xf({ style: false, ...x })),
  ];
  const style = record(0x0293, Buffer.from([0x00, 0x80, 0x00, 0xff])); // Normal, built in, on XF 0
  const globalsHead = Buffer.concat([
    bof(0x0005),
    record(0x0042, u16(1200)), // CODEPAGE: UTF-16
    window1,
    record(0x0022, u16(0)), // DATEMODE: 1900 date system
    font(false),
    font(true),
    ...formats,
    ...xfs,
    style,
  ]);
  // BOUNDSHEET records point at each sheet's BOF, so their size fixes where the sheets start.
  const boundsheets = source.sheets.map((sheet) => Buffer.concat([Buffer.alloc(4), u16(0), shortString(sheet.name)]));
  const eof = record(0x000a, Buffer.alloc(0));
  let offset = globalsHead.length + boundsheets.reduce((n, b) => n + 4 + b.length, 0) + eof.length;
  for (const [i, body] of boundsheets.entries()) {
    body.writeUInt32LE(offset, 0);
    offset += sheetStreams[i]!.length;
  }
  let workbook = Buffer.concat([globalsHead, ...boundsheets.map((b) => record(0x0085, b)), eof, ...sheetStreams]);
  if (workbook.length < MIN_STREAM) workbook = Buffer.concat([workbook, Buffer.alloc(MIN_STREAM - workbook.length)]);

  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, "/Workbook", workbook);
  return Buffer.from(CFB.write(cfb, { type: "buffer" }) as Uint8Array);
}
