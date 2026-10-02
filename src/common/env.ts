import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * Loads API keys and settings from the repo's .env file into process.env.
 * Variables already set in the environment win, and blank values are skipped:
 * an empty ANTHROPIC_API_KEY, for example, would otherwise count as set and
 * hide other credential sources.
 */
export function loadEnv(path = join(import.meta.dirname, "..", "..", ".env")): void {
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (value !== "" && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
