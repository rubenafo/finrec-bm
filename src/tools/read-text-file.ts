import { readFileSync, statSync } from "node:fs";
import { resolveEvidence } from "./paths.js";
import { requireString, ToolError, type Tool } from "./types.js";

const MAX_BYTES = 200_000;

export const readTextFile: Tool = {
  name: "read_text_file",
  description:
    "Read a plain-text evidence file for this case (for example a transaction list or bank statement in TXT or CSV format). " +
    "Use the path as listed in the task, e.g. evidence/trans.txt.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file in the evidence folder, e.g. \"evidence/trans.txt\"." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const file = resolveEvidence(ctx.evidenceDir, requireString(input, "path"));
    if (statSync(file).size > MAX_BYTES) {
      throw new ToolError(`file is larger than ${MAX_BYTES} bytes`);
    }
    const content = readFileSync(file);
    if (content.includes(0)) {
      throw new ToolError(file.toLowerCase().endsWith(".msg") ? "file is an Outlook email: read it with read_msg_file" : "file is not plain text");
    }
    return content.toString("utf8");
  },
};
