/**
 * Selects names by a pattern: the name itself if one matches exactly,
 * otherwise every name the pattern matches as a case-insensitive regular
 * expression, in the given order. Throws on an invalid regular expression.
 */
export function matchNames(pattern: string, names: readonly string[]): string[] {
  if (names.includes(pattern)) return [pattern];
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch (err) {
    throw new Error(`invalid pattern "${pattern}": ${err instanceof Error ? err.message : err}`);
  }
  return names.filter((name) => regex.test(name));
}
