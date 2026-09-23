import type { GmailLabel, GmailRule } from "../../shared/api.js";
import { TOKEN_URL } from "./google-auth.js";
import * as mailLog from "./mail-log.js";
import { sourceEnv } from "./settings-store.js";

/**
 * Gmail's labels and filters, over its API — the one thing IMAP cannot do.
 *
 * mail.ts stays IMAP and a password on purpose (see its own docstring); a
 * label or a filter that shows up in Gmail's own settings, and keeps working
 * when this pod is down, needs the API instead. Same Google sign-in as the
 * calendar (google-auth.ts): one consent covers both, so a bench that already
 * has calendar working only needs to sign in again to pick up the new scopes.
 */
export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export async function gmailConfig(): Promise<GmailConfig | null> {
  const vars = await sourceEnv();
  if (!vars.GOOGLE_CLIENT_ID || !vars.GOOGLE_CLIENT_SECRET || !vars.GOOGLE_REFRESH_TOKEN) {
    return null;
  }
  return {
    clientId: vars.GOOGLE_CLIENT_ID,
    clientSecret: vars.GOOGLE_CLIENT_SECRET,
    refreshToken: vars.GOOGLE_REFRESH_TOKEN,
  };
}

/** Not signed in, or Google's token endpoint would not answer. */
export class GmailUnavailable extends Error {}
/** Signed in, but without the scopes this needs — reconnect to grant them. */
export class GmailDenied extends Error {}
/** A rule or a relabel with nothing to match or nothing to do. */
export class RuleRefused extends Error {}

/**
 * The access token, kept for as long as Google says it lasts (A-23).
 *
 * Every call used to trade the refresh token first, so setting up one filter
 * with a new label was four trades and six requests where two would do, and
 * each trade is a round trip to another continent before the one that matters.
 * Keyed by what it was traded for, so signing in again or changing the client
 * never serves the old account's token.
 */
let held: { key: string; token: string; until: number } | null = null;

/** Forget the token. For tests, and for a call Google answered 401. */
export function resetTokenCache(): void {
  held = null;
}

async function accessToken(config: GmailConfig, now = Date.now()): Promise<string> {
  const key = `${config.clientId}\n${config.refreshToken}`;
  if (held && held.key === key && now < held.until) return held.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new GmailUnavailable(
      `could not refresh the Google token: ${body.error_description ?? body.error ?? res.status}`,
    );
  }
  // A minute short of what Google says, so a token is never sent in its last
  // seconds; one with no lifetime given is used once, as before.
  const life = typeof body.expires_in === "number" ? (body.expires_in - 60) * 1000 : 0;
  held = life > 0 ? { key, token: body.access_token, until: now + life } : null;
  return body.access_token;
}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface ApiError {
  error?: { message?: string };
}

/**
 * How long to wait before asking again, for the two tries after the first.
 * Exported so a test does not have to sit through them.
 */
export const RETRY_AFTER_MS = [500, 1_500];

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const config = await gmailConfig();
  if (!config) {
    throw new GmailUnavailable("Gmail is not signed in: connect Google under settings, sources");
  }
  const token = await accessToken(config);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    // A 429 or a 5xx is Google saying "not now", and the mail rules page and
    // the assistant both used to pass that on as the answer. Reads only: a
    // write that answered 503 may have landed, and asking again is a second
    // label or a second filter.
    const wait = RETRY_AFTER_MS[attempt];
    if (method === "GET" && wait !== undefined && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    // Google's edge answers in HTML when it is the one refusing, and a parse
    // error from here reads as a bug in this file rather than as what it is.
    let data = {} as T & ApiError;
    try {
      if (text) data = JSON.parse(text) as T & ApiError;
    } catch {
      if (res.ok) throw new GmailUnavailable("Gmail answered with something unreadable");
    }
    if (!res.ok) {
      // Revoked or expired early: the next call trades for a new one.
      if (res.status === 401) resetTokenCache();
      const message = data.error?.message ?? (res.statusText || String(res.status));
      if (res.status === 403) {
        throw new GmailDenied(
          `Gmail refused: ${message} — reconnect Google and grant Gmail access`,
        );
      }
      throw new GmailUnavailable(`Gmail API error: ${message}`);
    }
    return data;
  }
}

interface RawLabel {
  id: string;
  name: string;
  type?: string;
}

/** The account's own labels — not Gmail's built-in ones, which no rule needs by name. */
export async function labels(): Promise<GmailLabel[]> {
  const data = await call<{ labels?: RawLabel[] }>("GET", "/labels");
  return (data.labels ?? [])
    .filter((l) => l.type === "user")
    .map((l) => ({ id: l.id, name: l.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The label's id, creating it first if the account has none by that name. */
/**
 * The id of a label, made if it is not there. `known` is the listing the
 * caller already has, name to id: each caller used to be listed for again
 * here, and once more after. What is made is added to it.
 */
async function labelId(name: string, known: Map<string, string>): Promise<string> {
  const existing = known.get(name);
  if (existing) return existing;
  const created = await call<RawLabel>("POST", "/labels", {
    name,
    labelListVisibility: "labelShow",
    messageListVisibility: "show",
  });
  known.set(name, created.id);
  return created.id;
}

interface RawFilter {
  id: string;
  criteria?: { from?: string; subject?: string; query?: string };
  action?: { addLabelIds?: string[]; removeLabelIds?: string[] };
}

function ruleOf(raw: RawFilter, labelName: Map<string, string>): GmailRule {
  const removed = new Set(raw.action?.removeLabelIds ?? []);
  const addedLabel = (raw.action?.addLabelIds ?? []).find((id) => labelName.has(id));
  return {
    id: raw.id,
    from: raw.criteria?.from || undefined,
    subject: raw.criteria?.subject || undefined,
    query: raw.criteria?.query || undefined,
    label: addedLabel ? labelName.get(addedLabel) : undefined,
    archive: removed.has("INBOX"),
    markRead: removed.has("UNREAD"),
  };
}

/** Every filter on the account. */
export async function rules(): Promise<GmailRule[]> {
  const [data, ls] = await Promise.all([
    call<{ filter?: RawFilter[] }>("GET", "/settings/filters"),
    labels(),
  ]);
  const labelName = new Map(ls.map((l) => [l.id, l.name]));
  return (data.filter ?? []).map((f) => ruleOf(f, labelName));
}

export interface RuleFields {
  from?: string;
  subject?: string;
  query?: string;
  label?: string;
  archive?: boolean;
  markRead?: boolean;
}

/** What makes a rule one at all. Apart, so a card is refused as it is filed. */
export function checkRule(fields: RuleFields): void {
  if (!fields.from && !fields.subject && !fields.query) {
    throw new RuleRefused("a rule needs at least a sender, a subject or a search to match on");
  }
  if (!fields.label && !fields.archive && !fields.markRead) {
    throw new RuleRefused("a rule needs something to do: a label, archive, or mark read");
  }
}

/**
 * A standing filter: mail matching from/subject/query gets labelled, archived
 * or marked read from then on, with no further asking. Nothing here deletes —
 * the same rule mail.ts's own move follows, just at the account's own layer
 * instead of this pod's.
 */
export async function createRule(fields: RuleFields): Promise<GmailRule> {
  checkRule(fields);
  const known = new Map((await labels()).map((l) => [l.name, l.id]));
  const addLabelIds = fields.label ? [await labelId(fields.label, known)] : [];
  const removeLabelIds = [
    ...(fields.archive ? ["INBOX"] : []),
    ...(fields.markRead ? ["UNREAD"] : []),
  ];
  const raw = await call<RawFilter>("POST", "/settings/filters", {
    criteria: {
      ...(fields.from ? { from: fields.from } : {}),
      ...(fields.subject ? { subject: fields.subject } : {}),
      ...(fields.query ? { query: fields.query } : {}),
    },
    action: {
      ...(addLabelIds.length ? { addLabelIds } : {}),
      ...(removeLabelIds.length ? { removeLabelIds } : {}),
    },
  });
  return ruleOf(raw, new Map([...known].map(([name, id]) => [id, name])));
}

export async function deleteRule(id: string): Promise<void> {
  await call<unknown>("DELETE", `/settings/filters/${encodeURIComponent(id)}`);
}

/**
 * Delete one of the account's own labels, by name.
 *
 * The mail stays; the label comes off every message that had it, and only
 * the ids the card recorded first (`labelled`) put it back, which is why the
 * tool is chair-only. A label a filter still files into is refused: the
 * filter would go on naming a label that is gone, so that filter is removed
 * first.
 */
export async function deleteLabel(name: string): Promise<void> {
  const [ls, data] = await Promise.all([
    labels(),
    call<{ filter?: RawFilter[] }>("GET", "/settings/filters"),
  ]);
  const label = ls.find((l) => l.name === name);
  if (!label) throw new RuleRefused(`no such label: ${name}`);
  const filter = (data.filter ?? []).find((f) => f.action?.addLabelIds?.includes(label.id));
  if (filter) {
    throw new RuleRefused(
      `filter ${filter.id} still files into ${name}: remove it with mail_rule_delete first`,
    );
  }
  await call<unknown>("DELETE", `/labels/${encodeURIComponent(label.id)}`);
}

/** The most message ids a deleted label's card keeps: one page of Gmail's listing. */
export const MAX_LABELLED = 500;

/**
 * The ids of the messages carrying a label, read before it is deleted so the
 * undo can put it back on them. `capped` when there were more than are kept.
 */
export async function labelled(labelId: string): Promise<{ ids: string[]; capped: boolean }> {
  const found = await call<{ messages?: { id: string }[]; nextPageToken?: string }>(
    "GET",
    `/messages?${new URLSearchParams({ labelIds: labelId, maxResults: String(MAX_LABELLED) }).toString()}`,
  );
  return { ids: (found.messages ?? []).map((m) => m.id), capped: !!found.nextPageToken };
}

/**
 * A deleted label made again by name, its old id being gone with it, and put
 * back on the messages that carried it.
 */
export async function restoreLabel(name: string, ids: string[]): Promise<number> {
  const id = await labelId(name, new Map((await labels()).map((l) => [l.name, l.id])));
  if (ids.length) {
    await call<unknown>("POST", "/messages/batchModify", { ids, addLabelIds: [id] });
  }
  return ids.length;
}

/** One sweep's worth, as mail.ts's move. A model that wants more asks twice. */
export const MAX_RELABEL = 50;

/**
 * Gmail's own labels a relabel may put on or take off. Not TRASH or SPAM:
 * those hide mail, which is a move's job, not a label's.
 */
const SYSTEM_LABELS = new Set(["INBOX", "UNREAD", "STARRED", "IMPORTANT"]);

export interface RelabelFields {
  query: string;
  add?: string[];
  remove?: string[];
}

/**
 * Labels put on and taken off exact messages, by id: the undo of a relabel.
 * A label to put back that no longer exists is made again; one to take off
 * that is gone is already off.
 */
export async function relabelIds(ids: string[], add: string[], remove: string[]): Promise<number> {
  if (!ids.length) return 0;
  const own = new Map((await labels()).map((l) => [l.name, l.id]));
  const removeLabelIds = remove
    .map((name) => (SYSTEM_LABELS.has(name) ? name : own.get(name)))
    .filter((id): id is string => !!id);
  const addLabelIds: string[] = [];
  for (const name of add) {
    addLabelIds.push(SYSTEM_LABELS.has(name) ? name : await labelId(name, own));
  }
  await call<unknown>("POST", "/messages/batchModify", { ids, addLabelIds, removeLabelIds });
  await mailLog.record({ verb: "relabel", query: "(undo)", ids, add, remove });
  return ids.length;
}

/**
 * Put labels on and take labels off the mail a Gmail search finds.
 *
 * What IMAP cannot do: a move there drops INBOX and nothing else, so mail
 * filed under the wrong label keeps it. Undone by the opposite relabel, and
 * nothing here deletes. A label to remove has to exist — a typo is a refusal —
 * while one to add is created, the way a rule's is, but only once there is
 * mail to put it on.
 */
export async function relabel(fields: RelabelFields): Promise<number> {
  const query = fields.query.trim();
  const add = [...new Set(fields.add ?? [])];
  const remove = [...new Set(fields.remove ?? [])];
  if (!query) throw new RuleRefused("a relabel needs a search to find the mail");
  if (!add.length && !remove.length) {
    throw new RuleRefused("a relabel needs a label to add or remove");
  }
  if ([...add, ...remove].some((name) => name === "TRASH" || name === "SPAM")) {
    throw new RuleRefused("trash and spam are a move, not a label: use mail_move");
  }
  if (add.some((name) => remove.includes(name))) {
    throw new RuleRefused("a label cannot be added and removed at once");
  }
  const own = new Map((await labels()).map((l) => [l.name, l.id]));
  const removeLabelIds = remove.map((name) => {
    const id = SYSTEM_LABELS.has(name) ? name : own.get(name);
    if (!id) throw new RuleRefused(`no such label: ${name}`);
    return id;
  });
  const found = await call<{ messages?: { id: string }[] }>(
    "GET",
    `/messages?${new URLSearchParams({ q: query, maxResults: String(MAX_RELABEL) }).toString()}`,
  );
  const ids = (found.messages ?? []).map((m) => m.id);
  if (!ids.length) return 0;
  const addLabelIds: string[] = [];
  for (const name of add) {
    addLabelIds.push(SYSTEM_LABELS.has(name) ? name : await labelId(name, own));
  }
  await call<unknown>("POST", "/messages/batchModify", { ids, addLabelIds, removeLabelIds });
  // The ids, because the search is not a record: what it finds tomorrow is not
  // what it found today, and the opposite relabel would then miss these.
  await mailLog.record({ verb: "relabel", query, ids, add, remove });
  return ids.length;
}
