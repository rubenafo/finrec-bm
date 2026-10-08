import { readFileSync, statSync } from "node:fs";
import { resolveEvidence } from "./paths.js";
import { MAX_BATCH, requireStringList, runBatch, ToolError, type Tool } from "./types.js";

const MAX_BYTES = 200_000;

export const readTextFile: Tool = {
  name: "read_text_file",
  description:
    "Read plain-text evidence files for this case (for example a transaction list or bank statement in TXT or CSV format). " +
    "Use the paths as listed in the task, e.g. evidence/trans.txt. " +
    `Pass up to ${MAX_BATCH} files in one call; with several, each file follows a "=== <path>" line, ` +
    "and a file that can't be read is reported in place without stopping the others.",
  inputSchema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_BATCH,
        description: "Paths of the files in the evidence folder, e.g. [\"evidence/trans.txt\"].",
      },
    },
    required: ["paths"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const readOne = async (path: string): Promise<string> => {
      const file = resolveEvidence(ctx.evidenceDir, path);
      if (statSync(file).size > MAX_BYTES) {
        throw new ToolError(`file is larger than ${MAX_BYTES} bytes`);
      }
      const content = readFileSync(file);
      if (content.includes(0)) {
        const lower = file.toLowerCase();
        if (lower.endsWith(".msg")) throw new ToolError("file is an Outlook email: read it with read_msg_file");
        if (lower.endsWith(".xls")) throw new ToolError("file is an Excel workbook: read it with read_xls_file");
        throw new ToolError("file is not plain text");
      }
      return content.toString("utf8");
    };
    const paths = requireStringList(input, "paths");
    return runBatch(paths, readOne, (path, _n, error) =>
      error === undefined ? `=== ${path.trim()}` : `=== ${path.trim()} failed: ${error}`,
    );
  },
};
