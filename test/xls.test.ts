import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { columnName, readXls, XlsError, type XlsSheetData } from "../src/common/xls.js";
import { ToolError, tools, type CaseContext } from "../src/tools/index.js";
import { buildMsg } from "../scripts/msg-writer.js";
import { buildXls, type XlsSource } from "../scripts/xls-writer.js";

/**
 * Written by Excel 2016 (File > Save As > Excel 97-2003), so the reader is
 * checked against Excel's own output and not only against buildXls: sheet
 * "big", A1:A600 text ("row <n> " + n%7 times "é" + 20 times "x"), enough to
 * split the shared string table across CONTINUE records; B1:B600 n * 1.25;
 * C1 =SUM(B1:B600), C2 ="tot "&C1, C3 =1/0; C4 45791.5 as dd/mm/yyyy hh:mm;
 * C5 3 with a yellow fill; C6 4 with a light orange (#FFCC99) fill.
 */
const EXCEL_FIXTURE = join(import.meta.dirname, "fixtures", "excel-written.xls");

const workbook: XlsSource = {
  sheets: [
    {
      name: "transactions",
      widths: [12, 20],
      rows: [
        [{ text: "Receipts – Q2", bold: true }],
        [],
        [{ text: "Date", fill: "grey" }, { text: "Amount", fill: "grey" }],
        [{ date: "2025-05-14" }, { number: 12480, format: "amount", fill: "yellow" }],
        [{ date: "2024-02-29" }, -0.5, "Zürich ✓"],
      ],
    },
    { name: "summary", rows: [[], [null, null, 42]] },
  ],
};
const cellsOf = (sheet: XlsSheetData) => sheet.cells.map((c) => `${c.column}${c.row}=${JSON.stringify(c.value.value)}${c.fill ? ` ${c.fill}` : ""}`);

describe("xls writer and reader", () => {
  it("round-trips text, numbers, dates and fills, sheet by sheet", () => {
    const sheets = readXls(buildXls(workbook));
    assert.deepEqual(sheets.map((s) => s.name), ["transactions", "summary"]);
    assert.deepEqual(cellsOf(sheets[0]!), [
      'A1="Receipts – Q2"',
      'A3="Date" #C0C0C0',
      'B3="Amount" #C0C0C0',
      'A4="2025-05-14"',
      "B4=12480 #FFFF00",
      'A5="2024-02-29"',
      "B5=-0.5",
      'C5="Zürich ✓"',
    ]);
    assert.equal(sheets[0]!.cells.find((c) => c.column === "A" && c.row === 4)!.value.type, "date");
    assert.deepEqual(cellsOf(sheets[1]!), ["C2=42"]);
  });

  it("writes the same bytes for the same source", () => {
    assert.ok(buildXls(workbook).equals(buildXls(workbook)));
  });

  it("rejects cells that hold more or less than one value, bad dates and bad sheet names", () => {
    assert.throws(() => buildXls({ sheets: [{ name: "s", rows: [[{ text: "a", number: 1 }]] }] }), /s!A1: a cell holds exactly one/);
    assert.throws(() => buildXls({ sheets: [{ name: "s", rows: [[null, { fill: "yellow" }]] }] }), /s!B1/);
    assert.throws(() => buildXls({ sheets: [{ name: "s", rows: [[{ date: "14/05/2025" }]] }] }), /invalid date/);
    assert.throws(() => buildXls({ sheets: [{ name: "a/b", rows: [] }] }), /invalid sheet name/);
    assert.throws(() => buildXls({ sheets: [] }), /at least one sheet/);
  });

  it("reads Excel's own .xls: shared strings across CONTINUE records, RK numbers, formulas, datetimes, fills", () => {
    const [sheet] = readXls(readFileSync(EXCEL_FIXTURE));
    assert.equal(sheet!.name, "big");
    const at = (address: string) => sheet!.cells.find((c) => `${c.column}${c.row}` === address);
    for (let n = 1; n <= 600; n++) {
      assert.equal(at(`A${n}`)?.value.value, `row ${n} ${"é".repeat(n % 7)}${"x".repeat(20)}`, `A${n}`);
      assert.equal(at(`B${n}`)?.value.value, n * 1.25, `B${n}`);
    }
    assert.deepEqual(at("C1")?.value, { type: "number", value: 225375 });
    assert.deepEqual(at("C2")?.value, { type: "text", value: "tot 225375" });
    assert.deepEqual(at("C3")?.value, { type: "error", value: "#DIV/0!" });
    assert.deepEqual(at("C4")?.value, { type: "date", value: "2025-05-14 12:00:00" });
    assert.equal(at("C5")?.fill, "#FFFF00");
    assert.equal(at("C6")?.fill, "#FFCC99");
    assert.equal(sheet!.cells.filter((c) => c.fill).length, 2, "only C5 and C6 have a fill");
  });

  it("rejects files that aren't Excel 97-2003 workbooks", () => {
    const msg = buildMsg({ from: { name: "a", email: "a@x" }, to: [], sent: "2025-01-01T00:00:00Z", subject: "s", body: [] });
    assert.throws(() => readXls(msg), XlsError, "a compound file without a Workbook stream");
    assert.throws(() => readXls(Buffer.from("Date,Amount\n")), XlsError);
  });

  it("names columns as Excel does", () => {
    assert.deepEqual([0, 5, 25, 26, 27, 701, 702].map(columnName), ["A", "F", "Z", "AA", "AB", "ZZ", "AAA"]);
  });
});

describe("read_xls_file", () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), "finrec-xls-"));
  const ctx = { test: "t", caseId: "case-0001", evidenceDir, db: null as never } satisfies CaseContext;
  const run = (name: string, input: Record<string, unknown>) => tools[name]!.run(input, ctx);

  before(() => {
    writeFileSync(join(evidenceDir, "book.xls"), buildXls(workbook));
    copyFileSync(EXCEL_FIXTURE, join(evidenceDir, "big.xls"));
    writeFileSync(join(evidenceDir, "fake.xls"), "not a workbook");
    writeFileSync(join(evidenceDir, "notes.txt"), "hello");
  });
  after(() => rmSync(evidenceDir, { recursive: true, force: true }));

  it("lists each sheet's cells row by row, with dates, numbers as stored and fills", async () => {
    const text = await run("read_xls_file", { path: "evidence/book.xls" });
    assert.equal(
      text,
      [
        '2 sheet(s): "transactions", "summary"',
        "",
        '=== sheet "transactions"',
        'row 1: A1="Receipts – Q2"',
        'row 3: A3="Date" [fill #C0C0C0] | B3="Amount" [fill #C0C0C0]',
        "row 4: A4=date 2025-05-14 | B4=12480 [fill #FFFF00]",
        'row 5: A5=date 2024-02-29 | B5=-0.5 | C5="Zürich ✓"',
        "",
        '=== sheet "summary"',
        "row 2: C2=42",
      ].join("\n"),
    );
  });

  it("reads Excel's own files", async () => {
    const text = await run("read_xls_file", { path: "big.xls" });
    assert.match(text, /^row 5: A5="row 5 éééééx{20}" \| B5=6\.25 \| C5=3 \[fill #FFFF00\]$/m);
  });

  it("rejects other files, unreadable workbooks and paths outside the evidence folder", async () => {
    await assert.rejects(run("read_xls_file", { path: "notes.txt" }), /is not an \.xls file/);
    await assert.rejects(run("read_xls_file", { path: "fake.xls" }), (err) => err instanceof ToolError && /could not read "fake.xls"/.test(err.message));
    await assert.rejects(run("read_xls_file", { path: "../book.xls" }), ToolError);
  });

  it("is the tool read_text_file points to for .xls files", async () => {
    await assert.rejects(run("read_text_file", { paths: ["book.xls"] }), /read it with read_xls_file/);
  });
});
