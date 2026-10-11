// Draws PNG screenshots of a worksheet for benchmark evidence, as Excel shows
// it at 100% zoom: column letters and row numbers, gridlines, cell fills,
// numbers right-aligned in their format, text overflowing into empty cells,
// and the sheet tabs below. The sheet uses the same JSON cells as the .xls
// writer, so a screenshot and a workbook can share their data. The picture is
// rendered with resvg and the bundled Carlito font (metric-compatible with
// Excel's Calibri), without system fonts, so output is deterministic.

import { Resvg } from "@resvg/resvg-js";
import { join } from "node:path";
import type { XlsCell, XlsFill, XlsSheet } from "./xls-writer.js";

/** A screenshot to draw: a sheet, its tabs and the part of it in view. */
export interface ScreenshotSource {
  /** The workbook's sheet tabs, in order; `sheet.name` is the active one. Default: that sheet alone. */
  tabs?: string[];
  /** The sheet shown, rows from row 1. */
  sheet: XlsSheet;
  /** The part of the sheet in view. Default: from row 1 and column A to one row and one column past the data. */
  view?: { firstRow?: number; lastRow?: number; lastColumn?: string };
}

const FONTS = ["Carlito-Regular.ttf", "Carlito-Bold.ttf"].map((f) => join(import.meta.dirname, "fonts", f));
const FILL: Record<XlsFill, string> = { yellow: "#FFFF00", grey: "#C0C0C0", tan: "#FFCC99", green: "#CCFFCC" };
/** Output scale: 1.5 is a 144 dpi screen, sharp enough to read every digit. */
const ZOOM = 1.5;
const ROW_HEIGHT = 20;
const HEADER_HEIGHT = 20;
const TABS_HEIGHT = 26;
const FONT_SIZE = 14.67; // 11 pt
/** Width of a number or date as shown: Carlito's digits are 0.507 em wide, separators about half that. */
const numberWidth = (s: string) => [...s].reduce((w, ch) => w + (/\d/.test(ch) ? 0.507 : 0.3), 0) * FONT_SIZE;
const PADDING = 3;
/** Excel's default column width, 8.43 characters, in pixels. */
const DEFAULT_COLUMN = 64;

const columnName = (col: number) => {
  let name = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
const columnIndex = (name: string) => [...name.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const thousands = (digits: string) => digits.replace(/\B(?=(\d{3})+$)/g, ",");

/** A number as Excel shows it: #,##0.00 for amounts, otherwise in the General format. */
function shown(n: number, amount: boolean): string {
  if (!amount) return String(n);
  const [whole, cents] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}${thousands(whole!)}.${cents}`;
}

type Spec = Exclude<XlsCell, null | string | number>;
const specOf = (cell: XlsCell | undefined): Spec | null =>
  cell === null || cell === undefined ? null : typeof cell === "object" ? cell : typeof cell === "number" ? { number: cell } : { text: cell };

/** Renders the screenshot's SVG, at 100% zoom. Exported for tests. */
export function screenshotSvg(source: ScreenshotSource): { svg: string; width: number; height: number } {
  const { sheet } = source;
  const tabs = source.tabs ?? [sheet.name];
  if (!tabs.includes(sheet.name)) throw new Error(`sheet "${sheet.name}" is not one of the tabs ${tabs.join(", ")}`);
  const dataColumns = Math.max(1, ...sheet.rows.map((r) => r.length));
  const firstRow = source.view?.firstRow ?? 1;
  const lastRow = source.view?.lastRow ?? sheet.rows.length + 1;
  const lastCol = source.view?.lastColumn === undefined ? dataColumns : columnIndex(source.view.lastColumn);
  if (firstRow < 1 || lastRow < firstRow || lastCol < 0) throw new Error("invalid view");

  const colWidth = (c: number) => (sheet.widths?.[c] === undefined ? DEFAULT_COLUMN : Math.trunc(sheet.widths[c]! * 7));
  const rowHeaderWidth = Math.max(32, 9 * String(lastRow).length + 14);
  const colX: number[] = [rowHeaderWidth];
  for (let c = 0; c <= lastCol; c++) colX.push(colX[c]! + colWidth(c));
  const width = colX[lastCol + 1]!;
  const rowY = (r: number) => HEADER_HEIGHT + (r - firstRow) * ROW_HEIGHT;
  const gridBottom = rowY(lastRow + 1);
  const height = gridBottom + TABS_HEIGHT;

  const out: string[] = [];
  const text = (x: number, y: number, s: string, attrs = "") => out.push(`<text x="${x}" y="${y}"${attrs}>${escape(s)}</text>`);
  out.push(`<rect width="${width}" height="${height}" fill="#FFFFFF"/>`);

  // Fills first, then gridlines between cells that have no fill, then text on top.
  const cellAt = (r: number, c: number) => specOf(sheet.rows[r - 1]?.[c]);
  for (let r = firstRow; r <= lastRow; r++) {
    for (let c = 0; c <= lastCol; c++) {
      const fill = cellAt(r, c)?.fill;
      if (fill) out.push(`<rect x="${colX[c]}" y="${rowY(r)}" width="${colWidth(c)}" height="${ROW_HEIGHT}" fill="${FILL[fill]}"/>`);
    }
  }
  const lines: string[] = [];
  for (let c = 0; c <= lastCol; c++) {
    for (let r = firstRow; r <= lastRow; r++) {
      const x = colX[c + 1]! - 0.5;
      if (!cellAt(r, c)?.fill || !cellAt(r, c + 1)?.fill) lines.push(`M${x} ${rowY(r)}V${rowY(r + 1)}`);
      const y = rowY(r + 1) - 0.5;
      if (!cellAt(r, c)?.fill || !cellAt(r + 1, c)?.fill) lines.push(`M${colX[c]} ${y}H${colX[c + 1]}`);
    }
  }
  out.push(`<path d="${lines.join("")}" stroke="#D4D4D4" stroke-width="1" fill="none"/>`);

  for (let r = firstRow; r <= lastRow; r++) {
    for (let c = 0; c <= lastCol; c++) {
      const spec = cellAt(r, c);
      if (spec === null) continue;
      const where = `${sheet.name}!${columnName(c)}${r}`;
      const baseline = rowY(r) + 15;
      const weight = spec.bold ? ` font-weight="bold"` : "";
      if (spec.text !== undefined) {
        // Text overflows into the empty cells to its right, as far as the view goes.
        let end = c + 1;
        while (end <= lastCol && cellAt(r, end) === null) end++;
        out.push(`<clipPath id="c${r}-${c}"><rect x="${colX[c]}" y="${rowY(r)}" width="${colX[end]! - colX[c]!}" height="${ROW_HEIGHT}"/></clipPath>`);
        text(colX[c]! + PADDING, baseline, spec.text, `${weight} clip-path="url(#c${r}-${c})"`);
        continue;
      }
      const value = spec.date ?? shown(spec.number!, spec.format === "amount");
      if (numberWidth(value) > colWidth(c) - 2 * PADDING) throw new Error(`${where}: "${value}" doesn't fit its column: Excel would show ####`);
      text(colX[c + 1]! - PADDING, baseline, value, `${weight} text-anchor="end"`);
    }
  }

  // Column letters and row numbers, with the corner box.
  out.push(`<rect width="${width}" height="${HEADER_HEIGHT}" fill="#F3F3F3"/>`);
  out.push(`<rect y="${HEADER_HEIGHT}" width="${rowHeaderWidth}" height="${gridBottom - HEADER_HEIGHT}" fill="#F3F3F3"/>`);
  const headerLines = [`M0 ${HEADER_HEIGHT - 0.5}H${width}`, `M${rowHeaderWidth - 0.5} 0V${gridBottom}`];
  for (let c = 0; c <= lastCol; c++) {
    headerLines.push(`M${colX[c + 1]! - 0.5} 0V${HEADER_HEIGHT}`);
    text((colX[c]! + colX[c + 1]!) / 2, 15, columnName(c), ` text-anchor="middle" font-size="13" fill="#444444"`);
  }
  for (let r = firstRow; r <= lastRow; r++) {
    headerLines.push(`M0 ${rowY(r + 1) - 0.5}H${rowHeaderWidth}`);
    text(rowHeaderWidth / 2, rowY(r) + 15, String(r), ` text-anchor="middle" font-size="13" fill="#444444"`);
  }
  out.push(`<path d="${headerLines.join("")}" stroke="#C8C8C8" stroke-width="1" fill="none"/>`);
  out.push(`<path d="M${rowHeaderWidth - 4} ${HEADER_HEIGHT - 4}H${rowHeaderWidth - 4 - 9}L${rowHeaderWidth - 4} ${HEADER_HEIGHT - 4 - 9}Z" fill="#B4B4B4"/>`);

  // Sheet tabs: the active one white, bold and underlined in green.
  out.push(`<rect y="${gridBottom}" width="${width}" height="${TABS_HEIGHT}" fill="#F3F3F3"/>`);
  out.push(`<path d="M0 ${gridBottom + 0.5}H${width}" stroke="#C8C8C8" stroke-width="1"/>`);
  let x = 48;
  for (const tab of tabs) {
    const tabWidth = Math.ceil(tab.length * 7.5) + 24;
    if (tab === sheet.name) {
      out.push(`<rect x="${x}" y="${gridBottom + 1}" width="${tabWidth}" height="${TABS_HEIGHT - 1}" fill="#FFFFFF"/>`);
      out.push(`<rect x="${x + 6}" y="${gridBottom + TABS_HEIGHT - 4}" width="${tabWidth - 12}" height="2" fill="#217346"/>`);
    }
    text(x + tabWidth / 2, gridBottom + 17, tab, ` text-anchor="middle" font-size="13" fill="${tab === sheet.name ? "#217346" : "#444444"}"${tab === sheet.name ? ` font-weight="bold"` : ""}`);
    out.push(`<path d="M${x + tabWidth + 0.5} ${gridBottom + 4}V${gridBottom + TABS_HEIGHT - 4}" stroke="#C8C8C8" stroke-width="1"/>`);
    x += tabWidth + 1;
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `font-family="Carlito" font-size="${FONT_SIZE}" fill="#000000">${out.join("")}</svg>`;
  return { svg, width, height };
}

/** Builds the PNG screenshot. Output is deterministic. */
export function buildScreenshot(source: ScreenshotSource): Buffer {
  const { svg } = screenshotSvg(source);
  const png = new Resvg(svg, {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Carlito" },
    fitTo: { mode: "zoom", value: ZOOM },
    shapeRendering: 2,
    textRendering: 1,
  }).render();
  return Buffer.from(png.asPng());
}
