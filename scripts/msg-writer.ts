// Writes Outlook .msg files (MS-OXMSG) for benchmark evidence: a Compound
// File Binary container holding the message's MAPI properties. Covers what
// case emails need: sender, To/Cc recipients, sent and received times,
// subject and plain-text body. No attachments.

import CFB from "cfb";

/** An email as stored in a case's msg-sources/<name>.json. */
export interface MsgSource {
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  cc?: { name: string; email: string }[];
  /** ISO 8601 with offset, e.g. 2025-07-08T16:05:00+02:00. */
  sent: string;
  subject: string;
  /** Plain text; lines joined with "\n". */
  body: string[];
}

// MAPI property types.
const PT_LONG = 0x0003;
const PT_UNICODE = 0x001f;
const PT_SYSTIME = 0x0040;

type Prop = { id: number; type: typeof PT_LONG; value: number } | { id: number; type: typeof PT_UNICODE; value: string } | { id: number; type: typeof PT_SYSTIME; value: Date };

const long = (id: number, value: number): Prop => ({ id, type: PT_LONG, value });
const text = (id: number, value: string): Prop => ({ id, type: PT_UNICODE, value });
const time = (id: number, value: Date): Prop => ({ id, type: PT_SYSTIME, value });

/** PROPATTR_READABLE | PROPATTR_WRITABLE */
const FLAGS = 0x6;
/** 100 ns intervals between 1601-01-01 and 1970-01-01. */
const FILETIME_EPOCH = 116_444_736_000_000_000n;

const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, "0");
const streamName = (p: Prop) => `__substg1.0_${hex(p.id, 4)}${hex(p.type, 4)}`;

/**
 * Adds a property object to `dir` (the root, or a recipient storage): a
 * `__properties_version1.0` stream with fixed-size values inline and the size
 * of each string, whose UTF-16LE content goes in its own `__substg1.0_` stream.
 */
function addProps(cfb: CFB.CFB$Container, dir: string, header: Buffer, props: Prop[]) {
  const entries = Buffer.alloc(16 * props.length);
  props.forEach((p, i) => {
    const at = 16 * i;
    entries.writeUInt32LE(((p.id << 16) | p.type) >>> 0, at);
    entries.writeUInt32LE(FLAGS, at + 4);
    if (p.type === PT_LONG) entries.writeInt32LE(p.value, at + 8);
    else if (p.type === PT_SYSTIME) entries.writeBigUInt64LE(BigInt(p.value.getTime()) * 10_000n + FILETIME_EPOCH, at + 8);
    else {
      const content = Buffer.from(p.value, "utf16le");
      // A string's size counts its terminating null, which the stream leaves out.
      entries.writeUInt32LE(content.length + 2, at + 8);
      CFB.utils.cfb_add(cfb, `${dir}/${streamName(p)}`, content);
    }
  });
  CFB.utils.cfb_add(cfb, `${dir}/__properties_version1.0`, Buffer.concat([header, entries]));
}

/** Builds the .msg file for an email. */
export function buildMsg(source: MsgSource): Buffer {
  const sent = new Date(source.sent);
  if (Number.isNaN(sent.getTime())) throw new Error(`invalid sent time "${source.sent}"`);
  const recipients = [
    ...source.to.map((r) => ({ ...r, type: 1 })),
    ...(source.cc ?? []).map((r) => ({ ...r, type: 2 })),
  ];
  const display = (type: number) => recipients.filter((r) => r.type === type).map((r) => r.name).join("; ");

  const cfb = CFB.utils.cfb_new();
  // Top-level header: 8 reserved bytes, next recipient ID, next attachment ID,
  // recipient count, attachment count, 8 reserved bytes.
  const header = Buffer.alloc(32);
  header.writeUInt32LE(recipients.length, 8);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(recipients.length, 16);
  header.writeUInt32LE(0, 20);
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
    long(0x0e07, 1), // PR_MESSAGE_FLAGS: read
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

  // The named-property mapping is required even when no named properties are used.
  for (const stream of ["00020102", "00030102", "00040102"]) {
    CFB.utils.cfb_add(cfb, `/__nameid_version1.0/__substg1.0_${stream}`, Buffer.alloc(0));
  }
  // cfb always adds a 4-byte "\u0001Sh33tJ5" placeholder stream on write; .msg
  // readers ignore streams they don't know, so it is left in.
  return Buffer.from(CFB.write(cfb, { type: "buffer" }) as Uint8Array);
}
