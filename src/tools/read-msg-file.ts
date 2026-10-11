import msgreader from "@kenjiuno/msgreader";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { imageInfo } from "../common/image.js";
import { resolveEvidence } from "./paths.js";
import { requireString, ToolError, type Tool } from "./types.js";

// The package is CommonJS; under ESM its class is on `.default`.
const MsgReader = msgreader.default;

/** Attachments with these extensions are decoded and returned inline. */
const TEXT_ATTACHMENTS = new Set([".txt", ".csv", ".tsv", ".json", ".xml", ".html", ".htm"]);
const MAX_ATTACHMENT_BYTES = 100_000;

/** Parses a .msg file; `path` is how the agent named it, for errors. */
export function readMsg(file: string, path: string) {
  if (extname(file).toLowerCase() !== ".msg") {
    throw new ToolError(`"${path}" is not a .msg file`);
  }
  const buffer = readFileSync(file);
  const reader = new MsgReader(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const data = reader.getFileData();
  if (data.error) {
    throw new ToolError(`could not parse "${path}": ${data.error}`);
  }
  return { reader, data };
}

export const readMsgFile: Tool = {
  name: "read_msg_file",
  description:
    "Read an Outlook .msg email for this case (for example a remittance advice or a customer query). " +
    "Returns sender, recipients, dates, subject, body and attachments as JSON; an email written in HTML also has its HTML body. " +
    "Text attachments (txt, csv, json, xml, html) are included inline; other attachments are listed by name and size only. " +
    "Images, attached or shown in the HTML body (<img src=\"cid:...\">), are marked as such: view them with read_image_file.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file in the evidence folder, e.g. \"evidence/emails/remittance-01.msg\"." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const path = requireString(input, "path");
    const { reader, data } = readMsg(resolveEvidence(ctx.evidenceDir, path), path);
    const html = data.html ? Buffer.from(data.html).toString("utf8") : data.bodyHtml;

    const attachments = (data.attachments ?? []).map((attachment) => {
      const { fileName, content } = reader.getAttachment(attachment);
      const name = fileName ?? attachment.name ?? "unnamed";
      const result: { name: string; size: number; image?: string; shown_in_body?: boolean; content?: string } = { name, size: content.length };
      const image = imageInfo(Buffer.from(content));
      if (image) {
        result.image = `${image.format.toUpperCase()}, ${image.width}x${image.height} pixels`;
        if (attachment.pidContentId !== undefined && html?.includes(`cid:${attachment.pidContentId}`)) result.shown_in_body = true;
      } else if (TEXT_ATTACHMENTS.has(extname(name).toLowerCase()) && content.length <= MAX_ATTACHMENT_BYTES) {
        result.content = Buffer.from(content).toString("utf8");
      }
      return result;
    });

    return JSON.stringify({
      from: { name: data.senderName, email: data.senderSmtpAddress ?? data.senderEmail },
      recipients: (data.recipients ?? []).map((r) => ({
        type: r.recipType ?? "to",
        name: r.name,
        email: r.smtpAddress ?? r.email,
      })),
      sent: data.clientSubmitTime,
      received: data.messageDeliveryTime,
      subject: data.subject,
      body: data.body,
      ...(html !== undefined && { html }),
      attachments,
    });
  },
};
