import { MAX_BATCH, requireStringList, runBatch, ToolError, type Tool } from "./types.js";

const MAX_ROWS = 100;

/** One CSV field: NULL as empty, lists and structs as JSON, quoted when it holds a comma, quote or line break. */
function csvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const queryLedger: Tool = {
  name: "query_ledger",
  description:
    "Run read-only DuckDB SQL queries against the ledger database, whose schema is not given in advance. " +
    "Explore it with SHOW ALL TABLES (every table with its columns and types), DESCRIBE <table>, " +
    "SUMMARIZE <table> (value ranges and counts per column), information_schema.columns, and " +
    "duckdb_constraints() (primary and foreign keys, which show how tables join). " +
    `Pass up to ${MAX_BATCH} independent queries in one call; with several, each result follows a "-- query N:" line, ` +
    "and a failed query is reported in place without stopping the others. " +
    `Each result is CSV (a header row, then one line per row; NULL is empty), ending with the row count. ` +
    `At most ${MAX_ROWS} rows are returned per query; use WHERE, aggregates or LIMIT/OFFSET for more.`,
  inputSchema: {
    type: "object",
    properties: {
      queries: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_BATCH,
        description: "Queries to run, each a single SELECT, SHOW, DESCRIBE or SUMMARIZE statement.",
      },
    },
    required: ["queries"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const runOne = async (query: string): Promise<string> => {
      const sql = query.trim().replace(/;\s*$/, "");
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
      // Rows as arrays in column order, ready for CSV (the subquery already renames duplicate columns: id, id_1).
      const rows = reader.getRowsJson();
      const shown = rows.slice(0, MAX_ROWS);
      const lines = [reader.columnNames(), ...shown].map((row) => row.map(csvField).join(","));
      lines.push(
        rows.length > MAX_ROWS
          ? `(first ${MAX_ROWS} rows shown; more exist: filter, aggregate or page with LIMIT/OFFSET)`
          : `(${rows.length} ${rows.length === 1 ? "row" : "rows"})`,
      );
      return lines.join("\n");
    };
    const queries = requireStringList(input, "queries");
    return runBatch(queries, runOne, (query, n, error) =>
      error === undefined ? `-- query ${n}: ${query.trim()}` : `-- query ${n} failed: ${error}`,
    );
  },
};
