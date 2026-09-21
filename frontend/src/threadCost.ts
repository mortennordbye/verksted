import type { AssistantThreadUsage } from "../../shared/api";
import { tokens, usd } from "./format";

/**
 * The prompt size at which a thread is called long. Half of what the model
 * holds: past it a turn is mostly the conversation being sent again, and the
 * plan is charged for every token of that, cached or not.
 */
const LONG_CONTEXT = 100_000;

/**
 * What a thread has taken and whether it has grown long, as the chat says it.
 *
 * The prompt the chair last sent is the thing itself. The reply count stands in
 * for it on a thread from before turns were measured: every reply is a model
 * call carrying the whole conversation, and a meeting is several.
 */
export function threadCost(
  usage: AssistantThreadUsage | undefined,
  replies: number,
): { long: boolean; taken: string; carries: string } {
  if (!usage) {
    return {
      long: replies >= 15,
      taken: "",
      carries: `${replies} replies in this thread, and every new one carries all of them.`,
    };
  }
  const t = usage.total;
  const cost = t.costUsd ? ` (${usd(t.costUsd)})` : "";
  return {
    long: usage.context >= LONG_CONTEXT,
    taken: `${tokens(t.input + t.output + t.cacheRead + t.cacheWrite)} tokens${cost}`,
    carries: `Every new turn now carries ${tokens(usage.context)} tokens of this thread.`,
  };
}
