import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantEntry, AssistantThread, CouncilMember } from "../../shared/api";
import Room from "../src/components/Room";

const chair: CouncilMember = {
  id: "chair",
  name: "Gabriel",
  remit: "",
  persona: "",
  model: "",
  effort: "low",
  tools: [],
  web: false,
  colour: "amber",
  face: "raccoon",
  voice: "",
  chair: true,
  enabled: true,
};

let n = 0;
function entry(role: "user" | "assistant", text: string, extra: Partial<AssistantEntry> = {}) {
  return { id: `e${++n}`, role, text, tools: [], at: new Date().toISOString(), ...extra };
}

function thread(entries: AssistantEntry[], status: "idle" | "thinking" = "idle"): AssistantThread {
  return { conversationId: "c", status, entries };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Room (C-30)", () => {
  it("copies a reply as it was written, markdown and all", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <Room
        thread={thread([entry("user", "plan?"), entry("assistant", "Do **this** first.")])}
        members={[]}
        chair={chair}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "copy this message" }));
    expect(writeText).toHaveBeenCalledWith("Do **this** first.");
  });

  it("offers to ask again when the last reply failed, with what was asked", () => {
    const onRetry = vi.fn();
    render(
      <Room
        thread={thread([
          entry("user", "what is degraded?", { images: ["shot.png"] }),
          entry("assistant", "Not logged in", { failed: true }),
        ])}
        members={[]}
        chair={chair}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /try again/ }));
    expect(onRetry).toHaveBeenCalledWith("what is degraded?", ["shot.png"]);
  });

  it("does not offer it for a failure further up, or while a turn is running", () => {
    const entries = [
      entry("user", "first"),
      entry("assistant", "Not logged in", { failed: true }),
      entry("user", "second"),
      entry("assistant", "Here now.", { at: new Date(Date.now() + 600_000).toISOString() }),
    ];
    const { rerender } = render(
      <Room thread={thread(entries)} members={[]} chair={chair} onRetry={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: /try again/ })).toBeNull();

    rerender(
      <Room
        thread={thread(entries.slice(0, 2), "thinking")}
        members={[]}
        chair={chair}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /try again/ })).toBeNull();
  });
});
