import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type { MailFolder, MailMessage, MailSummary } from "../../shared/api.js";
import * as mailLog from "./mail-log.js";
import { sourceEnv } from "./settings-store.js";

/**
 * Mail, read over IMAP.
 *
 * An open protocol and an app password, which is what keeps this a backend
 * that needs no OAuth flow, no Google project and no vendor assistant: IMAP
 * covers Google Workspace, Fastmail, iCloud and a server of your own. The
 * credentials are settings-page vars the backend reads through `sourceEnv`,
 * which is an allowlist, and which `agentEnv` excludes, so a mail password
 * never reaches a coding session's environment.
 *
 * What it may do is read, and move. FETCH, SEARCH and LIST, plus a MOVE into a
 * mailbox the server itself listed — the verb that makes filing possible and
 * is undone by filing back. Nothing here flags or deletes, and sending lives
 * at the bottom of this file behind a card somebody tapped.
 *
 * One connection per call rather than a kept one: a poll every five minutes
 * and the odd question do not justify a socket held open across a phone's
 * worth of idle time, and an IMAP server that dropped a kept connection would
 * fail the next call in a way that looks like a bug.
 */
export interface MailConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

export async function mailConfig(): Promise<MailConfig | null> {
  const vars = await sourceEnv();
  if (!vars.IMAP_HOST || !vars.IMAP_USER || !vars.IMAP_PASSWORD) return null;
  const port = Number(vars.IMAP_PORT ?? "993");
  return {
    host: vars.IMAP_HOST,
    port: Number.isInteger(port) && port > 0 ? port : 993,
    user: vars.IMAP_USER,
    password: vars.IMAP_PASSWORD,
  };
}

export class MailUnavailable extends Error {}

async function withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const config = await mailConfig();
  if (!config) throw new MailUnavailable("mail is not set up: IMAP_HOST, IMAP_USER, IMAP_PASSWORD");
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    logger: false,
    // A server that hangs must not hang a poll forever.
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** The same connection with a mailbox selected, which every verb but LIST needs. */
async function withBox<T>(box: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    const lock = await client.getMailboxLock(box);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  });
}

const withInbox = <T>(fn: (client: ImapFlow) => Promise<T>) => withBox("INBOX", fn);

/** What an envelope says, as the feed and the tools show it. */
export function summarise(msg: {
  uid: number;
  envelope?: {
    subject?: string;
    // imapflow 2 hands back the header as it came when it cannot parse it.
    date?: Date | string;
    from?: { name?: string; address?: string }[];
  };
  flags?: Set<string>;
}): MailSummary {
  const from = msg.envelope?.from?.[0];
  return {
    uid: msg.uid,
    subject: msg.envelope?.subject?.trim() || "(no subject)",
    from: from?.name?.trim() || from?.address || "(unknown)",
    address: from?.address ?? "",
    at: when(msg.envelope?.date).toISOString(),
    unread: !(msg.flags?.has("\\Seen") ?? false),
  };
}

/**
 * A message's date as a Date. A header nobody can read is not a reason to drop
 * the message, or to throw on `toISOString`: it is dated when it was seen.
 */
function when(date: Date | string | undefined): Date {
  const d = date instanceof Date ? date : date ? new Date(date) : null;
  return d && !Number.isNaN(d.getTime()) ? d : new Date();
}

/** The newest messages in the inbox, newest first. */
export async function recent(limit = 30): Promise<MailSummary[]> {
  return withInbox(async (client) => {
    const total = client.mailbox && typeof client.mailbox === "object" ? client.mailbox.exists : 0;
    if (!total) return [];
    const from = Math.max(1, total - limit + 1);
    const out: MailSummary[] = [];
    for await (const msg of client.fetch(`${from}:*`, { envelope: true, flags: true, uid: true })) {
      out.push(summarise(msg));
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  });
}

/** Subject, sender or body, all words required by the server's own search. */
export async function search(query: string, limit = 20): Promise<MailSummary[]> {
  const q = query.trim();
  if (!q) return [];
  return withInbox(async (client) => {
    const uids = await client.search(
      { or: [{ subject: q }, { from: q }, { body: q }] },
      { uid: true },
    );
    if (!uids || !uids.length) return [];
    const wanted = uids.slice(-limit);
    const out: MailSummary[] = [];
    for await (const msg of client.fetch(
      wanted,
      { envelope: true, flags: true, uid: true },
      { uid: true },
    )) {
      out.push(summarise(msg));
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  });
}

/** How much of a body a model is handed: enough to answer, not a newsletter. */
export const BODY_BYTES = 12 * 1024;

/**
 * The most of one text part that is ever downloaded. Far more than is shown,
 * because an HTML part is mostly markup and is cut after it is reduced.
 */
const PART_BYTES = 256 * 1024;

/** One node of a message's structure, as far as this file reads it. */
interface Part {
  part?: string;
  type?: string;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  childNodes?: Part[];
}

function walk(node: Part, out: Part[] = []): Part[] {
  out.push(node);
  for (const child of node.childNodes ?? []) walk(child, out);
  return out;
}

const fileName = (p: Part) => p.dispositionParameters?.filename ?? p.parameters?.name;
const isAttachment = (p: Part) =>
  p.disposition === "attachment" ||
  (fileName(p) !== undefined && !p.type?.startsWith("text/") && !p.type?.startsWith("multipart/"));

const cut = (text: string) =>
  text.length > BODY_BYTES ? `${text.slice(0, BODY_BYTES)}\n[cut at ${BODY_BYTES} bytes]` : text;

/**
 * One message, as text. HTML-only mail is reduced to its text.
 *
 * A message with parts is read by its structure (A-25): the text part alone is
 * downloaded, and the attachments are named from the structure without being
 * fetched. It used to be the whole source, so reading the two lines above a
 * twenty megabyte scan cost twenty megabytes, a parse of all of it, and then
 * twelve kilobytes were kept. A message with no parts is its own text, so the
 * whole of it is still what is fetched; so is one whose structure has no text
 * part this can find, which is the old way and always works.
 */
export async function read(uid: number): Promise<MailMessage | null> {
  return withInbox(async (client) => {
    const head = await client.fetchOne(
      String(uid),
      { bodyStructure: true, envelope: true, flags: true, uid: true },
      { uid: true },
    );
    if (!head) return null;
    const parts = head.bodyStructure ? walk(head.bodyStructure) : [];
    const body = parts.filter((p) => p.part && !isAttachment(p));
    const chosen =
      body.find((p) => p.type === "text/plain") ?? body.find((p) => p.type === "text/html");
    if (chosen?.part) {
      const { content } = await client.download(String(uid), chosen.part, {
        uid: true,
        maxBytes: PART_BYTES,
      });
      const chunks: Buffer[] = [];
      for await (const chunk of content) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const text = (chosen.type === "text/html" ? htmlToText(raw) : raw).trim();
      if (text) {
        return {
          ...summarise(head),
          to: (head.envelope?.to ?? [])
            .map((t) => (t.name ? `${t.name} <${t.address ?? ""}>` : (t.address ?? "")))
            .join(", "),
          text: cut(text),
          attachments: parts.filter(isAttachment).map((p) => fileName(p) ?? "(unnamed)"),
        };
      }
    }
    return readWhole(client, uid);
  });
}

/** The whole source, parsed. What `read` falls back on, and all a one-part message needs. */
async function readWhole(client: ImapFlow, uid: number): Promise<MailMessage | null> {
  const msg = await client.fetchOne(
    String(uid),
    { source: true, envelope: true, flags: true, uid: true },
    { uid: true },
  );
  if (!msg || !msg.source) return null;
  const parsed = await simpleParser(msg.source);
  const text = (parsed.text ?? htmlToText(parsed.html || "")).trim();
  return {
    ...summarise(msg),
    to: (parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : [])
      .map((t) => t.text)
      .join(", "),
    text: cut(text),
    attachments: (parsed.attachments ?? []).map((a) => a.filename ?? "(unnamed)"),
  };
}

/**
 * Every mailbox on the server, and what the server says each one is for.
 *
 * Named rather than guessed: Gmail spells its junk folder `[Gmail]/Spam`,
 * translates that name with the account's language, and a bench that hardcoded
 * either would file spam into a folder that does not exist. The special-use
 * flag is the one thing every server agrees on, so `role` is what a caller
 * matches and `path` is what it then sends back.
 *
 * `\Noselect` entries are dropped: `[Gmail]` itself is a container, and a move
 * into it fails in a way that reads like a bug.
 */
async function mailboxes(client: ImapFlow): Promise<MailFolder[]> {
  const list = await client.list();
  return list
    .filter((box) => !box.flags?.has("\\Noselect"))
    .map((box) => ({
      path: box.path,
      name: box.name,
      role: box.specialUse ? box.specialUse.replace("\\", "").toLowerCase() : "",
    }));
}

export async function folders(): Promise<MailFolder[]> {
  return withClient((client) => mailboxes(client));
}

/** A move the server would refuse, refused here, with something to read. */
export class MailDenied extends Error {}

/** The roles a server expires on its own: a move into one is not a filing. */
const DISCARDS = new Set(["trash", "junk"]);

/** One sweep's worth. A model that wants more asks twice. */
export const MAX_MOVE = 50;

/**
 * Move messages into a mailbox that exists, out of the inbox unless told where.
 *
 * It is here rather than behind a tapped card because a move is undone by a
 * move back: the rule is that anything without an undo waits for the person,
 * and this has one. `from` is what makes that sentence true, since it used to
 * be the inbox and nothing else, so nothing could be moved back; and every
 * move is written to the mail log with the uids the messages have where they
 * landed, which is what moving them back needs to know.
 *
 * The trash and the junk folder are the exception. The server empties both on
 * its own clock, so a message put there has an undo only until then, and a
 * mail that says "file everything from the bank under spam" is exactly what a
 * poisoned message would ask for. `discard` is set by the tapped card and by
 * nothing else.
 *
 * Both folders are checked against the server's own list rather than passed
 * through. A folder a model invented is a refusal, not a mailbox quietly
 * created, and `resolveInsideRepos` is the same idea one directory over.
 */
export async function move(
  uids: number[],
  to: string,
  opts: { from?: string; discard?: boolean } = {},
): Promise<number> {
  const wanted = [...new Set(uids)].filter((u) => Number.isInteger(u) && u > 0).slice(0, MAX_MOVE);
  if (!wanted.length) return 0;
  return withClient(async (client) => {
    const boxes = await mailboxes(client);
    const target = boxes.find((box) => box.path === to);
    if (!target) throw new MailDenied(`no such folder: ${to}`);
    const source = opts.from ? boxes.find((box) => box.path === opts.from) : { path: "INBOX" };
    if (!source) throw new MailDenied(`no such folder: ${opts.from}`);
    if (target.path === source.path || (!opts.from && target.role === "inbox")) {
      throw new MailDenied("that is where they already are");
    }
    if (DISCARDS.has(target.role) && !opts.discard) {
      throw new MailDenied(
        `${to} is emptied by the server, so a move there waits for a tapped card`,
      );
    }
    const lock = await client.getMailboxLock(source.path);
    try {
      const res = await client.messageMove(wanted, target.path, { uid: true });
      // What the server confirms, not what was asked: a uid already filed from
      // the phone reads as a smaller number here, and a report saying "moved
      // 12" when four of them were gone is the wrong kind of tidy. `false` is
      // the library's "the server would not", and uidMap needs UIDPLUS, which
      // not every server has; without it the count asked for is the best there
      // is.
      if (!res) return 0;
      await mailLog.record({
        verb: "move",
        from: source.path,
        to: target.path,
        uids: wanted,
        uidMap: Object.fromEntries(res.uidMap ?? []),
      });
      return res.uidMap ? res.uidMap.size : wanted.length;
    } finally {
      lock.release();
    }
  });
}

/** Whether a move to this folder is one only a card may make. */
export async function discards(to: string): Promise<boolean> {
  const target = (await folders()).find((box) => box.path === to);
  return target ? DISCARDS.has(target.role) : false;
}

/** The envelopes of these uids, for a card to show what it is about to move. */
export async function summaries(uids: number[], from = "INBOX"): Promise<MailSummary[]> {
  if (!uids.length) return [];
  return withBox(from, async (client) => {
    const out: MailSummary[] = [];
    for await (const msg of client.fetch(
      uids,
      { envelope: true, flags: true, uid: true },
      { uid: true },
    )) {
      out.push(summarise(msg));
    }
    return out;
  });
}

/**
 * Sending, which only a tapped proposal reaches.
 *
 * SMTP submission with the mail credential unless an SMTP one is given. The
 * one outbound channel in this file, and the reason it is here rather than
 * in a tool: the card the person tapped is the whole of the authorisation,
 * and nothing a model says can reach this without one.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

export async function smtpConfig(): Promise<SmtpConfig | null> {
  const vars = await sourceEnv();
  const user = vars.SMTP_USER || vars.IMAP_USER;
  const password = vars.SMTP_PASSWORD || vars.IMAP_PASSWORD;
  if (!vars.SMTP_HOST || !user || !password) return null;
  const port = Number(vars.SMTP_PORT ?? "587");
  return {
    host: vars.SMTP_HOST,
    port: Number.isInteger(port) && port > 0 ? port : 587,
    user,
    password,
    from: vars.MAIL_FROM || user,
  };
}

export async function send(mail: {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}): Promise<{ messageId: string }> {
  const config = await smtpConfig();
  if (!config)
    throw new MailUnavailable("sending is not set up: SMTP_HOST, and a user and password");
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 20_000,
  });
  const info = await transport.sendMail({
    from: config.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.body,
    ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo, references: mail.inReplyTo } : {}),
  });
  return { messageId: String(info.messageId ?? "") };
}

/** Tags out, entities in, whitespace folded: what a model needs of an HTML mail. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
