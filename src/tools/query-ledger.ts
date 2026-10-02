import { requireString, ToolError, type Tool } from "./types.js";

const MAX_ROWS = 200;

export const queryLedger: Tool = {
  name: "query_ledger",
  description:
    "Run a read-only DuckDB SQL query against the ledger database. " +
    "Use SHOW TABLES and DESCRIBE <table> to explore the schema. " +
    `Results are returned as JSON and capped at ${MAX_ROWS} rows; use WHERE, aggregates or LIMIT/OFFSET for more.`,
  inputSchema: {
    type: "object",
    properties: {
      sql: { type: "string", description: "A single SELECT, SHOW or DESCRIBE query." },
    },
    required: ["sql"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const sql = requireString(input, "sql").trim().replace(/;\s*$/, "");
    // Wrapping the query only parses for SELECT-like statements, and requiring
    // exactly one statement stops input such as `1); DROP TABLE t; SELECT (1`.
    // Together they keep the database unchanged for the rest of the test run.
    let reader;
    try {
      const statements = await ctx.db.extractStatements(`SELECT * FROM (${sql}) LIMIT ${MAX_ROWS + 1}`);
      if (statements.count !== 1) {
        throw new ToolError("only a single read-only query is allowed");
      }
      reader = await (await statements.prepare(0)).runAndReadAll();
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(err instanceof Error ? err.message : String(err));
    }
    const rows = reader.getRowObjectsJson();
    const truncated = rows.length > MAX_ROWS;
    return JSON.stringify({
      columns: reader.columnNames(),
      rows: truncated ? rows.slice(0, MAX_ROWS) : rows,
      truncated,
    });
  },
};
