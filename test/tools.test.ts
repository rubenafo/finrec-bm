import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { caseContext } from "../src/case-context.js";
import { openTestDb, type TestDb } from "../src/test-db.js";
import { listEvidence, ToolError, tools, type CaseContext } from "../src/tools/index.js";
import { buildMsg } from "../scripts/msg-writer.js";

// A throwaway test folder: db.sql loads a CSV by relative path, one case with evidence.
const testDir = mkdtempSync(join(tmpdir(), "finrec-test-"));
const caseDir = join(testDir, "data", "case-0001");
const evidenceDir = join(caseDir, "evidence");
const forwardSlashes = (path: string) => path.replaceAll("\\", "/");

let db: TestDb;
let ctx: CaseContext;

before(async () => {
  mkdirSync(join(evidenceDir, "emails"), { recursive: true });
  writeFileSync(join(testDir, "ledger.csv"), "entry_id,amount\nL-001,100.00\nL-002,-3.50\n");
  writeFileSync(
    join(testDir, "db.sql"),
    `CREATE TABLE ledger AS SELECT entry_id, amount::DECIMAL(18,2) AS amount FROM read_csv('ledger.csv');
     CREATE TABLE accounts (code VARCHAR, name VARCHAR);
     INSERT INTO accounts VALUES ('1000', 'Cash');`,
  );
  writeFileSync(join(evidenceDir, "bank_statement.csv"), "id,amount\nB-001,100.00\n");
  writeFileSync(join(evidenceDir, "emails", "not-really.msg"), "plain text");
  writeFileSync(
    join(evidenceDir, "emails", "remittance.msg"),
    buildMsg({
      from: { name: "Ana Pérez", email: "ana@payer.example" },
      to: [{ name: "AR", email: "ar@payee.example" }],
      cc: [{ name: "Treasury", email: "treasury@payee.example" }],
      sent: "2026-03-02T10:15:00+01:00",
      subject: "Remittance advice – March",
      body: ["Paid INV-1001 and INV-1002.", "Total EUR 1.234,50"],
    }),
  );
  writeFileSync(join(caseDir, "expected.json"), "{}");

  db = await openTestDb(testDir);
  ctx = caseContext(testDir, "case-0001", db.connection);
});

after(() => {
  db.close();
  rmSync(testDir, { recursive: true, force: true });
});

const run = (name: string, input: Record<string, unknown>) => tools[name]!.run(input, ctx);

/** Splits one CSV line into fields, unquoting "..." fields. */
function splitCsv(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted && ch === '"' && line[i + 1] === '"') {
      field += '"';
      i++;
    } else if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      fields.push(field);
      field = "";
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

/** Parses one query_ledger result: CSV rows as objects, plus its closing row-count line. */
function parseResult(text: string): { rows: Record<string, string>[]; footer: string } {
  const lines = text.split("\n");
  const footer = lines.pop()!;
  const [header, ...rows] = lines.map(splitCsv);
  return { rows: rows.map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i]!]))), footer };
}
const query = async (sql: string) => parseResult(await run("query_ledger", { queries: [sql] }));

describe("openTestDb", () => {
  it("builds the database from db.sql, resolving files against the test folder", async () => {
    assert.deepEqual((await query("SELECT * FROM ledger ORDER BY entry_id")).rows, [
      { entry_id: "L-001", amount: "100.00" },
      { entry_id: "L-002", amount: "-3.50" },
    ]);
  });

  it("fails clearly when db.sql is missing or invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "finrec-bad-"));
    try {
      await assert.rejects(openTestDb(dir), /missing .*db\.sql/);
      writeFileSync(join(dir, "db.sql"), "CREATE TABLE oops (");
      await assert.rejects(openTestDb(dir), /db\.sql: /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is destroyed on close", async () => {
    const other = await openTestDb(testDir);
    other.close();
    await assert.rejects(other.connection.run("SELECT 1"));
  });
});

describe("query_ledger", () => {
  it("supports schema exploration", async () => {
    assert.deepEqual((await query("SHOW TABLES")).rows.map((r) => r.name).sort(), ["accounts", "ledger"]);
    assert.ok((await query("DESCRIBE ledger")).rows.length === 2);
  });

  it("returns CSV with a header row and a row count", async () => {
    assert.equal(
      await run("query_ledger", { queries: ["SELECT * FROM ledger ORDER BY entry_id"] }),
      "entry_id,amount\nL-001,100.00\nL-002,-3.50\n(2 rows)",
    );
    assert.equal((await query("SELECT 1 AS n")).footer, "(1 row)");
    assert.equal(await run("query_ledger", { queries: ["SELECT 1 AS n WHERE false"] }), "n\n(0 rows)");
  });

  it("quotes fields with commas, quotes or line breaks, and leaves NULL empty", async () => {
    const text = await run("query_ledger", { queries: [`SELECT 'a,b' AS x, 'say "hi"' AS y, NULL AS z, 'two' || chr(10) || 'lines' AS w`] });
    assert.equal(text, 'x,y,z,w\n"a,b","say ""hi""",,"two\nlines"\n(1 row)');
  });

  it("keeps columns that share a name", async () => {
    // The wrapping subquery makes DuckDB rename the second one.
    assert.equal(await run("query_ledger", { queries: ["SELECT 1 AS id, 2 AS id"] }), "id,id_1\n1,2\n(1 row)");
  });

  it("caps large results at 100 rows and says so", async () => {
    const result = await query("SELECT * FROM range(1000)");
    assert.equal(result.rows.length, 100);
    assert.match(result.footer, /^\(first 100 rows shown; more exist/);
    assert.equal((await query("SELECT * FROM range(100)")).footer, "(100 rows)");
  });

  it("runs a batch of queries, reporting failures in place", async () => {
    const text = await run("query_ledger", {
      queries: ["SELECT count(*)::INTEGER AS n FROM ledger", "SELECT nope FROM ledger", "DELETE FROM ledger", "SELECT code FROM accounts"],
    });
    const parts = text.split("\n\n");
    assert.equal(parts.length, 4);
    assert.equal(parts[0], "-- query 1: SELECT count(*)::INTEGER AS n FROM ledger\nn\n2\n(1 row)");
    assert.match(parts[1]!, /^-- query 2 failed: .*nope/);
    assert.match(parts[2]!, /^-- query 3 failed: /);
    assert.equal(parts[3], "-- query 4: SELECT code FROM accounts\ncode\n1000\n(1 row)");
    assert.equal((await query("SELECT count(*)::INTEGER AS n FROM ledger")).rows[0]!.n, "2", "the failed DELETE changed nothing");
  });

  it("fails a batch only when every query fails, or when the input is invalid", async () => {
    await assert.rejects(run("query_ledger", { queries: ["SELECT nope", "DROP TABLE ledger"] }), /every item failed:\n-- query 1 failed: .*\n-- query 2 failed: /);
    for (const queries of [[], "SELECT 1", [""], [1], Array(11).fill("SELECT 1")]) {
      await assert.rejects(run("query_ledger", { queries }), ToolError, JSON.stringify(queries));
    }
  });

  it("rejects writes, extra statements and file access, leaving the data intact", async () => {
    for (const sql of [
      "DELETE FROM ledger",
      "INSERT INTO accounts VALUES ('2000', 'AR')",
      "DROP TABLE ledger",
      "SELECT 1) ; DROP TABLE ledger; SELECT (1",
      `SELECT * FROM read_text('${forwardSlashes(join(caseDir, "expected.json"))}')`,
      "SELECT * FROM read_csv('ledger.csv')",
    ]) {
      await assert.rejects(run("query_ledger", { queries: [sql] }), ToolError, sql);
    }
    await assert.rejects(ctx.db.run("SET enable_external_access = true"));
    assert.equal((await query("SELECT count(*)::INTEGER AS n FROM ledger")).rows[0]!.n, "2");
    assert.equal((await query("SELECT count(*)::INTEGER AS n FROM accounts")).rows[0]!.n, "1");
  });

  it("reports SQL errors as tool errors", async () => {
    await assert.rejects(run("query_ledger", { queries: ["SELECT nope FROM ledger"] }), /nope/);
  });
});

describe("read_text_file", () => {
  it("reads a file in the case's evidence folder", async () => {
    for (const path of ["bank_statement.csv", "evidence/bank_statement.csv", "./evidence/bank_statement.csv"]) {
      assert.equal(await run("read_text_file", { paths: [path] }), "id,amount\nB-001,100.00\n", path);
    }
  });

  it("reads several files in one call, reporting a failed one in place", async () => {
    assert.equal(
      await run("read_text_file", { paths: ["evidence/bank_statement.csv", "../expected.json", "emails/remittance.msg", "bank_statement.csv"] }),
      [
        "=== evidence/bank_statement.csv\nid,amount\nB-001,100.00",
        '=== ../expected.json failed: "../expected.json" is outside the case\'s evidence folder',
        "=== emails/remittance.msg failed: file is an Outlook email: read it with read_msg_file",
        "=== bank_statement.csv\nid,amount\nB-001,100.00",
      ].join("\n\n"),
    );
    await assert.rejects(run("read_text_file", { paths: ["missing.txt", "../expected.json"] }), /every item failed/);
    await assert.rejects(run("read_text_file", { paths: [] }), ToolError);
  });

  it("rejects paths outside the evidence folder", async () => {
    for (const path of ["../expected.json", join(caseDir, "expected.json"), "../../../db.sql", "evidence/../expected.json", "evidence/../../../db.sql", "missing.txt", "."]) {
      await assert.rejects(run("read_text_file", { paths: [path] }), ToolError, path);
    }
  });
});

describe("read_msg_file", () => {
  it("rejects files that aren't .msg", async () => {
    await assert.rejects(run("read_msg_file", { path: "bank_statement.csv" }), ToolError);
  });

  it("reads sender, recipients, sent time, subject and body", async () => {
    const email = JSON.parse(await run("read_msg_file", { path: "evidence/emails/remittance.msg" }));
    assert.deepEqual(email.from, { name: "Ana Pérez", email: "ana@payer.example" });
    assert.deepEqual(email.recipients, [
      { type: "to", name: "AR", email: "ar@payee.example" },
      { type: "cc", name: "Treasury", email: "treasury@payee.example" },
    ]);
    assert.equal(new Date(email.sent).toISOString(), "2026-03-02T09:15:00.000Z");
    assert.equal(email.subject, "Remittance advice – March");
    assert.equal(email.body, ["Paid INV-1001 and INV-1002.", "Total EUR 1.234,50"].join("\r\n"));
    assert.deepEqual(email.attachments, []);
  });

  it("is the tool read_text_file points to for .msg files", async () => {
    await assert.rejects(run("read_text_file", { paths: ["emails/remittance.msg"] }), /read it with read_msg_file/);
  });

  it("reports unparseable .msg files as tool errors", async () => {
    await assert.rejects(run("read_msg_file", { path: "emails/not-really.msg" }), ToolError);
  });
});

describe("listEvidence", () => {
  it("lists nested files with forward slashes", () => {
    assert.deepEqual(listEvidence(evidenceDir), ["bank_statement.csv", "emails/not-really.msg", "emails/remittance.msg"]);
  });
});
