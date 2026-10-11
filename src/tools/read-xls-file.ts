import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { imageInfo } from "../common/image.js";
import { readXls, XlsError, type XlsCellData } from "../common/xls.js";
import { resolveEvidence } from "./paths.js";
import { requireString, ToolError, type Tool } from "./types.js";

const MAX_BYTES = 5_000_000;
const MAX_CELLS = 5_000;

/** A cell as `F8=12480 [fill #FFFF00]`: text in JSON quotes, numbers as stored, dates as ISO, a formula as `[formula =SUM(F4:F7)]` after its value. */
function formatCell(cell: XlsCellData): string {
  const { value } = cell;
  const shown = value.type === "text" ? JSON.stringify(value.value) : value.type === "date" ? `date ${value.value}` : String(value.value);
  return `${cell.column}${cell.row}=${shown}${cell.formula !== undefined ? ` [formula =${cell.formula}]` : ""}${cell.fill ? ` [fill ${cell.fill}]` : ""}`;
}

export const readXlsFile: Tool = {
  name: "read_xls_file",
  description:
    "Read an Excel 97-2003 .xls workbook for this case. Returns every sheet's non-empty cells, one line per row, " +
    "each cell as <column><row>=<value>: text in double quotes, numbers as stored (without display formatting), " +
    "dates as \"date yyyy-mm-dd\". A formula cell shows its last calculated value followed by the formula, as " +
    "[formula =SUM(F4:F7)]. A cell with a background fill shows it as [fill #RRGGBB]; cells without one have no fill. " +
    "Pictures placed over a sheet, such as screenshots, are listed after its cells by name and the cells they cover: " +
    "view them with read_image_file.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file in the evidence folder, e.g. \"evidence/workbook.xls\"." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const path = requireString(input, "path");
    const file = resolveEvidence(ctx.evidenceDir, path);
    if (extname(file).toLowerCase() !== ".xls") throw new ToolError(`"${path}" is not an .xls file`);
    if (statSync(file).size > MAX_BYTES) throw new ToolError(`file is larger than ${MAX_BYTES} bytes`);

    let sheets;
    try {
      sheets = readXls(readFileSync(file));
    } catch (err) {
      if (err instanceof XlsError) throw new ToolError(`could not read "${path}": ${err.message}`);
      throw err;
    }
    const total = sheets.reduce((n, s) => n + s.cells.length, 0);
    if (total > MAX_CELLS) throw new ToolError(`workbook has ${total} cells, more than the ${MAX_CELLS} this tool returns`);

    const parts = [`${sheets.length} sheet(s): ${sheets.map((s) => JSON.stringify(s.name)).join(", ")}`];
    for (const sheet of sheets) {
      const rows = new Map<number, XlsCellData[]>();
      for (const cell of sheet.cells) rows.set(cell.row, [...(rows.get(cell.row) ?? []), cell]);
      const lines = [...rows.entries()].map(([row, cells]) => `row ${row}: ${cells.map(formatCell).join(" | ")}`);
      for (const p of sheet.pictures) {
        const image = imageInfo(p.data);
        const size = image ? `, ${image.format.toUpperCase()} ${image.width}x${image.height} pixels` : "";
        lines.push(`picture ${JSON.stringify(p.name)} over ${p.from}:${p.to}${size}${p.description ? `, alt text ${JSON.stringify(p.description)}` : ""}`);
      }
      const empty = sheet.cells.length === 0 && sheet.pictures.length === 0;
      parts.push(`=== sheet ${JSON.stringify(sheet.name)}${empty ? " (empty)" : ""}\n${lines.join("\n")}`.trimEnd());
    }
    return parts.join("\n\n");
  },
};
