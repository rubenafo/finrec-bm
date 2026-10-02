import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ToolError } from "./types.js";

/**
 * Resolves a path given by the agent against the case's evidence folder and
 * rejects anything that points outside it. Paths may start with `evidence/`,
 * as the prompt lists them, or be relative to the folder itself.
 */
export function resolveEvidence(evidenceDir: string, path: string): string {
  const full = resolve(evidenceDir, path.replace(/^(\.[\\/])?evidence[\\/]/, ""));
  const rel = relative(evidenceDir, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ToolError(`"${path}" is outside the case's evidence folder`);
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    throw new ToolError(`file not found: "${path}"`);
  }
  return full;
}

/** Lists every file under the evidence folder as forward-slash relative paths. */
export function listEvidence(evidenceDir: string): string[] {
  if (!existsSync(evidenceDir)) return [];
  return readdirSync(evidenceDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(evidenceDir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}
