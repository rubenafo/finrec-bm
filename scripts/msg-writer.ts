// Writes Outlook .msg files (MS-OXMSG) for benchmark evidence: a Compound
// File Binary container holding the message's MAPI properties. Covers what
// case emails need: sender, To/Cc recipients, sent and received times,
// subject, a plain-text body and optionally an HTML one, and attached files,
// such as screenshots shown inline in the HTML body or attached as usual.

import CFB from "cfb";

/** An email to write: its headers, bodies and attachments. */
export interface MsgSource {
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  cc?: { name: string; email: string }[];
  /** ISO 8601 with offset, e.g. 2025-07-08T16:05:00+02:00. */
  sent: string;
  subject: string;
  /** Plain text; lines joined with "\n". With `html`, the plain-text version Outlook keeps alongside it. */
  body: string[];
  /** HTML body; lines joined with "\n". An inline attachment is shown with <img src="cid:<its name>">. */
  html?: string[];
  attachments?: MsgAttachment[];
}

/** A file attached to an email. */
export interface MsgAttachment {
  /** Path of the file, relative to the case folder, e.g. evidence/screenshot.png. */
  file: string;
  /** File name in the email; default: the file's own name. */
  name?: string;
  /** Shown in the HTML body, which refers to it as cid:<name>, rather than listed with the attachments. */
  inline?: boolean;
}

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
};

// MAPI property types.
const PT_LONG = 0x0003;
const PT_BOOLEAN = 0x000b;
const PT_UNICODE = 0x001f;
const PT_SYSTIME = 0x0040;
const PT_BINARY = 0x0102;

type Prop =
  | { id: number; type: typeof PT_LONG; value: number }
  | { id: number; type: typeof PT_BOOLEAN; value: boolean }
  | { id: number; type: typeof PT_UNICODE; value: string }
  | { id: number; type: typeof PT_SYSTIME; value: Date }
  | { id: number; type: typeof PT_BINARY; value: Buffer };

const long = (id: number, value: number): Prop => ({ id, type: PT_LONG, value });
const bool = (id: number, value: boolean): Prop => ({ id, type: PT_BOOLEAN, value });
const text = (id: number, value: string): Prop => ({ id, type: PT_UNICODE, value });
const time = (id: number, value: Date): Prop => ({ id, type: PT_SYSTIME, value });
const binary = (id: number, value: Buffer): Prop => ({ id, type: PT_BINARY, value });

/** PROPATTR_READABLE | PROPATTR_WRITABLE */
const FLAGS = 0x6;
/** 100 ns intervals between 1601-01-01 and 1970-01-01. */
const FILETIME_EPOCH = 116_444_736_000_000_000n;

const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, "0");
const streamName = (p: Prop) => `__substg1.0_${hex(p.id, 4)}${hex(p.type, 4)}`;

/**
 * Adds a property object to `dir` (the root, or a recipient or attachment
 * storage): a `__properties_version1.0` stream with fixed-size values inline
 * and the size of each string or binary value, whose content (UTF-16LE for a
 * string) goes in its own `__substg1.0_` stream.
 */
function addProps(cfb: CFB.CFB$Container, dir: string, header: Buffer, props: Prop[]) {
  const entries = Buffer.alloc(16 * props.length);
  props.forEach((p, i) => {
    const at = 16 * i;
    entries.writeUInt32LE(((p.id << 16) | p.type) >>> 0, at);
    entries.writeUInt32LE(FLAGS, at + 4);
    if (p.type === PT_LONG) entries.writeInt32LE(p.value, at + 8);
    else if (p.type === PT_BOOLEAN) entries.writeUInt16LE(p.value ? 1 : 0, at + 8);
    else if (p.type === PT_SYSTIME) entries.writeBigUInt64LE(BigInt(p.value.getTime()) * 10_000n + FILETIME_EPOCH, at + 8);
    else if (p.type === PT_BINARY) {
      entries.writeUInt32LE(p.value.length, at + 8);
      CFB.utils.cfb_add(cfb, `${dir}/${streamName(p)}`, p.value);
    } else {
      const content = Buffer.from(p.value, "utf16le");
      // A string's size counts its terminating null, which the stream leaves out.
      entries.writeUInt32LE(content.length + 2, at + 8);
      CFB.utils.cfb_add(cfb, `${dir}/${streamName(p)}`, content);
    }
  });
  CFB.utils.cfb_add(cfb, `${dir}/__properties_version1.0`, Buffer.concat([header, entries]));
}

/**
 * Builds the .msg file for an email. `load` reads an attachment's file, given
 * its `file` path; it is needed only when the email has attachments.
 */
export function buildMsg(source: MsgSource, load?: (file: string) => Buffer): Buffer {
  const sent = new Date(source.sent);
  if (Number.isNaN(sent.getTime())) throw new Error(`invalid sent time "${source.sent}"`);
  const recipients = [
    ...source.to.map((r) => ({ ...r, type: 1 })),
    ...(source.cc ?? []).map((r) => ({ ...r, type: 2 })),
  ];
  const display = (type: number) => recipients.filter((r) => r.type === type).map((r) => r.name).join("; ");
  const attachments = (source.attachments ?? []).map((a) => {
    if (!load) throw new Error(`attachment "${a.file}": no way to read attachment files was given`);
    const name = a.name ?? a.file.split(/[\\/]/).pop()!;
    if (a.inline && !source.html?.some((line) => line.includes(`cid:${name}`))) {
      throw new Error(`inline attachment "${name}" isn't shown in the HTML body as cid:${name}`);
    }
    const dot = name.lastIndexOf(".");
    return { name, inline: a.inline === true, extension: dot < 0 ? "" : name.slice(dot).toLowerCase(), data: load(a.file) };
  });
  if (new Set(attachments.map((a) => a.name.toLowerCase())).size !== attachments.length) throw new Error("two attachments have the same name");

  const cfb = CFB.utils.cfb_new();
  // Top-level header: 8 reserved bytes, next recipient ID, next attachment ID,
  // recipient count, attachment count, 8 reserved bytes.
  const header = Buffer.alloc(32);
  header.writeUInt32LE(recipients.length, 8);
  header.writeUInt32LE(attachments.length, 12);
  header.writeUInt32LE(recipients.length, 16);
  header.writeUInt32LE(attachments.length, 20);
  addProps(cfb, "", header, [
    text(0x001a, "IPM.Note"), // PR_MESSAGE_CLASS
    text(0x0037, source.subject), // PR_SUBJECT
    text(0x0e1d, source.subject), // PR_NORMALIZED_SUBJECT
    text(0x1000, source.body.join("\r\n")), // PR_BODY
    text(0x0c1a, source.from.name), // PR_SENDER_NAME
    text(0x0c1e, "SMTP"), // PR_SENDER_ADDRTYPE
    text(0x0c1f, source.from.email), // PR_SENDER_EMAIL_ADDRESS
    text(0x5d01, source.from.email), // PR_SENDER_SMTP_ADDRESS
    text(0x0042, source.from.name), // PR_SENT_REPRESENTING_NAME
    text(0x0064, "SMTP"), // PR_SENT_REPRESENTING_ADDRTYPE
    text(0x0065, source.from.email), // PR_SENT_REPRESENTING_EMAIL_ADDRESS
    text(0x0e04, display(1)), // PR_DISPLAY_TO
    text(0x0e03, display(2)), // PR_DISPLAY_CC
    time(0x0039, sent), // PR_CLIENT_SUBMIT_TIME
    time(0x0e06, sent), // PR_MESSAGE_DELIVERY_TIME
    long(0x0e07, attachments.length > 0 ? 0x11 : 0x01), // PR_MESSAGE_FLAGS: read, and has attachments
    ...(source.html === undefined
      ? []
      : [
          binary(0x1013, Buffer.from(source.html.join("\r\n"), "utf8")), // PR_HTML
          long(0x3fde, 65001), // PR_INTERNET_CPID: the HTML is UTF-8
        ]),
    ...(attachments.length > 0 ? [bool(0x0e1b, true)] : []), // PR_HASATTACH
  ]);

  recipients.forEach((r, i) => {
    addProps(cfb, `/__recip_version1.0_#${hex(i, 8)}`, Buffer.alloc(8), [
      text(0x3001, r.name), // PR_DISPLAY_NAME
      text(0x3002, "SMTP"), // PR_ADDRTYPE
      text(0x3003, r.email), // PR_EMAIL_ADDRESS
      text(0x39fe, r.email), // PR_SMTP_ADDRESS
      text(0x5ff6, r.name), // PR_RECIPIENT_DISPLAY_NAME
      long(0x0c15, r.type), // PR_RECIPIENT_TYPE: 1 To, 2 Cc
      long(0x3000, i), // PR_ROWID
    ]);
  });

  attachments.forEach((a, i) => {
    addProps(cfb, `/__attach_version1.0_#${hex(i, 8)}`, Buffer.alloc(8), [
      long(0x0ffe, 7), // PR_OBJECT_TYPE: attachment
      long(0x0e21, i), // PR_ATTACH_NUM
      long(0x3705, 1), // PR_ATTACH_METHOD: by value
      binary(0x3701, a.data), // PR_ATTACH_DATA_BIN
      text(0x3001, a.name), // PR_DISPLAY_NAME
      text(0x3704, a.name), // PR_ATTACH_FILENAME
      text(0x3707, a.name), // PR_ATTACH_LONG_FILENAME
      text(0x3703, a.extension), // PR_ATTACH_EXTENSION
      text(0x370e, MIME_TYPES[a.extension] ?? "application/octet-stream"), // PR_ATTACH_MIME_TAG
      long(0x0e20, a.data.length), // PR_ATTACH_SIZE
      long(0x370b, -1), // PR_RENDERING_POSITION: none
      ...(a.inline
        ? [
            text(0x3712, a.name), // PR_ATTACH_CONTENT_ID: what the HTML body's cid: refers to
            long(0x3714, 0x4), // PR_ATTACH_FLAGS: ATT_MHTML_REF, shown by the HTML body
            bool(0x7ffe, true), // PR_ATTACHMENT_HIDDEN: not listed with the attachments
          ]
        : []),
    ]);
  });

  // The named-property mapping is required even when no named properties are used.
  for (const stream of ["00020102", "00030102", "00040102"]) {
    CFB.utils.cfb_add(cfb, `/__nameid_version1.0/__substg1.0_${stream}`, Buffer.alloc(0));
  }
  // cfb always adds a 4-byte "\u0001Sh33tJ5" placeholder stream on write; .msg
  // readers ignore streams they don't know, so it is left in.
  return Buffer.from(CFB.write(cfb, { type: "buffer" }) as Uint8Array);
}
