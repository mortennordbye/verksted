import type { GmailLabel, GmailRule } from "../../shared/api.js";
import { TOKEN_URL } from "./google-auth.js";
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

async function accessToken(config: GmailConfig): Promise<string> {
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
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new GmailUnavailable(
      `could not refresh the Google token: ${body.error_description ?? body.error ?? res.status}`,
    );
  }
  return body.access_token;
}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface ApiError {
  error?: { message?: string };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const config = await gmailConfig();
  if (!config) {
    throw new GmailUnavailable("Gmail is not signed in: connect Google under settings, sources");
  }
  const token = await accessToken(config);
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
  const data = (text ? JSON.parse(text) : {}) as T & ApiError;
  if (!res.ok) {
    const message = data.error?.message ?? res.statusText;
    if (res.status === 403) {
      throw new GmailDenied(`Gmail refused: ${message} — reconnect Google and grant Gmail access`);
    }
    throw new GmailUnavailable(`Gmail API error: ${message}`);
  }
  return data;
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
async function labelId(name: string): Promise<string> {
  const existing = (await labels()).find((l) => l.name === name);
  if (existing) return existing.id;
  const created = await call<RawLabel>("POST", "/labels", {
    name,
    labelListVisibility: "labelShow",
    messageListVisibility: "show",
  });
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

/**
 * A standing filter: mail matching from/subject/query gets labelled, archived
 * or marked read from then on, with no further asking. Nothing here deletes —
 * the same rule mail.ts's own move follows, just at the account's own layer
 * instead of this pod's.
 */
export async function createRule(fields: RuleFields): Promise<GmailRule> {
  if (!fields.from && !fields.subject && !fields.query) {
    throw new RuleRefused("a rule needs at least a sender, a subject or a search to match on");
  }
  if (!fields.label && !fields.archive && !fields.markRead) {
    throw new RuleRefused("a rule needs something to do: a label, archive, or mark read");
  }
  const addLabelIds = fields.label ? [await labelId(fields.label)] : [];
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
  const ls = await labels();
  return ruleOf(raw, new Map(ls.map((l) => [l.id, l.name])));
}

export async function deleteRule(id: string): Promise<void> {
  await call<unknown>("DELETE", `/settings/filters/${encodeURIComponent(id)}`);
}

/**
 * Delete one of the account's own labels, by name.
 *
 * The mail stays; the label comes off every message that had it, and nothing
 * later puts it back, which is why the tool is chair-only. A label a filter
 * still files into is refused: the filter would go on naming a label that is
 * gone, so that filter is removed first.
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
    addLabelIds.push(SYSTEM_LABELS.has(name) ? name : (own.get(name) ?? (await labelId(name))));
  }
  await call<unknown>("POST", "/messages/batchModify", { ids, addLabelIds, removeLabelIds });
  return ids.length;
}
