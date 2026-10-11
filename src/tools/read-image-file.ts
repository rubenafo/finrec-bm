import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { imageInfo } from "../common/image.js";
import { readXls, XlsError } from "../common/xls.js";
import { resolveEvidence } from "./paths.js";
import { readMsg } from "./read-msg-file.js";
import { requireString, ToolError, type Tool } from "./types.js";

const MAX_BYTES = 5_000_000;
const IMAGE_FILES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** An image found in an evidence file, with where it was found for the output line. */
interface Found {
  name: string;
  where: string;
  data: Buffer;
}

/** Picks the image called `name` among a file's images; without a name, the only one. */
function pick(images: Found[], name: string | undefined, path: string, kind: string): Found {
  if (images.length === 0) throw new ToolError(`"${path}" has no ${kind}s`);
  if (name === undefined) {
    if (images.length === 1) return images[0]!;
    throw new ToolError(`"${path}" has ${images.length} ${kind}s; say which in "image": ${images.map((i) => JSON.stringify(i.name)).join(", ")}`);
  }
  const matches = images.filter((i) => i.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new ToolError(`several ${kind}s in "${path}" are named "${name}"`);
  throw new ToolError(`no ${kind} named "${name}" in "${path}"; its ${kind}s: ${images.map((i) => JSON.stringify(i.name)).join(", ")}`);
}

export const readImageFile: Tool = {
  name: "read_image_file",
  description:
    "View an image for this case: an image file in the evidence folder (.png, .jpg, .gif, .webp), an image attached to " +
    "an Outlook .msg email or shown in its body, or a picture placed over a sheet of an Excel .xls workbook. Returns one " +
    "line saying where the image is from, its format and its size in pixels, followed by the image itself. For an email, " +
    "\"image\" is the attachment's name as read_msg_file lists it; for a workbook, the picture's name as read_xls_file " +
    "lists it. Leave it out when the email or workbook has only one image.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file in the evidence folder, e.g. \"evidence/request.msg\" or \"evidence/review.xls\"." },
      image: { type: "string", description: "For an email or workbook: the name of the attachment or picture, e.g. \"screenshot.png\"." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const path = requireString(input, "path");
    const name = input.image === undefined ? undefined : requireString(input, "image");
    const file = resolveEvidence(ctx.evidenceDir, path);
    const extension = extname(file).toLowerCase();

    let found: Found;
    if (extension === ".msg") {
      const { reader, data } = readMsg(file, path);
      const html = data.html ? Buffer.from(data.html).toString("utf8") : (data.bodyHtml ?? "");
      const images = (data.attachments ?? []).map((attachment) => {
        const { fileName, content } = reader.getAttachment(attachment);
        const attachmentName = fileName ?? attachment.name ?? "unnamed";
        const shown = attachment.pidContentId !== undefined && html.includes(`cid:${attachment.pidContentId}`);
        return { name: attachmentName, where: `attachment "${attachmentName}"${shown ? ", shown in the email's body" : ""}`, data: Buffer.from(content) };
      });
      found = pick(images.filter((i) => imageInfo(i.data)), name, path, "image attachment");
    } else if (extension === ".xls") {
      if (statSync(file).size > 4 * MAX_BYTES) throw new ToolError(`file is larger than ${4 * MAX_BYTES} bytes`);
      let sheets;
      try {
        sheets = readXls(readFileSync(file));
      } catch (err) {
        if (err instanceof XlsError) throw new ToolError(`could not read "${path}": ${err.message}`);
        throw err;
      }
      const pictures = sheets.flatMap((sheet) =>
        sheet.pictures.map((p) => ({ name: p.name, where: `picture "${p.name}" on sheet ${JSON.stringify(sheet.name)} over ${p.from}:${p.to}`, data: p.data })),
      );
      found = pick(pictures, name, path, "picture");
    } else if (IMAGE_FILES.has(extension)) {
      if (name !== undefined) throw new ToolError(`"${path}" is an image file: leave "image" out`);
      if (statSync(file).size > MAX_BYTES) throw new ToolError(`file is larger than ${MAX_BYTES} bytes`);
      found = { name: path, where: "image file", data: readFileSync(file) };
    } else {
      throw new ToolError(`"${path}" is not an image, an email or a workbook`);
    }

    const info = imageInfo(found.data);
    if (!info) throw new ToolError(`"${found.name}" in "${path}" is not a PNG, JPEG, GIF or WebP image`);
    if (found.data.length > MAX_BYTES) throw new ToolError(`image is larger than ${MAX_BYTES} bytes`);
    return {
      text: `${path.trim()}: ${found.where}, ${info.format.toUpperCase()}, ${info.width}x${info.height} pixels`,
      images: [{ format: info.format, data: found.data }],
    };
  },
};
