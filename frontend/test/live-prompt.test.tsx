import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, TuiPrompt } from "../../shared/api";
import LivePrompt from "../src/components/chat/LivePrompt";

/**
 * The strip that answers a dialog nobody can see.
 *
 * Everything else in the chat view renders the transcript, which is written
 * down and can be read again. This renders a scrape of a terminal, and acts on
 * it — so what matters is not how it looks but what it is capable of pressing
 * when the scrape came back empty.
 */
const session = (status: Session["status"]): Session =>
  ({ id: "vk-demo-1", project: "demo", agent: "claude", status }) as Session;

const prompt: TuiPrompt = {
  question: "Do you want to make this edit to paths.ts?",
  options: [
    { number: 1, label: "Yes", selected: true },
    { number: 2, label: "No, tell Claude what to do differently", selected: false },
  ],
  multiSelect: false,
};

function draw(status: Session["status"], p: TuiPrompt | null) {
  const onAnswer = vi.fn();
  const onKey = vi.fn();
  const onOpenTerminal = vi.fn();
  render(
    <LivePrompt
      session={session(status)}
      prompt={p}
      onAnswer={onAnswer}
      onKey={onKey}
      onOpenTerminal={onOpenTerminal}
      sending={false}
    />,
  );
  return { onAnswer, onKey, onOpenTerminal };
}

afterEach(cleanup);

describe("LivePrompt", () => {
  it("answers a dialog it could read by its number, and nothing else", () => {
    const { onAnswer, onKey } = draw("waiting", prompt);
    fireEvent.click(screen.getByRole("button", { name: /No, tell Claude/ }));
    expect(onAnswer).toHaveBeenCalledWith("2");
    expect(onKey).not.toHaveBeenCalled();
  });

  /**
   * The bug this pins.
   *
   * The unparsed case used to offer "yes" and "no", both of which typed a
   * letter and pressed Return. Return does not submit a choice on these
   * dialogs — it takes whatever the cursor is resting on, which is normally
   * the first option — so "no" approved the very thing it was tapped to
   * refuse. And it could only ever happen on a dialog the parser had failed
   * to read, which is exactly where nobody knew what was being approved.
   */
  it("offers nothing that answers a dialog it could not read", () => {
    const { onAnswer, onKey, onOpenTerminal } = draw("waiting", null);
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["open terminal", "esc"]);

    fireEvent.click(screen.getByRole("button", { name: "esc" }));
    expect(onKey).toHaveBeenCalledWith("escape");
    expect(onAnswer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "open terminal" }));
    expect(onOpenTerminal).toHaveBeenCalled();
  });

  it("draws nothing at all when the session is not waiting on anyone", () => {
    const { container } = render(
      <LivePrompt
        session={session("done")}
        prompt={prompt}
        onAnswer={vi.fn()}
        onKey={vi.fn()}
        onOpenTerminal={vi.fn()}
        sending={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
