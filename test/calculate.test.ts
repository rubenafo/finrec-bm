import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { outputText, ToolError, tools, type CaseContext } from "../src/tools/index.js";

// calculate touches no case data, so it needs no real context.
const ctx = {} as CaseContext;

type Result = { expression: string; name?: string; value: string; exact: boolean };
const calc = async (...expressions: string[]): Promise<Result[]> =>
  JSON.parse(outputText(await tools.calculate!.run({ expressions }, ctx))).results;
/** The value of the last expression. */
const value = async (...expressions: string[]) => (await calc(...expressions)).at(-1)!.value;

describe("calculate", () => {
  it("follows operator precedence, parentheses, unary signs and postfix %", async () => {
    assert.equal(await value("2 + 3 * 4"), "14");
    assert.equal(await value("(2 + 3) * 4"), "20");
    assert.equal(await value("-2 * -3 - -1"), "7");
    assert.equal(await value("10 - 4 - 3"), "3");
    assert.equal(await value("100 / 4 / 5"), "5");
    assert.equal(await value("1 + 21%"), "1.21");
    assert.equal(await value("1.2e6 + .5"), "1200000.5");
  });

  it("is exact where floating point is not", async () => {
    assert.equal(0.1 + 0.2 === 0.3, false);
    assert.equal(await value("0.1 + 0.2"), "0.3");
    // Floating point stores 1.005 as 1.00499999..., so it rounds to cents the wrong way.
    assert.equal(Math.round(1.005 * 100) / 100, 1);
    assert.equal(await value("round(1.005, 2)"), "1.01");
    assert.equal(await value("2110668.60 * 1.1317"), "2388643.65462");
  });

  it("rounds halves away from zero, to any number of places", async () => {
    assert.equal(await value("round(2.5)"), "3");
    assert.equal(await value("round(-2.5)"), "-3");
    assert.equal(await value("round(1.005, 2)"), "1.01");
    assert.equal(await value("round(-1.005, 2)"), "-1.01");
    assert.equal(await value("round(1580498.11, -3)"), "1580000");
    assert.equal(await value("round(4872315.60 / 1e6, 1)"), "4.9");
  });

  it("keeps the places amounts are written or rounded with through +, - and sum", async () => {
    assert.equal(await value("1511516.50"), "1511516.50");
    assert.equal(await value("18400.00 + 30000.00"), "48400.00");
    assert.equal(await value("sum(412300, 538120.50, 297480.25, 263615.75)"), "1511516.50");
    assert.equal(await value("53840.75 - 51315.70"), "2525.05");
    assert.equal(await value("-20700.00"), "-20700.00");
    assert.equal(await value("round(1511516.5, 2)"), "1511516.50");
    assert.equal(await value("round(48408, 2)"), "48408.00");
    assert.equal(await value("1.5 * 2.0"), "3", "* and / show exact digits only");
    assert.equal(await value("10.00 / 4"), "2.5");
    assert.equal(await value("round(2.50)"), "3");
  });

  it("marks results with no finite decimal form until they are rounded", async () => {
    const [third, rounded] = await calc("x = 1 / 3", "round(x, 2)");
    assert.deepEqual(third, { expression: "x = 1 / 3", name: "x", value: "0.333333333333", exact: false });
    assert.deepEqual(rounded, { expression: "round(x, 2)", value: "0.33", exact: true });
    assert.equal(await value("1 / 3 * 3"), "1", "fractions stay exact between steps");
  });

  it("offers sum, abs, min and max", async () => {
    assert.equal(await value("sum(18400, 30000, 1240.75, 4200)"), "53840.75");
    assert.equal(await value("sum()"), "0");
    assert.equal(await value("abs(-20700)"), "20700");
    assert.equal(await value("min(3, -1, 2)"), "-1");
    assert.equal(await value("max(3, -1, 2)"), "3");
    assert.equal(await value("ROUND(2.5)"), "3", "function names ignore case");
  });

  it("lets later expressions use earlier named results", async () => {
    const results = await calc("pos = 53840.75", "liab = 51315.70", "pos - liab");
    assert.deepEqual(results.map((r) => [r.name, r.value]), [["pos", "53840.75"], ["liab", "51315.70"], [undefined, "2525.05"]]);
  });

  it("reads hexadecimal integers, in either case, exactly and alongside decimals", async () => {
    assert.equal(await value("0x5D62"), "23906");
    assert.equal(await value("0x5d62 + 0X4530"), "41618");
    assert.equal(await value("0xFF * 1.50"), "382.5");
    assert.equal(await value("-0x10 + 0.25"), "-15.75");
    assert.equal(await value("0x1FFFFFFFFFFFFF + 2"), "9007199254740993", "past 2^53, still exact");
  });

  it("refuses thousands separators instead of reading them as arguments", async () => {
    await assert.rejects(tools.calculate!.run({ expressions: ["sum(1,111,250.00)"] }, ctx), /thousands separator/);
    await assert.rejects(tools.calculate!.run({ expressions: ["1,250.00 + 1"] }, ctx), /thousands separator/);
    assert.equal(await value("sum(1, 111, 250.00)"), "362.00", "arguments separated by \", \" are fine");
    assert.equal(await value("max(1000,2000)"), "2000");
  });

  it("reports mistakes as tool errors, naming the expression", async () => {
    const fails = (expressions: unknown, message: RegExp) =>
      assert.rejects(tools.calculate!.run({ expressions }, ctx), (err: unknown) => err instanceof ToolError && message.test(err.message));
    await fails(["1 / (2 - 2)"], /division by zero/);
    await fails(["1 +"], /expression 1 \(1 \+\): expected a number, a name or "\(" at the end/);
    await fails(["(1 + 2"], /expected "\)"/);
    await fails(["1 2"], /expected an operator, found "2"/);
    await fails(["1 $ 2"], /unexpected "\$"/);
    await fails(["2", "total * 2"], /expression 2 .*unknown name "total"/);
    await fails(["sqrt(4)"], /unknown function "sqrt"/);
    await fails(["round(1.5, 0.5)"], /whole number/);
    await fails(["round(1, 2, 3)"], /round\(x\) or round\(x, places\)/);
    await fails(["sum = 1"], /function name/);
    await fails(["min()"], /at least one argument/);
    await fails(["1e99"], /out of range/);
    await fails(["0x"], /expected an operator, found "x"/);
    await fails(["0x1G"], /expected an operator, found "G"/);
    await fails(["0x5D62.5"], /expected an operator, found "\.5"/);
    await fails([], /non-empty list/);
    await fails("1 + 1", /non-empty list/);
    await fails([" "], /non-empty list/);
  });
});

/**
 * Every case's reported value, worked out from the amounts and rates its
 * meta.json notes name, with calculate alone: the arithmetic the cases need.
 */
describe("calculate covers the arithmetic of every case", () => {
  const cases: [string, string[], string][] = [
    ["csv-matching case-01: a sum", ["sum(412300, 538120.50, 297480.25, 263615.75)"], "1511516.50"],
    ["csv-matching case-02: reversal, invoice and days x rate", ["22425.00 - 20700.00 + 17.0 * 1250"], "22975.00"],
    ["csv-matching case-03: a sum", ["sum(213750.50, 98400.00, 172600.25, 74150.00, 241200.00, 56980.75)"], "857081.50"],
    [
      "csv-matching case-04: running balance, then EOM translation to cents",
      ["eur = 2014750.50 + 318400.25 - 146270.00 + 220155.75 - 185.40 - 400000.00 + 173300.00 - 69482.50", "round(eur * 1.1317, 2)"],
      "2388643.65",
    ],
    [
      "csv-matching case-05: VAT removed per invoice",
      ["sum(round(28053.85 / (1 + 21%), 2), round(15750.00 / (1 + 0%), 2), round(11462.33 / (1 + 21%), 2))"],
      "48408.00",
    ],
    ["csv-matching case-06: FTE share, rounded to cents", ["round(sum(192750.40, 188400.25, 201125.75) * 29.0 / 113.0, 2)"], "149433.77"],
    [
      "csv-matching case-07: AVG conversion, rounded once to thousands",
      [
        "usd = sum(212345.60 * 1.1131, 384579.20 * 1.1131, 64382.50 * 1.2803, 156499.00, 118260.40 * 1.2856, " +
          "74621.80 * 1.1187, 265194.40 * 1.1248, 87512.30, 43476.60 * 1.2838)",
        "round(usd, 2)",
        "round(usd / 1000)",
      ],
      "1580",
    ],
    [
      "csv-matching case-08: consolidation at AVG rates",
      [
        "round(sum(4215300, 1184250 * 1.2614, 932480.50 * 1.0862, 1876940.25, 1407615 * 1.0889, 3962118.40, " +
          "845300.75 * 1.2667, 1120060 * 1.0897, -612500, -96400 * 1.2667), 2)",
      ],
      "15650445.85",
    ],
    [
      "csv-matching case-09: positive flows minus liabilities",
      ["sum(18400.00, 30000.00, 1240.75, 4200.00) - sum(18400.00, 22750.50, 350.00, 9815.20)"],
      "2525.05",
    ],
    ["txt-matching case-01: Coho Vineyard", ["1111250.00 + 3402118.40"], "4513368.40"],
    ["txt-matching case-01: Adventure Works in millions", ["round(4872315.60 / 1e6, 1)"], "4.9"],
    [
      "txt-matching case-02: monthly EUR/USD rates",
      ["round(1284600.00 * 1.1612 + 642310.55 + 2105480.30 * 1.1734 + 2650000.00 * 1.1689 + 318940.20, 2)"],
      "8021083.85",
    ],
    ["xls-matching case-01: Fabrikam Industrial in Q2", ["sum(8240.00, 15600.00, 9875.25, 22740.25)"], "56455.50"],
    ["xls-matching case-02: two hexadecimal figures", ["0x5D62 + 0x4530"], "41618"],
    [
      "xls-matching case-03: the ledger's eight August payments, not the sheet's nine rows",
      ["sum(3420.00, 1275.90, 12600.00, 4812.60, 8940.00, 15300.00, 2189.50, 10599.80)"],
      "59137.80",
    ],
  ];
  for (const [title, expressions, expected] of cases) {
    it(title, async () => assert.equal(await value(...expressions), expected));
  }

  it("csv-matching case-07: the unrounded total and the total in cents", async () => {
    const [usd, cents] = await calc(
      "usd = sum(212345.60 * 1.1131, 384579.20 * 1.1131, 64382.50 * 1.2803, 156499.00, 118260.40 * 1.2856, " +
        "74621.80 * 1.1187, 265194.40 * 1.1248, 87512.30, 43476.60 * 1.2838)",
      "round(usd, 2)",
    );
    assert.equal(usd!.exact, true);
    assert.equal(cents!.value, "1580498.11");
  });
});
