import type { AssistantEntry, CouncilMember } from "../../shared/api.js";
import { CHAIR_ID, getMember, listMembers } from "./council-store.js";

/**
 * The council's meetings as words: how the chair asks for one, who that names,
 * and what each speaker is handed. Nothing here runs a turn or holds a thread;
 * `assistant.ts` does, for the chat and for unattended runs alike.
 */

/**
 * How the chair says it wants advisors: the first line of its reply, and
 * nothing else in it.
 *
 * Prose rather than a tool call, and that is a cost decision as much as a
 * simplicity one. A tool costs the round trip that emits it and the round trip
 * that reads its result; a first line costs neither, and this bench already
 * reads a verdict out of a model's own first word — the ok:/attention:/failed:
 * contract is exactly this, and it has held. A first line that does not match
 * is simply an answer, so the failure mode is a meeting that did not happen,
 * which is visible and cheap.
 */
const CONVENE_RE = /^(convene|discuss):\s*([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)\s*$/im;

/** No more than this many advisors in one meeting the chair called for itself. */
export const MAX_CONVENED = 3;

/**
 * The word that means the whole room, typed as `@all` or written by the chair
 * as `convene: all`.
 *
 * It is not a member id — `MEMBER_ID_RE` would let somebody create an advisor
 * called `all`, and this shadows it deliberately: addressing everybody is worth
 * more than one advisor's name, and the settings page can rename them.
 */
const EVERYONE = "all";

/**
 * A higher ceiling for a meeting somebody asked for by name.
 *
 * `MAX_CONVENED` guards against a model calling a meeting nobody wanted; this
 * one guards against nothing but a runaway roster, since asking everybody is an
 * explicit instruction. Whoever is left out is named in the mark rather than
 * quietly dropped: a meeting that says "everyone" and means "the first six" is
 * lying about what it did.
 */
export const MAX_EVERYONE = 6;

/** Everybody who takes part in meetings, and how many the ceiling left out. */
async function theRoom(): Promise<{ members: CouncilMember[]; dropped: number }> {
  const all = (await listMembers()).filter((m) => m.enabled);
  return {
    members: all.slice(0, MAX_EVERYONE),
    dropped: Math.max(0, all.length - MAX_EVERYONE),
  };
}

/** What the mark says: who answered, and who the ceiling left out. */
export const meetingDetail = (members: CouncilMember[], dropped: number): string =>
  `${members.map((m) => m.name).join(", ")}${dropped ? ` (+${dropped} not asked)` : ""}`;

/**
 * Who the chair asked for, and whether they are to hear each other.
 *
 * The ceiling is enforced here rather than trusted to the prompt: a ceiling a
 * model is merely asked to respect is not a ceiling, and this one is what
 * stands between a question and an unbounded number of model calls.
 *
 * `round` is demoted for a single name, because a round table of one is a
 * convening with a longer prompt and a chip that would say something untrue.
 */
async function convened(
  text: string,
  forceRound = false,
): Promise<{ members: CouncilMember[]; round: boolean; everyone: boolean; dropped: number }> {
  const line = text.trim().split("\n")[0] ?? "";
  const match = CONVENE_RE.exec(line);
  if (!match) return { members: [], round: false, everyone: false, dropped: 0 };
  const [, verb = "", list = ""] = match;
  const ids = [...new Set(list.split(",").map((id) => id.trim()))];
  const wantsRound = forceRound || verb.toLowerCase() === "discuss";
  // `all` is the whole room and cannot be mixed with names: it already is the
  // names, and reading "all, michael" as anything but everybody would be
  // guessing at what the chair meant.
  if (ids.includes(EVERYONE)) {
    const { members, dropped } = await theRoom();
    return { members, round: wantsRound && members.length > 1, everyone: true, dropped };
  }
  const members: CouncilMember[] = [];
  for (const id of ids) {
    if (members.length >= MAX_CONVENED) break;
    if (id === CHAIR_ID) continue;
    const member = await getMember(id);
    if (member && member.enabled) members.push(member);
  }
  return { members, round: wantsRound && members.length > 1, everyone: false, dropped: 0 };
}

/**
 * Who is addressed directly, if anyone: a leading `@id`.
 *
 * The one way past the chair's judgement, for when you already know who you
 * want. Cheaper than a meeting by every measure, and it is what makes a wrong
 * routing call something you can work around rather than argue with.
 */
export interface Addressed {
  members: CouncilMember[];
  rest: string;
  /** `@all`: everybody answers, and the chair closes rather than routing. */
  everyone: boolean;
  dropped: number;
}

export async function addressed(prompt: string): Promise<Addressed | null> {
  const match = /^@([a-z][a-z0-9-]{0,31})\b\s*([\s\S]*)$/.exec(prompt.trim());
  if (!match) return null;
  const [, name = "", body = ""] = match;
  const rest = body.trim();
  if (!rest) return null;
  if (name === EVERYONE) {
    const { members, dropped } = await theRoom();
    return members.length ? { members, rest, everyone: true, dropped } : null;
  }
  const member = await getMember(name);
  if (!member || !member.enabled || member.chair) return null;
  return { members: [member], rest, everyone: false, dropped: 0 };
}

/**
 * The advisors a reply asked for, and whatever else it said.
 *
 * The contract asks for the line alone, and a reply that is only the line is
 * still the common case. What this also reads is the line last, after a
 * sentence saying whose the question is, because that is what the chair
 * actually writes often enough to matter and the cost of not reading it is the
 * worst failure this has: `convene: uriel` lands in the conversation as prose,
 * nobody is convened, the question goes unanswered, and the person is left
 * looking at the machinery. A line first with prose after it is read the same
 * way, for the same reason.
 *
 * A line in the middle is not read. That is a reply about convening rather than
 * one asking for it, and guessing between the two would put the chair's own
 * words on a meeting it did not call.
 */
export function conveneRequest(text: string): { line: string; rest: string } | null {
  const lines = text.trim().split("\n");
  const at = (i: number) => lines[i]?.trim() ?? "";
  if (CONVENE_RE.test(at(0))) {
    return { line: at(0), rest: lines.slice(1).join("\n").trim() };
  }
  if (lines.length > 1 && CONVENE_RE.test(at(lines.length - 1))) {
    return { line: at(lines.length - 1), rest: lines.slice(0, -1).join("\n").trim() };
  }
  return null;
}

/**
 * What the chair is handed once the advisors have answered.
 *
 * Trimmed per answer, because this lands in the chair's own conversation and is
 * re-sent with every later turn of it. An advisor asked for two or three
 * sentences and given a cap is an advisor whose cost is bounded even when it
 * ignores the first half of that.
 */
const MAX_ANSWER = 1_200;

export function briefing(
  question: string,
  answers: { name: string; text: string }[],
  round = false,
): string {
  return [
    round
      ? "The council talked it over, each of them having heard the ones before. Now give the person the answer."
      : "The council answered. Now give the person the answer.",
    "",
    `They asked: ${question}`,
    "",
    ...answers.map((a) => `${a.name}: ${a.text.slice(0, MAX_ANSWER)}`),
    "",
    ...(round
      ? [
          "Where they disagreed, say who you think is right and why, in a line. An",
          "unresolved disagreement is the one thing worth spending words on here.",
          "",
        ]
      : []),
    "Say what it means and what to do, in two or three sentences. Do not repeat",
    "their answers back; they are on the screen above yours. Do not convene",
    "anyone: this is the last word on this question.",
  ].join("\n");
}

/**
 * What an advisor is asked when it is not the first to speak.
 *
 * The others' answers travel in the prompt rather than in its conversation,
 * because each advisor resumes its own claude thread across a whole chat: what
 * somebody said about today's question would otherwise still be in its context
 * next week, presented as something it knew.
 *
 * Trimmed per answer for the same reason the briefing is, and asked for
 * disagreement explicitly — three advisors politely agreeing with each other is
 * three calls that could have been one.
 */
export function tableTurn(question: string, said: { name: string; text: string }[]): string {
  if (!said.length) return question;
  return [
    "Round table. You are answering after the others, and they can be wrong.",
    "",
    `The question: ${question}`,
    "",
    "Said so far:",
    ...said.map((a) => `${a.name}: ${a.text.slice(0, MAX_ANSWER)}`),
    "",
    "Answer your part of it in two or three sentences. Say where you disagree",
    "with what is above, and name who you are disagreeing with. Do not repeat a",
    "point somebody has already made, and do not agree out loud just to have",
    "said something: if you have nothing to add, say that in one line.",
  ].join("\n");
}

/**
 * What the chair is told when the round-table switch is on.
 *
 * In the prompt rather than in the system prompt because the switch is per
 * turn, and the chair's system prompt is written once for a conversation it
 * resumes. It is a nudge and not a command: a question that is genuinely
 * nobody's on the council should still be answered by the chair alone rather
 * than put to a table that has nothing to say about it.
 */
export const ROUND_TABLE_ASKED = [
  "",
  "(The round table switch is on: they have asked to hear the council talk this",
  "over. Put it to two or three of them with a first line of discuss: unless it",
  "is genuinely nobody's, in which case answer it yourself as usual.)",
].join("\n");

/**
 * What a reply the chair held back becomes: the entry that goes on record, and
 * who is to answer.
 *
 * One place for the chat and for an unattended run, which each used to build
 * the mark themselves. That is how A-04 came to be fixed in one of them only.
 * Nobody real named means the reply lands as written: it is an answer, however
 * odd, and swallowing it would leave the turn silent.
 *
 * The line itself is an instruction to this code and reads as noise in a
 * conversation; that three advisors were asked is the thing worth seeing, and
 * it is what makes a wrong routing call visible rather than silent. Whatever
 * tools the chair used to decide stay on the entry: they were the work.
 * Anything it said beside the line is kept too: "that one is Uriel's" is the
 * chair doing its job out loud.
 *
 * `rounds` is "never" where nobody is reading, since a round table is for a
 * question someone is waiting on.
 */
export async function openMeeting(
  held: AssistantEntry,
  rounds: "asked" | "forced" | "never" = "asked",
): Promise<{ entry: AssistantEntry; called: CouncilMember[]; round: boolean }> {
  const request = conveneRequest(held.text);
  const { members, round, everyone, dropped } = await convened(
    request?.line ?? held.text,
    rounds === "forced",
  );
  if (!members.length) return { entry: held, called: [], round: false };
  const asRound = round && rounds !== "never";
  return {
    entry: {
      ...held,
      text: request?.rest ?? "",
      tools: [
        ...held.tools,
        {
          name: asRound ? "discuss" : everyone ? "everyone" : "convene",
          detail: meetingDetail(members, dropped),
        },
      ],
    },
    called: members,
    round: asRound,
  };
}
