import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildMsg, type MsgSource } from "../scripts/msg-writer.js";
import { buildScreenshot, screenshotSvg, type ScreenshotSource } from "../scripts/screenshot-writer.js";
import { buildXls, type XlsSource } from "../scripts/xls-writer.js";
import { imageInfo } from "../src/common/image.js";
import { readXls } from "../src/common/xls.js";
import { outputText, tools, type CaseContext, type ToolOutput } from "../src/tools/index.js";

const sheet: ScreenshotSource = {
  tabs: ["data", "notes"],
  sheet: {
    name: "data",
    widths: [12, 10],
    rows: [["A long title that runs over the empty cells to its right"], [], [{ text: "Amount", fill: "grey" }, { number: 1234.5, format: "amount", fill: "yellow" }]],
  },
  view: { firstRow: 1, lastRow: 4, lastColumn: "D" },
};
const small = buildScreenshot({ sheet: { name: "s", rows: [["small"]] } });
const big = buildScreenshot(sheet);
const files: Record<string, Buffer> = { "images/small.png": small, "images/big.png": big, "notes.txt": Buffer.from("not an image") };
const load = (file: string) => files[file] ?? assert.fail(`no file ${file}`);
const imageOf = (output: ToolOutput) => (typeof output === "string" ? assert.fail("no image") : output.images.map((i) => i.data));

describe("screenshot writer", () => {
  it("draws the view at 1.5 times its size in pixels, the same bytes every time", () => {
    const { width, height } = screenshotSvg(sheet);
    assert.deepEqual(imageInfo(big), { format: "png", width: Math.round(width * 1.5), height: Math.round(height * 1.5) });
    assert.ok(buildScreenshot(sheet).equals(big));
  });

  it("shows row numbers from the view's first row, column letters, the tabs, numbers in their format and fills", () => {
    const { svg } = screenshotSvg({ ...sheet, view: { firstRow: 3, lastRow: 3, lastColumn: "B" } });
    const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    assert.deepEqual(texts, ["Amount", "1,234.50", "A", "B", "3", "data", "notes"]);
    assert.match(svg, /fill="#FFFF00"/);
    assert.match(svg, /fill="#C0C0C0"/);
  });

  it("lets text run over the empty cells to its right, as far as the view goes", () => {
    const { svg } = screenshotSvg(sheet);
    const clip = svg.match(/<clipPath id="c1-0"><rect x="(\d+)" y="\d+" width="(\d+)"/)!;
    assert.equal(Number(clip[2]), screenshotSvg(sheet).width - Number(clip[1]));
  });

  it("rejects a number its column is too narrow for, and a sheet that isn't one of the tabs", () => {
    assert.throws(() => buildScreenshot({ sheet: { name: "s", widths: [5], rows: [[{ number: 1234567.89, format: "amount" }]] } }), /s!A1: "1,234,567.89" doesn't fit/);
    assert.throws(() => buildScreenshot({ tabs: ["other"], sheet: { name: "s", rows: [] } }), /not one of the tabs/);
  });
});

describe("imageInfo", () => {
  it("recognises PNG, GIF, JPEG and WebP images with their size, and nothing else", () => {
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([0x40, 0x01, 0xf0, 0x00])]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x78, 0x00, 0xa0, 0x03]);
    const webp = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8X"), Buffer.alloc(8), Buffer.from([0x3f, 0x01, 0x00, 0xc7, 0x00, 0x00])]);
    assert.deepEqual(imageInfo(gif), { format: "gif", width: 320, height: 240 });
    assert.deepEqual(imageInfo(jpeg), { format: "jpeg", width: 160, height: 120 });
    assert.deepEqual(imageInfo(webp), { format: "webp", width: 320, height: 200 });
    assert.equal(imageInfo(Buffer.from("not an image")), undefined);
  });
});

describe("images in emails, workbooks and files", () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), "finrec-img-"));
  const ctx = { test: "t", caseId: "case-01", evidenceDir, db: null as never } satisfies CaseContext;
  const run = (name: string, input: Record<string, unknown>) => tools[name]!.run(input, ctx);
  const email: MsgSource = {
    from: { name: "A", email: "a@x.example" },
    to: [{ name: "B", email: "b@x.example" }],
    sent: "2025-07-21T10:35:00+02:00",
    subject: "Screenshots",
    body: ["See below.", "[cid:shot.png]"],
    html: ["<p>See below.</p>", '<p><img src="cid:shot.png"></p>'],
    attachments: [{ file: "images/big.png", name: "shot.png", inline: true }, { file: "images/small.png" }, { file: "notes.txt" }],
  };
  const workbook: XlsSource = {
    sheets: [
      { name: "sign-off", widths: [20, 10], rows: [["see the pictures"]], pictures: [{ name: "first.png", file: "images/big.png", at: "B3", scale: 0.5, description: "net cash" }, { name: "second", file: "images/small.png", at: "B30" }] },
      { name: "plain", rows: [[1]] },
      { name: "more", rows: [], pictures: [{ name: "third", file: "images/small.png", at: "C2" }] },
    ],
  };

  before(() => {
    writeFileSync(join(evidenceDir, "mail.msg"), buildMsg(email, load));
    writeFileSync(join(evidenceDir, "book.xls"), buildXls(workbook, load));
    writeFileSync(join(evidenceDir, "shot.png"), big);
    writeFileSync(join(evidenceDir, "notes.txt"), "not an image");
  });
  after(() => rmSync(evidenceDir, { recursive: true, force: true }));

  it("an email keeps its HTML body and attachments; read_msg_file marks the images and which the body shows", async () => {
    const read = JSON.parse(outputText(await run("read_msg_file", { path: "evidence/mail.msg" })));
    assert.equal(read.body, "See below.\r\n[cid:shot.png]");
    assert.equal(read.html, '<p>See below.</p>\r\n<p><img src="cid:shot.png"></p>');
    const info = (png: Buffer) => `PNG, ${imageInfo(png)!.width}x${imageInfo(png)!.height} pixels`;
    assert.deepEqual(read.attachments, [
      { name: "shot.png", size: big.length, image: info(big), shown_in_body: true },
      { name: "small.png", size: small.length, image: info(small) },
      { name: "notes.txt", size: 12, content: "not an image" },
    ]);
  });

  it("buildMsg rejects an inline image the HTML body doesn't show, two attachments with one name, and attachments it can't read", () => {
    assert.throws(() => buildMsg({ ...email, html: ["<p>none</p>"] }, load), /inline attachment "shot.png" isn't shown/);
    assert.throws(() => buildMsg({ ...email, attachments: [{ file: "images/big.png" }, { file: "images/big.png" }] }, load), /same name/);
    assert.throws(() => buildMsg(email), /no way to read attachment files/);
  });

  it("a workbook's pictures round-trip with their names, alt text, the cells they cover and their image, on each sheet", () => {
    const sheets = readXls(buildXls(workbook, load));
    assert.deepEqual(
      sheets.map((s) => [s.name, s.pictures.map((p) => [p.name, p.description, p.from, p.format, p.data.equals(p.name === "first.png" ? big : small)])]),
      [
        ["sign-off", [["first.png", "net cash", "B3", "png", true], ["second", undefined, "B30", "png", true]]],
        ["plain", []],
        ["more", [["third", undefined, "C2", "png", true]]],
      ],
    );
    assert.equal(sheets[0]!.cells.length, 1, "cells are read as before");
    assert.ok(big.length > 8224, "a picture longer than one record, which runs into CONTINUE records");
  });

  it("a picture covers the cells its size in pixels reaches, at Excel's default sizes", () => {
    // 100 x 40 pixels from A1: columns of 64 pixels and rows of 17 pixels.
    const png = Buffer.from(small);
    png.writeUInt32BE(100, 16);
    png.writeUInt32BE(40, 20);
    const [s] = readXls(buildXls({ sheets: [{ name: "s", rows: [], pictures: [{ name: "p", file: "p", at: "A1" }] }] }, () => png));
    assert.deepEqual([s!.pictures[0]!.from, s!.pictures[0]!.to], ["A1", "B3"]);
  });

  it("buildXls rejects a picture that isn't a PNG, two pictures with one name on a sheet, and pictures it can't read", () => {
    const one = (pictures: XlsSource["sheets"][0]["pictures"]) => ({ sheets: [{ name: "s", rows: [], pictures }] });
    assert.throws(() => buildXls(one([{ name: "p", file: "notes.txt", at: "A1" }]), load), /s: picture "p": not a PNG/);
    assert.throws(() => buildXls(one([{ name: "p", file: "images/small.png", at: "A1" }, { name: "P", file: "images/small.png", at: "A9" }]), load), /same name/);
    assert.throws(() => buildXls(one([{ name: "p", file: "images/small.png", at: "A1" }])), /no way to read picture files/);
  });

  it("read_xls_file lists each sheet's pictures after its cells", async () => {
    const text = outputText(await run("read_xls_file", { path: "evidence/book.xls" }));
    const size = `${imageInfo(big)!.width}x${imageInfo(big)!.height}`;
    assert.match(text, new RegExp(`=== sheet "sign-off"\\nrow 1: A1="see the pictures"\\npicture "first.png" over B3:\\w+\\d+, PNG ${size} pixels, alt text "net cash"\\npicture "second" over B30:`));
    assert.match(text, /=== sheet "more"\npicture "third" over C2:/);
  });

  it("read_image_file returns an image from a file, an email or a workbook, with a line saying where it is from", async () => {
    const cases: [Record<string, unknown>, Buffer, RegExp][] = [
      [{ path: "evidence/shot.png" }, big, /^evidence\/shot\.png: image file, PNG, \d+x\d+ pixels$/],
      [{ path: "evidence/mail.msg", image: "shot.png" }, big, /^evidence\/mail\.msg: attachment "shot\.png", shown in the email's body, PNG/],
      [{ path: "evidence/mail.msg", image: "SMALL.PNG" }, small, /^evidence\/mail\.msg: attachment "small\.png", PNG/],
      [{ path: "evidence/book.xls", image: "first.png" }, big, /^evidence\/book\.xls: picture "first\.png" on sheet "sign-off" over B3:/],
      [{ path: "evidence/book.xls", image: "third" }, small, /^evidence\/book\.xls: picture "third" on sheet "more" over C2:/],
    ];
    for (const [input, image, line] of cases) {
      const output = await run("read_image_file", input);
      assert.match(outputText(output), line, JSON.stringify(input));
      assert.deepEqual(imageOf(output), [image], JSON.stringify(input));
    }
  });

  it("read_image_file needs a name when there are several images, and says which there are", async () => {
    await assert.rejects(run("read_image_file", { path: "evidence/mail.msg" }), /has 2 image attachments; say which in "image": "shot.png", "small.png"/);
    await assert.rejects(run("read_image_file", { path: "evidence/book.xls", image: "fourth" }), /no picture named "fourth".*"first.png", "second", "third"/);
    await assert.rejects(run("read_image_file", { path: "evidence/mail.msg", image: "notes.txt" }), /no image attachment named "notes.txt"/);
    await assert.rejects(run("read_image_file", { path: "evidence/shot.png", image: "x" }), /is an image file: leave "image" out/);
    await assert.rejects(run("read_image_file", { path: "evidence/notes.txt" }), /not an image, an email or a workbook/);
    await assert.rejects(run("read_image_file", { path: "../shot.png" }), /outside the case's evidence folder/);
  });

  it("read_text_file points to read_image_file for an image", async () => {
    await assert.rejects(run("read_text_file", { paths: ["evidence/shot.png"] }), /file is an image: view it with read_image_file/);
  });
});
