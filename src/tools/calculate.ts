import { ToolError, type Tool } from "./types.js";

const MAX_EXPRESSIONS = 50;
const MAX_LENGTH = 4_000;
/** Decimal places shown for results that have no exact decimal form, such as 1/3. */
const SHOWN_DECIMALS = 12;

/**
 * An exact fraction num/den with den > 0, kept in lowest terms. Amounts are
 * decimals, so floating point would drift (0.1 + 0.2); fractions don't, and
 * division stays exact until the agent rounds.
 */
class Fraction {
  readonly num: bigint;
  readonly den: bigint;
  /**
   * Decimal places to show at least, so amounts keep their cents: a number
   * keeps the places it is written with, round() sets them, and +, -, sum,
   * min and max keep the most of their operands. * and / show exact digits.
   */
  readonly shownPlaces: number;

  constructor(num: bigint, den: bigint = 1n, shownPlaces = 0) {
    if (den === 0n) throw new ToolError("division by zero");
    if (den < 0n) [num, den] = [-num, -den];
    const g = gcd(num < 0n ? -num : num, den);
    this.num = num / g;
    this.den = den / g;
    this.shownPlaces = shownPlaces;
  }

  /** Parses a plain decimal such as 1234.50, .5 or 1.2e6. */
  static parse(text: string): Fraction {
    const [, int = "", frac = "", exp = "0"] = text.match(/^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/)!;
    if (Math.abs(Number(exp)) > 30) throw new ToolError(`exponent of ${text} is out of range (-30 to 30)`);
    const shift = BigInt(exp) - BigInt(frac.length);
    const digits = BigInt(int + frac || "0");
    return shift >= 0n ? new Fraction(digits * 10n ** shift) : new Fraction(digits, 10n ** -shift, Number(-shift));
  }

  add(o: Fraction) { return new Fraction(this.num * o.den + o.num * this.den, this.den * o.den, Math.max(this.shownPlaces, o.shownPlaces)); }
  sub(o: Fraction) { return this.add(o.neg()); }
  mul(o: Fraction) { return new Fraction(this.num * o.num, this.den * o.den); }
  div(o: Fraction) { return new Fraction(this.num * o.den, this.den * o.num); }
  neg() { return new Fraction(-this.num, this.den, this.shownPlaces); }
  abs() { return this.num < 0n ? this.neg() : this; }
  cmp(o: Fraction) { const d = this.num * o.den - o.num * this.den; return d < 0n ? -1 : d > 0n ? 1 : 0; }

  /** Rounds to `places` decimals (negative: to tens, hundreds, ...), halves away from zero. */
  round(places: number): Fraction {
    const scale = 10n ** BigInt(Math.abs(places));
    const [n, d] = places >= 0 ? [this.num * scale, this.den] : [this.num, this.den * scale];
    const abs = n < 0n ? -n : n;
    const q = (2n * abs + d) / (2n * d);
    const rounded = n < 0n ? -q : q;
    return places >= 0 ? new Fraction(rounded, scale, places) : new Fraction(rounded * scale);
  }

  /**
   * Decimal places of the exact decimal form, or undefined when there is none.
   * A fraction in lowest terms has one when den = 2^a * 5^b, with max(a, b) places.
   */
  get places(): number | undefined {
    let [d, twos, fives] = [this.den, 0, 0];
    for (; d % 2n === 0n; twos++) d /= 2n;
    for (; d % 5n === 0n; fives++) d /= 5n;
    return d === 1n ? Math.max(twos, fives) : undefined;
  }

  get terminates(): boolean {
    return this.places !== undefined;
  }

  /** Plain decimal text: exact when it terminates, else rounded to SHOWN_DECIMALS places. */
  toString(): string {
    const places = Math.max(this.places ?? SHOWN_DECIMALS, this.shownPlaces);
    const value = this.round(places);
    const scaled = (value.num * 10n ** BigInt(places)) / value.den;
    const sign = scaled < 0n ? "-" : "";
    const digits = (scaled < 0n ? -scaled : scaled).toString().padStart(places + 1, "0");
    return places === 0 ? sign + digits : `${sign}${digits.slice(0, -places)}.${digits.slice(-places)}`;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

type Token = { kind: "num" | "name" | "op"; text: string; at: number };

function tokenize(source: string): Token[] {
  // A comma between digits with three digits after it, as in 1,250.00, is a
  // thousands separator, not an argument separator: refuse it rather than
  // read sum(1,250.00) as two numbers.
  const separator = source.match(/\d,\d{3}(?!\d)/);
  if (separator) {
    throw new ToolError(
      `"${separator[0]}" looks like a thousands separator: write numbers without them (1250.00), and separate arguments with ", "`,
    );
  }
  const tokens: Token[] = [];
  const pattern = /\s+|(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|([-+*/(),=%])/y;
  while (pattern.lastIndex < source.length) {
    const at = pattern.lastIndex;
    const m = pattern.exec(source);
    if (!m) throw new ToolError(`unexpected "${source[at]}" at position ${at + 1}`);
    if (m[1]) tokens.push({ kind: "num", text: m[1], at });
    else if (m[2]) tokens.push({ kind: "name", text: m[2], at });
    else if (m[3]) tokens.push({ kind: "op", text: m[3], at });
  }
  return tokens;
}

/** The functions an expression may call. */
const functions: Record<string, { usage: string; call(args: Fraction[]): Fraction }> = {
  sum: { usage: "sum(a, b, ...)", call: (args) => args.reduce((s, a) => s.add(a), new Fraction(0n)) },
  round: {
    usage: "round(x) or round(x, places)",
    call: ([x, places, ...rest]) => {
      if (x === undefined || rest.length > 0) throw new ToolError("round takes round(x) or round(x, places)");
      if (places !== undefined && (places.den !== 1n || places.num < -18n || places.num > 18n)) {
        throw new ToolError("round's places must be a whole number from -18 to 18");
      }
      return x.round(places === undefined ? 0 : Number(places.num));
    },
  },
  abs: { usage: "abs(x)", call: (args) => one("abs", args).abs() },
  min: { usage: "min(a, b, ...)", call: (args) => some("min", args).reduce((m, a) => (a.cmp(m) < 0 ? a : m)) },
  max: { usage: "max(a, b, ...)", call: (args) => some("max", args).reduce((m, a) => (a.cmp(m) > 0 ? a : m)) },
};

function one(name: string, args: Fraction[]): Fraction {
  if (args.length !== 1) throw new ToolError(`${name} takes one argument`);
  return args[0]!;
}
function some(name: string, args: Fraction[]): Fraction[] {
  if (args.length === 0) throw new ToolError(`${name} needs at least one argument`);
  return args;
}

/**
 * Evaluates one line, `expression` or `name = expression`, by recursive
 * descent: + and - below * and /, then unary signs, then a postfix %.
 */
function evaluate(source: string, names: Map<string, Fraction>): { name?: string; value: Fraction } {
  const tokens = tokenize(source);
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (text: string) => peek()?.kind === "op" && peek()!.text === text;
  const fail = (what: string): never => {
    const token = peek();
    throw new ToolError(token ? `${what}, found "${token.text}" at position ${token.at + 1}` : `${what} at the end`);
  };
  const expect = (text: string) => (isOp(text) ? i++ : fail(`expected "${text}"`));

  const expression = (): Fraction => {
    let value = term();
    while (isOp("+") || isOp("-")) value = tokens[i++]!.text === "+" ? value.add(term()) : value.sub(term());
    return value;
  };
  const term = (): Fraction => {
    let value = unary();
    while (isOp("*") || isOp("/")) value = tokens[i++]!.text === "*" ? value.mul(unary()) : value.div(unary());
    return value;
  };
  const unary = (): Fraction => {
    if (isOp("-")) return i++, unary().neg();
    if (isOp("+")) return i++, unary();
    let value = primary();
    while (isOp("%")) i++, (value = value.div(new Fraction(100n)));
    return value;
  };
  const primary = (): Fraction => {
    const token = peek();
    if (token?.kind === "num") return i++, Fraction.parse(token.text);
    if (isOp("(")) {
      i++;
      const value = expression();
      expect(")");
      return value;
    }
    if (token?.kind !== "name") return fail("expected a number, a name or \"(\"");
    i++;
    const fn = functions[token.text.toLowerCase()];
    if (!isOp("(")) {
      const value = names.get(token.text);
      if (value === undefined) {
        throw new ToolError(fn ? `call ${fn.usage}` : `unknown name "${token.text}": assign it first in this call, as ${token.text} = ...`);
      }
      return value;
    }
    if (!fn) throw new ToolError(`unknown function "${token.text}": use ${Object.values(functions).map((f) => f.usage).join(", ")}`);
    i++;
    const args: Fraction[] = [];
    if (!isOp(")")) {
      args.push(expression());
      while (isOp(",")) i++, args.push(expression());
    }
    expect(")");
    return fn.call(args);
  };

  let name: string | undefined;
  if (tokens[0]?.kind === "name" && tokens[1]?.kind === "op" && tokens[1].text === "=") {
    name = tokens[0].text;
    if (functions[name.toLowerCase()]) throw new ToolError(`"${name}" is a function name: choose another name`);
    i = 2;
  }
  if (tokens.length === i) fail("expected an expression");
  const value = expression();
  if (i < tokens.length) fail("expected an operator");
  return { name, value };
}

export const calculate: Tool = {
  name: "calculate",
  description:
    "Evaluate arithmetic exactly, with no floating-point error. Use it for arithmetic outside the database (amounts from files or documents, combining query results) and for every division and rounding; sums and products of database amounts can be done exactly in SQL. " +
    "Each expression may use numbers (1250.00, -20700, 1.2e6), + - * /, parentheses, a postfix % (21% is 0.21) and the functions " +
    "sum(a, b, ...), round(x, places) (halves away from zero; places 2 for cents, -3 for thousands, default 0), abs(x), min(...) and max(...). " +
    "Write numbers without thousands separators. An expression can name its result, as `net = 28053.85 / (1 + 21%)`, " +
    "and later expressions in the same call can use that name. Results are exact decimals; a result with no finite decimal form " +
    `(such as 1/3) is shown to ${SHOWN_DECIMALS} places and marked "exact": false until you round it.`,
  inputSchema: {
    type: "object",
    properties: {
      expressions: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_EXPRESSIONS,
        description: "Expressions to evaluate in order, e.g. [\"a = 1111250.00 + 3402118.40\", \"round(a / 1e6, 1)\"].",
      },
    },
    required: ["expressions"],
    additionalProperties: false,
  },
  async run(input) {
    const list = input.expressions;
    if (!Array.isArray(list) || list.length === 0 || list.some((e) => typeof e !== "string" || e.trim() === "")) {
      throw new ToolError('"expressions" must be a non-empty list of non-empty strings');
    }
    if (list.length > MAX_EXPRESSIONS) throw new ToolError(`at most ${MAX_EXPRESSIONS} expressions per call`);
    const names = new Map<string, Fraction>();
    const results = (list as string[]).map((expression, index) => {
      if (expression.length > MAX_LENGTH) throw new ToolError(`expression ${index + 1} is longer than ${MAX_LENGTH} characters`);
      let result;
      try {
        result = evaluate(expression, names);
      } catch (err) {
        if (err instanceof ToolError) throw new ToolError(`expression ${index + 1} (${expression.trim()}): ${err.message}`);
        throw err;
      }
      if (result.name !== undefined) names.set(result.name, result.value);
      return {
        expression: expression.trim(),
        ...(result.name !== undefined && { name: result.name }),
        value: result.value.toString(),
        exact: result.value.terminates,
      };
    });
    return JSON.stringify({ results });
  },
};
