import fs from "node:fs/promises";
import path from "node:path";
import type { CouncilMember } from "../../shared/api.js";
import { agentUser } from "./agent-user.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { CHAIR_ID } from "./council-store.js";
import { env } from "./env.js";
import { agentEnv } from "./settings-store.js";

/**
 * What a speaker may reach: its built-in tools, the rules on them, the MCP
 * servers it is offered and the environment it runs in.
 *
 * Apart from assistant.ts because none of it knows there is a chat. It is the
 * argv and the env of a `claude` process, decided from a member and a flag, and
 * it is the part of the assistant a security review reads first.
 */

/** The four things `turn` puts on the command line for a speaker. */
export interface ToolPolicy {
  builtins: string[];
  allowed: string[];
  denied: string[];
  /** Verksted tools this speaker is offered at all; null means every one. */
  tools: string[] | null;
}

/** Where attached images land, outside any repo and readable by the agent. */
/**
 * The assistant's own HOME, when sessions run as the agent user: claude keeps
 * a turn's transcript there, and a transcript holds whatever the turn read of
 * the person's mail, calendar and documents. In the sessions' HOME the agent
 * user could read every one. With no agent user it is the one HOME there is.
 */
export function assistantHome(): string {
  return agentUser() ? path.join(env.ASSISTANT_DIR, "home") : (process.env.HOME ?? "/data/home");
}

export function uploadsDir(): string {
  return path.join(env.ASSISTANT_DIR, "uploads");
}

/**
 * What anyone here may do, in two halves.
 *
 * `allowed` is what may run and, under `--permission-mode dontAsk`, the only
 * thing that may: a call no rule approves is refused rather than put to a
 * classifier. The tools worth regretting are denied outright all the same,
 * because a deny is the half that still holds if the mode ever changes. What
 * remains is: read the repos, read the web, and act through the verksted
 * server, whose every endpoint is one the app already validates.
 *
 * Read, Grep and Glob are deliberately *not* on the allow list. The CLI reads
 * inside its working directory and its --add-dir without being told it may,
 * and an allow rule with no path is not confined to either: checked against
 * 2.1.278, a bare `Read` opened a file beside the repos as readily as one
 * inside them, which on the pod is settings.json, every document, every past
 * conversation and the agent's own credentials, in the hands of an advisor that
 * also holds WebFetch. Left off, the same read is refused.
 *
 * Two halves rather than one list because an advisor's own file decides whether
 * it gets the second. The web tools were denied outright until asked for, and
 * the reason is still true: read access to repos that contain .env files, plus
 * fetch, is the shape a prompt injection needs to become exfiltration — and the
 * harvester this is being built towards will eventually read text neither of us
 * wrote. What changed is that reading the web is now part of the chair's job.
 * Nothing here defends against that; what limits it is that no participant can
 * run a shell, so a page that talks one into something still has to go through
 * tools whose every effect is visible in the UI. An advisor with no reason to
 * read a page is not given the half that could carry one back out.
 */
const BUILTIN_READ = ["Read", "Grep", "Glob"];
const WEB_TOOLS = ["WebFetch", "WebSearch"];
/**
 * The same, for a turn nobody is reading.
 *
 * The web goes, and knowingly. Fetching a page is how a prompt injection
 * becomes exfiltration, and the only thing standing between the two today is
 * that a person is looking at the reply — which is exactly what an unattended
 * turn does not have. A briefing reads the bench, and the bench is local.
 *
 * The verksted tools are cut in the MCP server rather than here, because an
 * allow list is auto-approval and a deny list of tool names is a thing this
 * repo would have to maintain forever. Under VK_UNATTENDED the server does not
 * offer the ones that change anything, so they do not exist to be approved.
 */
export const UNATTENDED_ALLOWED_TOOLS = ["mcp__verksted"];
/**
 * Naming the built-ins that exist at all is a stronger statement than the allow
 * list: a tool not named is not present to be approved.
 *
 * It is also the single biggest thing that made the assistant feel slow. With
 * the full built-in set available, the CLI defers the tool schemas and the
 * model has to call ToolSearch to find the verksted ones first — an entire
 * extra round trip, on every turn, before it can even look at the workbench.
 * Naming a short list removes it: measured over the same question, 18.5s with
 * the full set against a steady 5s with this, and no ToolSearch call at all.
 * The same argument applies again to an advisor's verksted tools, which is part
 * of why VK_TOOLS is worth the trouble rather than only being a safety line.
 */
export const UNATTENDED_BUILTIN_TOOLS = ["Read", "Grep", "Glob"];
/**
 * Where no participant reads, whatever else is decided: every process's
 * environment, the agent's own home (its login, the ssh keys, gh's token) and
 * the settings file. Read rules cover Grep and Glob too, and a leading `//` is
 * how a rule says an absolute path.
 *
 * Deny wins over everything, --add-dir included, so a place that holds the
 * repos or the uploads is left off: on a laptop $HOME usually does.
 */
function readDenied(): string[] {
  const open = [env.REPOS_DIR, uploadsDir()];
  const holds = (dir: string) => open.some((o) => !path.relative(dir, o).startsWith(".."));
  const home = process.env.HOME ?? "/data/home";
  return [
    "Read(//proc/**)",
    ...(holds(home) ? [] : [`Read(/${home}/**)`]),
    `Read(/${env.SETTINGS_FILE})`,
  ];
}

const DENIED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "Task", ...readDenied()];
export const UNATTENDED_DENIED_TOOLS = [...DENIED_TOOLS, "WebFetch", "WebSearch"];

/**
 * The one advisor whose id is fixed to headroom, and what neither it nor the
 * chair may do there once they have it.
 *
 * A member id fixed in code rather than a field on the member, and for the same
 * reason the denied built-ins are: a member is a JSON file somebody can edit
 * from a phone, and "may read the household finances" is not a checkbox worth
 * having on that form. The chair reads headroom too, on a live turn — see
 * `policyFor` and `mcpConfig` — for a plain lookup ("what did I save last
 * month"); Ariel stays who the chair convenes for a question that wants
 * judgement on those numbers, an unattended run's finance watch, or a member
 * asked by name.
 *
 * The deny list is the half that works. An allow list only auto-approves, and
 * `mcp__headroom` can only be allowed whole; verksted's own server is narrowed
 * per member through VK_TOOLS, and headroom's has no such switch. Naming the
 * tools individually in --disallowed-tools does hold — verified against the
 * CLI, which refuses the call rather than merely leaving it unapproved.
 *
 * What is denied is every write, so the advisor cannot move a budget it was
 * only asked about, and `get_raw_data`, which returns the whole database when
 * the aggregates it keeps are what advice is actually made of. That second one
 * is not about trust: this advisor reads the web, and a page that talks it into
 * something can only carry out what the advisor was able to fetch.
 */
export const HEADROOM_MEMBER = "ariel";
const HEADROOM_DENIED = [
  "set_category_budget",
  "add_goal",
  "update_goal",
  "add_fixed_expense",
  "update_fixed_expense",
  "update_assumptions",
  "set_ai_context",
  "set_profile",
  "restore_revision",
  "get_raw_data",
].map((t) => `mcp__headroom__${t}`);

/** Its own repo's server, run from the volume: nothing here is a second copy. */
const HEADROOM_SERVER = path.join(env.REPOS_DIR, "headroom");

/** Who is offered headroom at all; `null` is the chair. */
export function holdsHeadroom(member: string | null, unattended: boolean): boolean {
  return member === HEADROOM_MEMBER || (member === null && !unattended);
}

/**
 * The environment a turn runs in, named rather than inherited.
 *
 * It used to be the backend's whole environment with every stored var on top,
 * and everything the CLI starts inherits what the CLI has: the browser, the
 * headroom server, a model reading /proc. None of them has a use for GH_TOKEN,
 * the other agents' keys or the backup passphrase, and no participant here can
 * run the shell those exist for. What a turn needs is somewhere to find its
 * binaries and its home, the locale, a proxy if there is one, and claude's own
 * sign-in; headroom's two go only to a speaker that is offered headroom.
 */
const TURN_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "PLAYWRIGHT_BROWSERS_PATH",
]);
const TURN_ENV_PREFIXES = ["LC_", "XDG_", "CLAUDE_"];
const HEADROOM_KEYS = ["HEADROOM_URL", "HEADROOM_PASSWORD"];

export async function turnEnv(headroom: boolean): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...(await agentEnv()) })) {
    if (value === undefined) continue;
    if (
      TURN_ENV_KEYS.has(key) ||
      TURN_ENV_PREFIXES.some((p) => key.startsWith(p)) ||
      (headroom && HEADROOM_KEYS.includes(key))
    ) {
      out[key] = value;
    }
  }
  out.HOME = assistantHome();
  return out;
}

/** Where the MCP server the assistant acts through lives inside the image. */
function mcpConfig(
  unattended: boolean,
  tools: string[] | null,
  member: string | null,
  headroomConfigured: boolean,
  turn: string,
) {
  // Ariel always; the chair too, but only on a live turn — a nightly briefing
  // reads the bench, and the finance watch that runs unattended is still
  // Ariel's schedule to answer. Never without both vars set, so a bench that
  // does not run headroom offers no tools that would fail on every call. The
  // deny list on the writes holds whether or not anyone is reading.
  const headroom = holdsHeadroom(member, unattended) && headroomConfigured;
  // The chair's own browser, never an advisor's and never unattended, for the
  // same reason as headroom: a briefing reads the bench, and the bench is
  // local. Same wrapper claude-hooks.ts uses for a session's browser — boot it
  // through the backend, then hand playwright-mcp the CDP endpoint it booted.
  const browser = member === null && !unattended;
  // An empty list is a speaker that may call none of them — Ariel, who holds
  // headroom and nothing here, and a turn with a job of its own, which holds
  // nothing at all. Not the same as null, which is the chair and means every
  // tool: the server is left out rather than offered with an empty filter,
  // because VK_TOOLS="" reads back as unset and so as no filter at all.
  const verksted = tools?.length !== 0;
  return {
    mcpServers: {
      ...(browser
        ? {
            browser: {
              command: "sh",
              args: [
                "-c",
                `curl -sf -X POST -H "x-vk-turn: ${turn}" ` +
                  `http://127.0.0.1:${env.PORT}/api/assistant/browser/start >/dev/null 2>&1; ` +
                  'exec playwright-mcp --cdp-endpoint "$VK_BROWSER_CDP"',
              ],
            },
          }
        : {}),
      ...(headroom
        ? {
            headroom: {
              // tsx from headroom's own node_modules rather than npx: no
              // network, and the server is the one that repo ships and tests.
              command: path.join(HEADROOM_SERVER, "node_modules/.bin/tsx"),
              args: [path.join(HEADROOM_SERVER, "mcp/server.ts")],
              // No env block: HEADROOM_URL and HEADROOM_PASSWORD are settings
              // vars, and an MCP server inherits the environment the CLI was
              // spawned with — which is where agentEnv() already puts them.
              // Checked against the CLI rather than assumed. Naming them here
              // would mean the backend reading a credential it has no use for
              // and writing it into a second file on the volume.
            },
          }
        : {}),
      ...(verksted
        ? {
            verksted: {
              command: "node",
              args: ["/etc/verksted/verksted-mcp.mjs"],
              env: {
                VK_API: `http://127.0.0.1:${env.PORT}`,
                // Read by the server itself, which then offers only the tools that
                // change nothing. The list lives next to the tool definitions, so
                // adding a tool means deciding there whether it may run unwatched.
                ...(unattended ? { VK_UNATTENDED: "1" } : {}),
                // The same trick, per advisor: the server offers only these, so a
                // tool a member may not use is absent from tools/list rather than
                // merely left off an allow list. --allowed-tools can only name the
                // whole server (`mcp__verksted`), so this is the one place where a
                // member's tools can actually be narrowed.
                ...(tools ? { VK_TOOLS: tools.join(",") } : {}),
                // Whose memory `remember` writes. From the environment rather than a
                // tool argument, so nothing the model says can change it — an advisor
                // cannot write into the bench's memory, or another advisor's, by
                // naming one.
                ...(member ? { VK_MEMBER: member } : {}),
                // Which turn this server is serving. It is how the backend knows
                // that the turn about to read the mail is the one whose browser has
                // to go (see assistant-taint.ts), and it is written here rather than
                // passed as an argument so nothing a model says can name another.
                VK_TURN: turn,
              },
            },
          }
        : {}),
    },
  };
}

/**
 * Written per speaker, atomically.
 *
 * Two members starting at the same moment would otherwise write the same path
 * while the other's CLI is reading it, which is a torn read of a config that
 * decides what a model may do.
 */
export async function ensureMcpConfig(o: {
  id: string;
  /** Empty means no server at all; null means the whole set. */
  tools: string[] | null;
  unattended: boolean;
  turn: string;
}): Promise<string> {
  const isChair = o.id === CHAIR_ID;
  // Per speaker on an unattended run too. The advisors a nightly meeting
  // convenes run under one `Promise.all`, and they all wrote this file: the
  // last writer decided what every one of them could reach, so an advisor
  // could start with another's VK_TOOLS, another's VK_MEMBER, and headroom
  // without the deny list that is added for the one member meant to have it.
  const name = o.unattended ? `mcp-unattended-${o.id}` : isChair ? "mcp" : `mcp-${o.id}`;
  const file = path.join(env.ASSISTANT_DIR, `${name}.json`);
  await fs.mkdir(env.ASSISTANT_DIR, { recursive: true });
  // Whether headroom is reachable at all is the only thing the backend needs to
  // know about it: the values themselves go to the CLI with every other agent
  // var, and the server reads them from the environment it inherits.
  await writeJsonAtomic(
    file,
    mcpConfig(o.unattended, o.tools, isChair ? null : o.id, await headroomConfigured(), o.turn),
  );
  return file;
}

/** Whether this bench runs headroom at all: both vars, or no server is offered. */
export async function headroomConfigured(): Promise<boolean> {
  const vars = await agentEnv();
  return !!(vars.HEADROOM_URL && vars.HEADROOM_PASSWORD);
}

/**
 * Whether the headroom server can start from what is checked out, or null
 * where headroom is not configured at all.
 *
 * It runs from the working tree, so a branch without `mcp/` or a checkout
 * whose install was wiped takes its tools away with nothing to say so: the
 * advisor answers as though headroom was never set up. This is the saying so.
 */
export async function headroomServer(): Promise<{
  branch: string | null;
  missing: string[];
} | null> {
  if (!(await headroomConfigured())) return null;
  const missing: string[] = [];
  for (const rel of ["mcp/server.ts", "node_modules/.bin/tsx"]) {
    try {
      await fs.access(path.join(HEADROOM_SERVER, rel));
    } catch {
      missing.push(rel);
    }
  }
  const head = await fs
    .readFile(path.join(HEADROOM_SERVER, ".git", "HEAD"), "utf8")
    .catch(() => "");
  const branch = /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1] ?? (head.trim() ? "detached" : null);
  return { branch, missing };
}

/**
 * The tool policy every speaker shares, and the part of it that is not data.
 *
 * A member is a JSON file somebody can edit from their phone. What that file
 * may not contain is a way to run a command: the denied built-ins below hold
 * for the chair and for every advisor, unconditionally, and they are here
 * rather than in council-store.ts so that no form post can reach them.
 */
export function policyFor(member: CouncilMember): ToolPolicy {
  const web = member.web ? ["WebFetch", "WebSearch"] : [];
  const headroom = member.id === HEADROOM_MEMBER || member.chair === true;
  // Driving a browser is the chair's alone. The advisors read the web for the
  // question put to them (WebFetch/WebSearch above) and stay that way: asked
  // for input, not given a second way to act on it.
  const browser = member.chair ? ["mcp__browser"] : [];
  // An advisor that reads the web does not also read the repos. council-store
  // takes the private verksted tools off such a member for the same reason, and
  // a repo is where the .env files are: the two together are what a page needs
  // to carry something out. The chair keeps both, and what holds it is the rule
  // in assistant-taint.ts rather than a missing tool.
  const reads = member.web && !member.chair ? [] : BUILTIN_READ;
  return {
    builtins: [...reads, ...web],
    allowed: [...web, "mcp__verksted", ...browser, ...(headroom ? ["mcp__headroom"] : [])],
    // The chair keeps every tool, so it is offered the server unfiltered; an
    // advisor is offered exactly what its file names — which council-store has
    // already taken anything private out of, if this member reads the web.
    tools: member.chair ? null : member.tools,
    denied: [
      ...DENIED_TOOLS,
      ...(member.web ? [] : WEB_TOOLS),
      ...(headroom ? HEADROOM_DENIED : []),
    ],
  };
}

/**
 * What a member may touch on a run nobody is reading: the unattended set, and
 * for the one that reads headroom, headroom's reads. The writes and the raw
 * dump stay denied, exactly as when someone is watching.
 */
export function unattendedPolicy(member: CouncilMember): Pick<ToolPolicy, "allowed" | "denied"> {
  const headroom = member.id === HEADROOM_MEMBER;
  return {
    allowed: [...UNATTENDED_ALLOWED_TOOLS, ...(headroom ? ["mcp__headroom"] : [])],
    denied: [...UNATTENDED_DENIED_TOOLS, ...(headroom ? HEADROOM_DENIED : [])],
  };
}
