import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { MailMessage, MailSummary } from "../../shared/api.js";
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
 * Read-only by construction. The only verbs here are FETCH and SEARCH; a
 * draft, when that lands, is an APPEND to the Drafts folder. Nothing here can
 * move, flag, delete or send. One connection per call rather than a kept one:
 * a poll every five minutes and the odd question do not justify a socket held
 * open across a phone's worth of idle time, and an IMAP server that dropped a
 * kept connection would fail the next call in a way that looks like a bug.
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

async function withInbox<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
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
  const lock = await client.getMailboxLock("INBOX");
  try {
    return await fn(client);
  } finally {
    lock.release();
    await client.logout().catch(() => undefined);
  }
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
