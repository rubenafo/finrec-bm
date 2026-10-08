// Reads Excel 97-2003 .xls workbooks (BIFF8, MS-XLS): every sheet's cell
// values, with dates recognised from their number format and each cell's
// fill colour. Handles what Excel itself writes: shared strings split across
// CONTINUE records, RK and MULRK numbers, formulas with cached results, a
// custom palette and custom number formats.

import CFB from "cfb";

export type XlsValue = { type: "text"; value: string } | { type: "number"; value: number } | { type: "date"; value: string } | { type: "bool"; value: boolean } | { type: "error"; value: string };

export interface XlsCellData {
  /** 1-based, as Excel shows it. */
  row: number;
  /** Column letters, as Excel shows them: A, B, ..., AA. */
  column: string;
  value: XlsValue;
  /** Solid or patterned fill colour as #RRGGBB; undefined when the cell has no fill. */
  fill?: string;
}

export interface XlsSheetData {
  name: string;
  /** Non-empty cells, by row then column. */
  cells: XlsCellData[];
}

export class XlsError extends Error {}

/** The default BIFF8 palette, indices 8 to 63 (MS-XLS 2.5.161); 0-7 repeat the first eight. */
const DEFAULT_PALETTE = [
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080",
  "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF",
  "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF",
  "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99",
  "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696",
  "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
];
/** Built-in number formats that show dates or times. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const ERRORS: Record<number, string> = { 0x00: "#NULL!", 0x07: "#DIV/0!", 0x0f: "#VALUE!", 0x17: "#REF!", 0x1d: "#NAME?", 0x24: "#NUM!", 0x2a: "#N/A" };

interface Record_ {
  type: number;
  data: Buffer;
  /** Bodies of the CONTINUE records that follow it. */
  continues: Buffer[];
}

/** Splits a BIFF stream from `start` into records, attaching CONTINUE records to the one they continue. */
function readRecords(stream: Buffer, start: number, stopAtEof: boolean): Record_[] {
  const records: Record_[] = [];
  for (let at = start; at + 4 <= stream.length; ) {
    const type = stream.readUInt16LE(at);
    const size = stream.readUInt16LE(at + 2);
    const data = stream.subarray(at + 4, at + 4 + size);
    at += 4 + size;
    if (type === 0x003c && records.length > 0) records[records.length - 1]!.continues.push(data);
    else records.push({ type, data, continues: [] });
    if (type === 0x000a && stopAtEof) break;
  }
  return records;
}

/**
 * Reads a run of characters that may span CONTINUE records: at each record
 * boundary inside a string, a new flags byte says whether the rest is
 * 8-bit or UTF-16 (MS-XLS 2.5.293).
 */
class Segments {
  private part = 0;
  private at = 0;
  constructor(private readonly parts: Buffer[]) {}

  private current(): Buffer {
    while (this.part < this.parts.length && this.at >= this.parts[this.part]!.length) {
      this.part++;
      this.at = 0;
    }
    if (this.part >= this.parts.length) throw new XlsError("string table ends early");
    return this.parts[this.part]!;
  }
  u8(): number {
    return this.current()[this.at++]!;
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  skip(n: number) {
    for (let left = n; left > 0; ) {
      const part = this.current();
      const step = Math.min(left, part.length - this.at);
      this.at += step;
      left -= step;
    }
  }
  chars(count: number, wide: boolean): string {
    let out = "";
    for (let left = count; left > 0; ) {
      this.current();
      // A string that runs into a new record resumes there with its own flags byte.
      if (this.at === 0 && out.length > 0) {
        wide = (this.u8() & 1) === 1;
        continue;
      }
      const p = this.current();
      const width = wide ? 2 : 1;
      const n = Math.min(left, Math.floor((p.length - this.at) / width));
      if (n === 0) throw new XlsError("malformed string");
      out += wide ? p.toString("utf16le", this.at, this.at + 2 * n) : p.toString("latin1", this.at, this.at + n);
      this.at += n * width;
      left -= n;
    }
    return out;
  }
  /** An XLUnicodeString (MS-XLS 2.5.294): 16-bit length, flags, characters. */
  plainString(): string {
    const count = this.u16();
    return this.chars(count, (this.u8() & 1) === 1);
  }
  /** An XLUnicodeRichExtendedString (MS-XLS 2.5.293). */
  richString(): string {
    const count = this.u16();
    const flags = this.u8();
    const runs = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.u32() : 0;
    const text = this.chars(count, (flags & 1) === 1);
    this.skip(4 * runs + ext);
    return text;
  }
}

/** XLUnicodeString inside one record: 16-bit length, flags, characters. */
function unicodeString(data: Buffer, at: number): string {
  const count = data.readUInt16LE(at);
  const wide = (data[at + 2]! & 1) === 1;
  return wide ? data.toString("utf16le", at + 3, at + 3 + 2 * count) : data.toString("latin1", at + 3, at + 3 + count);
}

/** ShortXLUnicodeString: 8-bit length, flags, characters. */
function shortString(data: Buffer, at: number): string {
  const count = data[at]!;
  const wide = (data[at + 1]! & 1) === 1;
  return wide ? data.toString("utf16le", at + 2, at + 2 + 2 * count) : data.toString("latin1", at + 2, at + 2 + count);
}

/** An RK number (MS-XLS 2.5.217): a 30-bit integer or the top of a double, optionally divided by 100. */
function rk(value: number): number {
  let n: number;
  if (value & 2) n = value >> 2;
  else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE((value & 0xfffffffc) >>> 0, 4);
    n = b.readDoubleLE(0);
  }
  return value & 1 ? n / 100 : n;
}

/** Whether a custom number format shows a date: it has d or y outside quotes, escapes and brackets. */
function isDateFormat(format: string): boolean {
  const bare = format.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  return /[dy]/i.test(bare);
}

export const columnName = (index: number): string => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

/** Parses an .xls workbook. Throws XlsError when it isn't one. */
export function readXls(file: Buffer): XlsSheetData[] {
  let stream: Buffer;
  try {
    const cfb = CFB.read(file, { type: "buffer" });
    const entry = CFB.find(cfb, "Workbook") ?? CFB.find(cfb, "Book");
    if (!entry?.content) throw new XlsError("no Workbook stream: not an Excel 97-2003 workbook");
    stream = Buffer.from(entry.content as Uint8Array);
  } catch (err) {
    if (err instanceof XlsError) throw err;
    throw new XlsError(`not an Excel 97-2003 workbook (${err instanceof Error ? err.message : err})`);
  }

  const globals = readRecords(stream, 0, true);
  const bof = globals[0];
  if (bof?.type !== 0x0809 || bof.data.readUInt16LE(0) !== 0x0600) throw new XlsError("only BIFF8 (Excel 97-2003) workbooks are supported");

  const palette = DEFAULT_PALETTE.slice();
  const formats = new Map<number, string>();
  const xfs: { fmt: number; fill?: number }[] = [];
  const sheets: { name: string; offset: number }[] = [];
  let strings: string[] = [];
  let date1904 = false;
  for (const { type, data, continues } of globals) {
    switch (type) {
      case 0x0022: // DATEMODE
        date1904 = data.readUInt16LE(0) === 1;
        break;
      case 0x0092: // PALETTE: colours for indices 8 onwards
        for (let i = 0; i < data.readUInt16LE(0); i++) {
          const at = 2 + 4 * i;
          palette[i] = [data[at]!, data[at + 1]!, data[at + 2]!].map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
        }
        break;
      case 0x041e: // FORMAT
        formats.set(data.readUInt16LE(0), unicodeString(data, 2));
        break;
      case 0x00e0: {
        // XF: number format, and the fill when its pattern isn't "none".
        const pattern = (data.readUInt32LE(14) >>> 26) & 0x3f;
        xfs.push({ fmt: data.readUInt16LE(2), ...(pattern !== 0 && { fill: data.readUInt16LE(18) & 0x7f }) });
        break;
      }
      case 0x0085: // BOUNDSHEET: worksheets only (type 0), not charts or macro sheets
        if (data[5] === 0) sheets.push({ name: shortString(data, 6), offset: data.readUInt32LE(0) });
        break;
      case 0x00fc: {
        // SST: the shared strings, which may run into CONTINUE records.
        const segments = new Segments([data.subarray(8), ...continues]);
        strings = Array.from({ length: data.readUInt32LE(4) }, () => segments.richString());
        break;
      }
    }
  }

  const colour = (index: number | undefined): string | undefined => {
    if (index === undefined || index >= 64) return undefined; // 64 and 65 are system colours
    return `#${palette[index >= 8 ? index - 8 : index]}`;
  };
  const isDate = (ixfe: number) => {
    const fmt = xfs[ixfe]?.fmt ?? 0;
    return BUILTIN_DATE_FORMATS.has(fmt) || (formats.has(fmt) && isDateFormat(formats.get(fmt)!));
  };
  const numberValue = (n: number, ixfe: number): XlsValue => {
    if (!isDate(ixfe)) return { type: "number", value: n };
    const days = Math.floor(n);
    const ms = Math.round((n - days) * 86_400_000);
    const when = new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) + days * 86_400_000 + ms);
    const iso = when.toISOString();
    return { type: "date", value: ms === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}` };
  };

  return sheets.map(({ name, offset }) => {
    const cells = new Map<string, XlsCellData>();
    const put = (row: number, col: number, ixfe: number, value: XlsValue) => {
      const fill = colour(xfs[ixfe]?.fill);
      cells.set(`${row}:${col}`, { row: row + 1, column: columnName(col), value, ...(fill && { fill }) });
    };
    const records = readRecords(stream, offset, true);
    for (const [i, { type, data, continues }] of records.entries()) {
      const row = () => data.readUInt16LE(0);
      const col = () => data.readUInt16LE(2);
      const ixfe = () => data.readUInt16LE(4);
      switch (type) {
        case 0x00fd: // LABELSST
          put(row(), col(), ixfe(), { type: "text", value: strings[data.readUInt32LE(6)] ?? "" });
          break;
        case 0x0204: // LABEL
          put(row(), col(), ixfe(), { type: "text", value: new Segments([data.subarray(6), ...continues]).plainString() });
          break;
        case 0x0203: // NUMBER
          put(row(), col(), ixfe(), numberValue(data.readDoubleLE(6), ixfe()));
          break;
        case 0x027e: // RK
          put(row(), col(), ixfe(), numberValue(rk(data.readInt32LE(6)), ixfe()));
          break;
        case 0x00bd: {
          // MULRK: several RK cells in one row
          const first = col();
          const count = (data.length - 6) / 6;
          for (let k = 0; k < count; k++) {
            const x = data.readUInt16LE(4 + 6 * k);
            put(row(), first + k, x, numberValue(rk(data.readInt32LE(6 + 6 * k)), x));
          }
          break;
        }
        case 0x0205: // BOOLERR
          put(row(), col(), ixfe(), data[7] ? { type: "error", value: ERRORS[data[6]!] ?? "#ERROR" } : { type: "bool", value: data[6] === 1 });
          break;
        case 0x0006: {
          // FORMULA: its cached result; a string result follows in a STRING record.
          if (data.readUInt16LE(12) !== 0xffff) {
            put(row(), col(), ixfe(), numberValue(data.readDoubleLE(6), ixfe()));
          } else if (data[6] === 0) {
            const next = records[i + 1];
            if (next?.type === 0x0207) put(row(), col(), ixfe(), { type: "text", value: new Segments([next.data, ...next.continues]).plainString() });
          } else if (data[6] === 1) {
            put(row(), col(), ixfe(), { type: "bool", value: data[8] === 1 });
          } else if (data[6] === 2) {
            put(row(), col(), ixfe(), { type: "error", value: ERRORS[data[8]!] ?? "#ERROR" });
          }
          break;
        }
      }
    }
    const sorted = [...cells.entries()]
      .sort(([a], [b]) => {
        const [ra, ca] = a.split(":").map(Number);
        const [rb, cb] = b.split(":").map(Number);
        return ra! - rb! || ca! - cb!;
      })
      .map(([, cell]) => cell);
    return { name, cells: sorted };
  });
}
