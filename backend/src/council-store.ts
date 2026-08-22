import fs from "node:fs/promises";
import path from "node:path";
import type { AssistantEffort, CouncilColour, CouncilMember } from "../../shared/api.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { env } from "./env.js";
import { DEFAULT_NAME, readAssistantConfig } from "./settings-store.js";

/**
 * The council: the advisors this bench keeps, as plain files on the volume.
 *
 * One JSON per member, the way a schedule is one JSON per recurring prompt.
 * A member is data rather than code so adding one is a form on the settings
 * page instead of a redeploy — and so the thing you tune most often, which is
 * what somebody is *for*, is not a thing you have to rebuild an image to change.
 *
 * What is deliberately not a field: anything that could hand a member a shell.
 * The denied built-ins and --strict-mcp-config are fixed in assistant.ts. A
 * settings page that can grant Bash is a settings page that eventually does.
 *
 * The chair is not in this directory. Its identity lives in settings.json where
 * readAssistantConfig() and the unattended path already read it, and it is
 * adapted into the roster on the way out — moving it here would be a settings
 * migration that changes no behaviour.
 */

/** Slugs name files, and are what `@id` addresses, so they may not reach out. */
export const MEMBER_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** The chair's id. Not a file: it is the assistant that was always here. */
export const CHAIR_ID = "chair";

/**
 * Every verksted tool, and whether it is the chair's alone.
 *
 * A copy of what `runtime/verksted-mcp.mjs` offers, because that file is baked
 * into the image at a path the backend build does not import from. The copy is
 * kept honest by a test that drives the real server's tools/list and compares
 * the two — reaching into the .mjs from here would be a parser this repo would
 * then maintain forever.
 *
 * `chairOnly` is where an irreversible thing lives. Starting a session, merging
 * a PR, ending one, changing a schedule, pushing the phone: those are the ones
 * worth regretting, and a council of read-only advisors keeps "the assistant
 * delegates, it does not execute" true of all of them rather than only of the
 * one that was here first.
 *
 * `remember` and `forget` are the exception, and the reason is blast radius
 * rather than trust. For the chair they write the bench's memory, which is
 * carried into every session in every repo; for an advisor the MCP server
 * routes them to that advisor's own store, which nothing outside its own next
 * turn ever reads. An advisor that cannot keep anything has to be told the same
 * thing every morning, which is the problem this whole store exists to solve.
 */
export const TOOL_INVENTORY: { name: string; chairOnly: boolean }[] = [
  { name: "status", chairOnly: false },
  { name: "read_session_output", chairOnly: false },
  { name: "repo_status", chairOnly: false },
  { name: "cluster_status", chairOnly: false },
  { name: "start_session", chairOnly: true },
  { name: "end_session", chairOnly: true },
  { name: "list_prs", chairOnly: false },
  { name: "pr_detail", chairOnly: false },
  { name: "merge_pr", chairOnly: true },
  { name: "ci_runs", chairOnly: false },
  { name: "ci_log", chairOnly: false },
  { name: "ci_rerun", chairOnly: true },
  { name: "list_schedules", chairOnly: false },
  { name: "create_schedule", chairOnly: true },
  { name: "update_schedule", chairOnly: true },
  { name: "run_schedule", chairOnly: true },
  { name: "delete_schedule", chairOnly: true },
  { name: "pause_schedules", chairOnly: true },
  { name: "notify", chairOnly: true },
  { name: "repo_diff", chairOnly: false },
  { name: "recent_prompts", chairOnly: false },
  { name: "propose_memory", chairOnly: false },
  { name: "recall", chairOnly: false },
  { name: "list_memories", chairOnly: false },
  { name: "remember", chairOnly: false },
  { name: "forget", chairOnly: false },
];

const TOOL_NAMES = new Set(TOOL_INVENTORY.map((t) => t.name));
const CHAIR_ONLY = new Set(TOOL_INVENTORY.filter((t) => t.chairOnly).map((t) => t.name));

const COLOURS: CouncilColour[] = ["amber", "violet", "teal", "rose", "sky", "lime"];
const EFFORTS: AssistantEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Carried with every turn of every meeting, so it is on the same budget the persona is. */
export const MAX_PERSONA = 2_000;
export const MAX_REMIT = 200;

export class MemberDeniedError extends Error {}

function filePath(id: string): string {
  return path.join(env.COUNCIL_DIR, `${id}.json`);
}

/**
 * The three the bench starts with, beside the chair.
 *
 * Written on first boot only, and never rewritten: a member edited or deleted
 * by hand stays edited or deleted. Seeding an empty directory is a starting
 * point, not a default the app keeps restoring.
 */
export const SEEDS: Omit<CouncilMember, "chair">[] = [
  {
    id: "michael",
    name: "Michael",
    remit: "the cluster this bench runs in: nodes, ArgoCD, Kargo, what is degraded",
    persona: [
      "You are the one who watches the cluster. A green build is not a deploy:",
      "say whether the thing actually reached Genesis, and if it did not, say",
      "where it stopped. Answer from cluster_status rather than from the PR.",
    ].join("\n"),
    model: "sonnet",
    effort: "low",
    tools: [
      "status",
      "cluster_status",
      "repo_status",
      "list_prs",
      "ci_runs",
      "ci_log",
      "recall",
      "list_memories",
      "remember",
      "forget",
    ],
    web: false,
    colour: "teal",
    voice: "am_michael",
    enabled: true,
  },
  {
    id: "raphael",
    name: "Raphael",
    remit: "the code: open pull requests, review state, what is ready and what is stale",
    persona: [
      "You are the one who reads the code. Say which pull requests are ready and",
      "which are waiting on something, and be specific about what they change —",
      "a count of files is not a review. You do not merge; you say whether it is",
      "safe to.",
    ].join("\n"),
    model: "sonnet",
    effort: "low",
    tools: [
      "status",
      "list_prs",
      "pr_detail",
      "repo_diff",
      "repo_status",
      "ci_runs",
      "ci_log",
      "recall",
      "list_memories",
      "remember",
      "forget",
    ],
    web: false,
    colour: "violet",
    voice: "bm_george",
    enabled: true,
  },
  {
    id: "uriel",
    name: "Uriel",
    remit: "the private half: appointments, errands, notes, the things you would otherwise forget",
    persona: [
      "You are the one who keeps what is not work. You have no calendar and no",
      "notes store: what you know is what has been remembered and what you can",
      "look up, so answer from those and say plainly when a thing has not been",
      "written down anywhere you can reach.",
    ].join("\n"),
    model: "sonnet",
    effort: "low",
    tools: ["status", "recall", "list_memories", "remember", "forget", "propose_memory"],
    web: true,
    colour: "amber",
    voice: "bf_emma",
    enabled: true,
  },
];

/**
 * Validate a member as it goes to disk.
 *
 * At write time rather than at read time, because the file is hand-editable and
 * a bad tool name should be a 400 on the settings page rather than something a
 * child process discovers. Unknown tool names are dropped by the MCP server too
 * — a filter, not a contract — but a name that is a typo should never get that
 * far silently.
 */
export function validate(input: Partial<CouncilMember> & { id: string }): CouncilMember {
  const id = input.id;
  if (!MEMBER_ID_RE.test(id)) throw new MemberDeniedError(`bad member id: ${id}`);
  if (id === CHAIR_ID) throw new MemberDeniedError("the chair is not kept here");
  const name = (input.name ?? "").trim();
  if (!name) throw new MemberDeniedError("a member needs a name");
  const remit = (input.remit ?? "").trim().slice(0, MAX_REMIT);
  if (!remit) throw new MemberDeniedError("a member needs a remit");
  const tools = input.tools ?? [];
  for (const t of tools) {
    if (!TOOL_NAMES.has(t)) throw new MemberDeniedError(`no such tool: ${t}`);
    if (CHAIR_ONLY.has(t)) throw new MemberDeniedError(`${t} is the chair's alone`);
  }
  const effort = EFFORTS.includes(input.effort as AssistantEffort)
    ? (input.effort as AssistantEffort)
    : "low";
  const colour = COLOURS.includes(input.colour as CouncilColour)
    ? (input.colour as CouncilColour)
    : "teal";
  return {
    id,
    name,
    remit,
    persona: (input.persona ?? "").trim().slice(0, MAX_PERSONA),
    model: (input.model ?? "").trim() || env.ASSISTANT_MODEL,
    effort,
    tools: [...new Set(tools)],
    web: input.web === true,
    colour,
    // Not checked against the model's list here: this runs on the way out as
    // well, and a pod that lost its voice model would then lose its roster with
    // it. The name is checked at the route, where there is a request to refuse.
    voice: (input.voice ?? "").trim().slice(0, 40),
    chair: false,
    enabled: input.enabled !== false,
  };
}

async function readMember(id: string): Promise<CouncilMember | null> {
  try {
    const raw = await fs.readFile(filePath(id), "utf8");
    const parsed = JSON.parse(raw) as CouncilMember;
    // Validated on the way out too: a file edited by hand is the same input as
    // a form post, and a torn or wrong one should read as a missing member
    // rather than take a request down.
    return validate({ ...parsed, id });
  } catch {
    return null;
  }
}

/** The chair, adapted from settings.json into a roster entry. */
export async function chair(): Promise<CouncilMember> {
  const config = await readAssistantConfig();
  return {
    id: CHAIR_ID,
    name: config.name || DEFAULT_NAME,
    remit: "the bench: what needs you, and putting agents on the work",
    persona: "",
    model: config.model,
    effort: config.effort,
    tools: TOOL_INVENTORY.map((t) => t.name),
    web: true,
    colour: "amber",
    // The chair keeps the per-device voice the settings page already sets.
    voice: "",
    chair: true,
    enabled: true,
  };
}

/** Everyone but the chair, by id. */
export async function listMembers(): Promise<CouncilMember[]> {
  const files = await fs.readdir(env.COUNCIL_DIR).catch(() => []);
  const members: CouncilMember[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const member = await readMember(file.slice(0, -5));
    if (member) members.push(member);
  }
  return members.sort((a, b) => a.name.localeCompare(b.name));
}

/** The whole roster, chair first — what the settings page and the chair see. */
export async function listCouncil(): Promise<CouncilMember[]> {
  return [await chair(), ...(await listMembers())];
}

/** One member by id, chair included, or null. */
export async function getMember(id: string): Promise<CouncilMember | null> {
  return id === CHAIR_ID ? chair() : readMember(id);
}

export async function saveMember(
  input: Partial<CouncilMember> & { id: string },
): Promise<CouncilMember> {
  const member = validate(input);
  await fs.mkdir(env.COUNCIL_DIR, { recursive: true });
  await writeJsonAtomic(filePath(member.id), member);
  return member;
}

export async function deleteMember(id: string): Promise<boolean> {
  if (id === CHAIR_ID) throw new MemberDeniedError("the chair cannot be removed");
  if (!MEMBER_ID_RE.test(id)) return false;
  try {
    await fs.unlink(filePath(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the starting roster, once, into an empty directory.
 *
 * Empty rather than missing-by-id: seeding per member would resurrect one that
 * was deliberately removed, every boot, and a member you cannot get rid of is
 * worse than no member at all.
 */
export async function seedCouncil(): Promise<void> {
  await fs.mkdir(env.COUNCIL_DIR, { recursive: true });
  const files = await fs.readdir(env.COUNCIL_DIR).catch(() => []);
  if (files.some((f) => f.endsWith(".json"))) return;
  for (const seed of SEEDS) await saveMember(seed);
}
