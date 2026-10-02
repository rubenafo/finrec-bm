import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { runAgent } from "../src/common/agent.js";
import { tools, type CaseContext } from "../src/tools/index.js";
import { ScriptedModel } from "./helpers/scripted-model.js";

const tmp = mkdtempSync(join(tmpdir(), "finrec-agent-"));
let ctx: CaseContext & { close(): void };

before(async () => {
  const instance = await DuckDBInstance.create(":memory:");
  const ledger = await instance.connect();
  await ledger.run("CREATE TABLE ledger AS SELECT 'L-001' AS entry_id, 100.00::DECIMAL(18,2) AS amount");
  mkdirSync(join(tmp, "evidence"));
  writeFileSync(join(tmp, "evidence", "bank_statement.csv"), "id,amount\nB-001,100.00\n");
  ctx = {
    test: "t",
    caseId: "c1",
    evidenceDir: join(tmp, "evidence"),
    db: ledger,
    close() {
      ledger.closeSync();
      instance.closeSync();
    },
  };
});

after(() => {
  ctx.close();
  rmSync(tmp, { recursive: true, force: true });
});

const answer = JSON.stringify({ matches: [{ source: ["B-001"], ledger: ["L-001"] }], unmatched: [] });
const allTools = Object.values(tools);

describe("runAgent", () => {
  it("runs tools against the case and returns the final answer", async () => {
    const model = new ScriptedModel([
      { tool: "read_text_file", input: { path: "bank_statement.csv" } },
      { tool: "query_ledger", input: { sql: "SELECT * FROM ledger" } },
      { tool: "read_text_file", input: { path: "../secret.txt" } },
      { text: answer },
    ]);
    const run = await runAgent({ model, systemPrompt: "sys", prompt: "go", tools: allTools, ctx, maxTurns: 10 });

    assert.equal(run.text, answer);
    assert.equal(run.turns, 4);
    assert.equal(run.turnLimitReached, false);
    assert.deepEqual(
      run.toolCalls.map((c) => [c.name, c.error === undefined]),
      [
        ["read_text_file", true],
        ["query_ledger", true],
        ["read_text_file", false],
      ],
    );
    assert.deepEqual(run.usage, { inputTokens: 40, outputTokens: 20 });
  });

  it("stops at maxTurns", async () => {
    const model = new ScriptedModel([{ tool: "query_ledger", input: { sql: "SELECT 1" } }]);
    const run = await runAgent({ model, systemPrompt: "sys", prompt: "go", tools: allTools, ctx, maxTurns: 3 });

    assert.equal(run.turnLimitReached, true);
    assert.equal(run.turns, 3);
    assert.equal(model.calls, 3);
  });
});
