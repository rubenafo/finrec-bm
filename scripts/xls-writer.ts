// Writes Excel 97-2003 .xls workbooks (BIFF8, MS-XLS) for benchmark evidence:
// a Compound File Binary container holding one Workbook stream. Covers what
// case spreadsheets need: several sheets, text, numbers and dates, the
// "#,##0.00" amount format, solid cell fills from the default palette, a bold
// font, column widths, simple formulas (numbers, cell references, + and -,
// SUM over cells and ranges) stored with their calculated result, and PNG
// pictures floating over a sheet, such as screenshots, each with a name.

import CFB from "cfb";
import { createHash } from "node:crypto";

/** A solid cell fill, by its colour in Excel's default palette: yellow #FFFF00, grey #C0C0C0, tan #FFCC99, green #CCFFCC. */
export type XlsFill = "yellow" | "grey" | "tan" | "green";

/**
 * One cell: a string or number as is, or an object for a date (ISO
 * yyyy-mm-dd), an amount shown as #,##0.00, a fill or bold text. A formula,
 * such as "SUM(F4:F8)" (no leading =), needs `number`: its calculated result,
 * which the file stores as Excel does. null leaves the cell empty.
 */
export type XlsCell =
  | null
  | string
  | number
  | { text?: string; number?: number; date?: string; formula?: string; format?: "amount"; fill?: XlsFill; bold?: boolean };

export interface XlsSheet {
  name: string;
  /** Column widths in characters, from column A. */
  widths?: number[];
  /** Rows from row 1; each row's cells from column A. */
  rows: XlsCell[][];
  /** Pictures over the sheet, in the order they are drawn. */
  pictures?: XlsPicture[];
}

/** A PNG picture placed over a sheet, as Insert > Pictures places one. */
export interface XlsPicture {
  /** The picture's name, as Excel's Name Box and Selection Pane show it. */
  name: string;
  /** Path of the PNG file, relative to the case folder, e.g. evidence/screenshot.png. */
  file: string;
  /** The cell its top-left corner is on, e.g. H3. */
  at: string;
  /** Shown at this share of its size in pixels; default 1. */
  scale?: number;
  /** Alternative text. */
  description?: string;
}

/** A workbook as stored in a case's xls-sources/<name>.json. */
export interface XlsSource {
  sheets: XlsSheet[];
}

/** Indices in the default BIFF8 palette (MS-XLS 2.5.161). */
const PALETTE_INDEX: Record<XlsFill, number> = { yellow: 0x0d, grey: 0x16, tan: 0x2f, green: 0x2a };
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

/** A cell reference as BIFF8 stores it (MS-XLS 2.5.198.88 RgceLoc): row, then column with both relative flags set, as Excel writes A1. */
function cellRef(ref: string, where: string): Buffer {
  const m = ref.match(/^([A-Z]{1,3})([1-9]\d*)$/);
  if (!m) throw new Error(`${where}: invalid cell reference "${ref}"`);
  const col = [...m[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return u16(Number(m[2]) - 1, col | 0xc000);
}

/**
 * Parses a formula into BIFF8 tokens (rgce, MS-XLS 2.5.198), in reverse Polish
 * order: numbers, cell references, + and -, and SUM over cells and ranges.
 */
function parseFormula(formula: string, where: string): Buffer {
  const tokens = formula.replace(/\s+/g, "").match(/SUM\(|[A-Z]{1,3}\d+:[A-Z]{1,3}\d+|[A-Z]{1,3}\d+|\d+(?:\.\d+)?|[+\-,)]/g) ?? [];
  if (tokens.join("") !== formula.replace(/\s+/g, "")) throw new Error(`${where}: unsupported formula "${formula}"`);
  let at = 0;
  const fail = (): never => {
    throw new Error(`${where}: unsupported formula "${formula}"`);
  };
  const operand = (): Buffer => {
    const t = tokens[at++] ?? fail();
    if (t === "SUM(") {
      const args: Buffer[] = [];
      do {
        const a = tokens[at++] ?? fail();
        if (a.includes(":")) {
          const [first, last] = a.split(":").map((r) => cellRef(r, where));
          args.push(Buffer.concat([Buffer.from([0x25]), first!.subarray(0, 2), last!.subarray(0, 2), first!.subarray(2), last!.subarray(2)])); // PtgArea
        } else if (/^[A-Z]/.test(a)) args.push(Buffer.concat([Buffer.from([0x24]), cellRef(a, where)])); // PtgRef
        else fail();
      } while (tokens[at] === "," && ++at);
      if (tokens[at++] !== ")") fail();
      return Buffer.concat([...args, Buffer.from([0x42, args.length]), u16(4)]); // PtgFuncVar, value class: SUM (function 4)
    }
    if (/^[A-Z]/.test(t)) return Buffer.concat([Buffer.from([0x44]), cellRef(t, where)]); // PtgRef, value class
    const n = Number(t);
    if (Number.isNaN(n)) fail();
    if (Number.isInteger(n) && n <= 0xffff) return Buffer.concat([Buffer.from([0x1e]), u16(n)]); // PtgInt
    const b = Buffer.alloc(9);
    b[0] = 0x1f; // PtgNum
    b.writeDoubleLE(n, 1);
    return b;
  };
  let out = operand();
  while (at < tokens.length) {
    const op = tokens[at++];
    if (op !== "+" && op !== "-") fail();
    out = Buffer.concat([out, operand(), Buffer.from([op === "+" ? 0x03 : 0x04])]); // PtgAdd, PtgSub
  }
  return out;
}

/** Most bytes in one record's body; longer data goes on in CONTINUE records. */
const MAX_RECORD = 8224;
/** Pixels at Excel's default sizes for a workbook in Arial 10: column width 8.43, row height 12.75 pt. */
const DEFAULT_COLUMN_PX = 64;
const ROW_PX = 17;

const u32 = (...values: number[]) => {
  const b = Buffer.alloc(4 * values.length);
  values.forEach((v, i) => b.writeUInt32LE(v >>> 0, 4 * i));
  return b;
};

/** An OfficeArt record (MS-ODRAW 2.1.1): version and instance, type, length, then its body. */
const art = (ver: number, inst: number, type: number, ...body: Buffer[]) => {
  const data = Buffer.concat(body);
  return Buffer.concat([u16(ver | (inst << 4), type), u32(data.length), data]);
};

/** A record whose body may be longer than MAX_RECORD: the rest goes in CONTINUE records. */
function longRecord(type: number, body: Buffer): Buffer {
  const parts = [record(type, body.subarray(0, MAX_RECORD))];
  for (let at = MAX_RECORD; at < body.length; at += MAX_RECORD) parts.push(record(0x003c, body.subarray(at, at + MAX_RECORD)));
  return Buffer.concat(parts);
}

/** A PNG's size in pixels, from its IHDR chunk. */
function pngSize(png: Buffer, where: string): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error(`${where}: not a PNG file`);
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** A sheet's pictures, with their image data loaded. */
interface PlacedPicture extends XlsPicture {
  png: Buffer;
  /** 1-based index of its image in the drawing group's BLIP store. */
  blip: number;
}

/**
 * The OfficeArtClientAnchorSheet (MS-XLS 2.5.193) of a picture shown at its
 * size in pixels from the top-left of cell `at`: the cells under its corners,
 * with offsets in 1/1024 of a column's width and 1/256 of a row's height.
 */
function anchor(picture: PlacedPicture, columnPx: (col: number) => number, where: string): Buffer {
  const m = picture.at.match(/^([A-Z]{1,3})([1-9]\d*)$/);
  if (!m) throw new Error(`${where}: invalid cell "${picture.at}"`);
  const col1 = [...m[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const row1 = Number(m[2]) - 1;
  const { width, height } = pngSize(picture.png, where);
  const scale = picture.scale ?? 1;
  let col2 = col1;
  let left = Math.round(width * scale);
  while (left >= columnPx(col2)) left -= columnPx(col2++);
  let row2 = row1;
  let down = Math.round(height * scale);
  while (down >= ROW_PX) {
    down -= ROW_PX;
    row2++;
  }
  return u16(0, col1, 0, row1, 0, col2, Math.floor((left * 1024) / columnPx(col2)), row2, Math.floor((down * 256) / ROW_PX));
}

/**
 * A sheet's drawing: MSODRAWING records holding its OfficeArtDgContainer
 * (MS-ODRAW 2.2.13), with an OBJ record (MS-XLS 2.4.181) after each picture's
 * shape, as Excel writes them. The first record opens the drawing and its
 * group shape; each picture is one shape, with its name, its image in the
 * BLIP store, no border, and its anchor.
 */
function drawing(dgId: number, pictures: PlacedPicture[], columnPx: (col: number) => number, sheetName: string): Buffer {
  const base = dgId * 1024;
  const shapes = pictures.map((p, i) => {
    const where = `${sheetName}: picture "${p.name}"`;
    const complex = [p.name, p.description].map((s) => (s === undefined ? undefined : Buffer.from(`${s}\0`, "utf16le")));
    // Properties by ID: pib (with fBid, an index into the BLIP store), line style (no line), then name and description (complex: their text follows).
    const props: [number, number][] = [[0x4104, p.blip], [0x01ff, 0x00080000], [0x8380, complex[0]!.length]];
    if (complex[1]) props.push([0x8381, complex[1].length]);
    const opt = art(3, props.length, 0xf00b, ...props.map(([id, value]) => Buffer.concat([u16(id), u32(value)])), ...complex.filter((c) => c !== undefined));
    return art(
      0xf, 0, 0xf004,
      art(2, 75, 0xf00a, u32(base + i + 1, 0x0a00)), // FSP: a picture frame, with an anchor and a shape type
      opt,
      art(0, 0, 0xf010, anchor(p, columnPx, where)),
      art(0, 0, 0xf011),
    );
  });
  const group = art(0xf, 0, 0xf004, art(1, 0, 0xf009, Buffer.alloc(16)), art(2, 0, 0xf00a, u32(base, 0x5))); // the group shape, fGroup | fPatriarch
  const shapesLength = group.length + shapes.reduce((n, s) => n + s.length, 0);
  const fdg = art(0, dgId, 0xf008, u32(pictures.length + 1, base + pictures.length));
  // Container headers count every shape, though the shapes after the first come in later records.
  const head = Buffer.concat([
    u16(0x000f, 0xf002), u32(fdg.length + 8 + shapesLength), fdg,
    u16(0x000f, 0xf003), u32(shapesLength), group,
  ]);
  return Buffer.concat(
    shapes.flatMap((shape, i) => {
      // OBJ: a picture (ot 8) with ID i + 1, locked and printed; any picture format; then the end.
      const obj = Buffer.concat([u16(0x15, 0x12, 0x08, i + 1, 0x6011), Buffer.alloc(12), u16(0x07, 0x02, 0xffff), u16(0x08, 0x02, 0x0001), u16(0, 0)]);
      return [record(0x00ec, i === 0 ? Buffer.concat([head, shape]) : shape), record(0x005d, obj)];
    }),
  );
}

/**
 * The workbook's MSODRAWINGGROUP (MS-XLS 2.4.170): an OfficeArtDggContainer
 * with the drawings' shape ID clusters and the BLIP store, each picture's PNG
 * in an OfficeArtFBSE identified by its MD5.
 */
function drawingGroup(drawings: number[], pngs: Buffer[]): Buffer {
  const shapes = drawings.reduce((n, count) => n + count + 1, 0);
  const lastSpid = drawings.length * 1024 + drawings[drawings.length - 1]!;
  const dgg = art(0, 0, 0xf006, u32(lastSpid + 1, drawings.length + 1, shapes, drawings.length), ...drawings.map((count, i) => u32(i + 1, count + 1)));
  const store = pngs.map((png) => {
    const uid = createHash("md5").update(png).digest();
    const blip = art(0, 0x6e0, 0xf01e, uid, Buffer.from([0xff]), png); // OfficeArtBlipPNG
    return art(2, 6, 0xf007, Buffer.from([6, 6]), uid, u16(0xff), u32(blip.length, 1, 0), Buffer.alloc(4), blip); // OfficeArtFBSE: PNG on Windows and Mac, one reference
  });
  return longRecord(0x00eb, art(0xf, 0, 0xf000, dgg, art(0xf, pngs.length, 0xf001, ...store)));
}

/**
 * Builds the .xls file for a workbook. Output is deterministic. `load` reads
 * a picture's file, given its `file` path; it is needed only for pictures.
 */
export function buildXls(source: XlsSource, load?: (file: string) => Buffer): Buffer {
  if (source.sheets.length === 0) throw new Error("a workbook needs at least one sheet");

  // Cell XFs, one per distinct (format, font, fill); 0-14 are style XFs and 15 the default cell XF.
  const cellXfs: { fmt: number; font: number; fill?: number }[] = [];
  const xfIndex = (fmt: number, font: number, fill?: number) => {
    let i = cellXfs.findIndex((x) => x.fmt === fmt && x.font === font && x.fill === fill);
    if (i < 0) i = cellXfs.push({ fmt, font, fill }) - 1;
    return 16 + i;
  };
  // Every picture's PNG, in BLIP store order, and the picture count of each sheet that has a drawing.
  const pngs: Buffer[] = [];
  const drawings: number[] = [];

  const sheetStreams = source.sheets.map((sheet, sheetNo) => {
    if (sheet.name.length === 0 || sheet.name.length > 31 || /[[\]:*?/\\]/.test(sheet.name)) {
      throw new Error(`invalid sheet name "${sheet.name}"`);
    }
    const pictures = (sheet.pictures ?? []).map((p): PlacedPicture => {
      if (!load) throw new Error(`${sheet.name}: picture "${p.name}": no way to read picture files was given`);
      if (p.name.trim() === "") throw new Error(`${sheet.name}: a picture needs a name`);
      const png = load(p.file);
      pngSize(png, `${sheet.name}: picture "${p.name}"`);
      return { ...p, png, blip: pngs.push(png) };
    });
    if (new Set(pictures.map((p) => p.name.toLowerCase())).size !== pictures.length) throw new Error(`${sheet.name}: two pictures have the same name`);
    // A column's width in pixels as Excel shows it, from the width COLINFO stores.
    const columnPx = (c: number) => {
      const w = sheet.widths?.[c];
      return w === undefined ? DEFAULT_COLUMN_PX : Math.trunc(((Math.round(w * 256) + 18) / 256) * 7);
    };
    const objects = pictures.length === 0 ? [] : [drawing(drawings.push(pictures.length), pictures, columnPx, sheet.name)];
    const cells: Buffer[] = [];
    let lastCol = 0;
    sheet.rows.forEach((row, r) => {
      row.forEach((cell, c) => {
        if (cell === null) return;
        const where = `${sheet.name}!${columnName(c)}${r + 1}`;
        const spec: Exclude<XlsCell, null | string | number> = typeof cell === "object" ? cell : typeof cell === "number" ? { number: cell } : { text: cell };
        if (spec.formula !== undefined && spec.number === undefined) throw new Error(`${where}: a formula needs its calculated result as number`);
        const kinds = [spec.text, spec.number, spec.date].filter((v) => v !== undefined).length;
        if (kinds !== 1) throw new Error(`${where}: a cell holds exactly one of text, number or date`);
        const fmt = spec.date !== undefined ? FMT_DATE : spec.format === "amount" ? FMT_AMOUNT : 0;
        // Font index 4 doesn't exist in BIFF8: the second font written is index 1.
        const ixfe = xfIndex(fmt, spec.bold ? 1 : 0, spec.fill === undefined ? undefined : PALETTE_INDEX[spec.fill]);
        const head = u16(r, c, ixfe);
        if (spec.text !== undefined) {
          cells.push(record(0x0204, Buffer.concat([head, unicodeString(spec.text)]))); // LABEL
        } else if (spec.formula !== undefined) {
          // FORMULA: cached result, flags (fAlwaysCalc: Excel recalculates on open), chn, then the parsed formula.
          const rgce = parseFormula(spec.formula, where);
          const value = Buffer.alloc(8);
          value.writeDoubleLE(spec.number!, 0);
          cells.push(record(0x0006, Buffer.concat([head, value, u16(0x0001), Buffer.alloc(4), u16(rgce.length), rgce])));
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
    return Buffer.concat([bof(0x0010), ...widths, record(0x0200, dimensions), ...cells, ...objects, window2, record(0x000a, Buffer.alloc(0))]);
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
  const group = drawings.length === 0 ? Buffer.alloc(0) : drawingGroup(drawings, pngs);
  const eof = record(0x000a, Buffer.alloc(0));
  let offset = globalsHead.length + boundsheets.reduce((n, b) => n + 4 + b.length, 0) + group.length + eof.length;
  for (const [i, body] of boundsheets.entries()) {
    body.writeUInt32LE(offset, 0);
    offset += sheetStreams[i]!.length;
  }
  let workbook = Buffer.concat([globalsHead, ...boundsheets.map((b) => record(0x0085, b)), group, eof, ...sheetStreams]);
  if (workbook.length < MIN_STREAM) workbook = Buffer.concat([workbook, Buffer.alloc(MIN_STREAM - workbook.length)]);

  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, "/Workbook", workbook);
  return Buffer.from(CFB.write(cfb, { type: "buffer" }) as Uint8Array);
}
