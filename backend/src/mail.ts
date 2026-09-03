import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type { MailFolder, MailMessage, MailSummary } from "../../shared/api.js";
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

/** The same connection with INBOX selected, which every verb but LIST needs. */
async function withInbox<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  });
}

/** What an envelope says, as the feed and the tools show it. */
export function summarise(msg: {
  uid: number;
  envelope?: {
    subject?: string;
    date?: Date;
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
    at: (msg.envelope?.date ?? new Date()).toISOString(),
    unread: !(msg.flags?.has("\\Seen") ?? false),
  };
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

/** One message, as text. HTML-only mail is reduced to its text. */
export async function read(uid: number): Promise<MailMessage | null> {
  return withInbox(async (client) => {
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
      text:
        text.length > BODY_BYTES
          ? `${text.slice(0, BODY_BYTES)}\n[cut at ${BODY_BYTES} bytes]`
          : text,
      attachments: (parsed.attachments ?? []).map((a) => a.filename ?? "(unnamed)"),
    };
  });
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

/** One sweep's worth. A model that wants more asks twice. */
export const MAX_MOVE = 50;

/**
 * Move messages out of the inbox into a mailbox that exists.
 *
 * The one mutating verb in this file, and it is here rather than behind a
 * tapped card because a move is undone by a move back: the rule is that
 * anything without an undo waits for the person, and this has one. Nothing
 * here deletes, and the trash is a folder like any other — a message put there
 * is still a message until the server expires it.
 *
 * The destination is checked against the server's own list rather than passed
 * through. A folder a model invented is a refusal, not a mailbox quietly
 * created, and `resolveInsideRepos` is the same idea one directory over.
 */
export async function move(uids: number[], to: string): Promise<number> {
  const wanted = [...new Set(uids)].filter((u) => Number.isInteger(u) && u > 0).slice(0, MAX_MOVE);
  if (!wanted.length) return 0;
  return withInbox(async (client) => {
    const target = (await mailboxes(client)).find((box) => box.path === to);
    if (!target) throw new MailDenied(`no such folder: ${to}`);
    if (target.role === "inbox") throw new MailDenied("the inbox is where they already are");
    const res = await client.messageMove(wanted, target.path, { uid: true });
    // What the server confirms, not what was asked: a uid already filed from
    // the phone reads as a smaller number here, and a report saying "moved 12"
    // when four of them were gone is the wrong kind of tidy. `false` is the
    // library's "the server would not", and uidMap needs UIDPLUS, which not
    // every server has; without it the count asked for is the best there is.
    if (!res) return 0;
    return res.uidMap ? res.uidMap.size : wanted.length;
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
