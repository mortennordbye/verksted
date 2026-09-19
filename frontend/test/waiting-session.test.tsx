import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, SessionPrompt } from "../../shared/api";
import { resetPollCache } from "../src/api";
import WaitingSession from "../src/components/WaitingSession";

/**
 * The inbox row that answers an agent from the lock screen.
 *
 * What is under test is not the layout but the reach: which requests this row
 * makes while it sits in a list of ten, and what it is capable of pressing on
 * a dialog nobody has read.
 */
const session = {
  id: "vk-demo-1",
  project: "demo",
  agent: "claude",
  status: "waiting",
  title: "fix the parser",
  createdAt: new Date().toISOString(),
} as Session;

const dialog: SessionPrompt = {
  prompt: {
    question: "Do you want to make this edit to paths.ts?",
    multiSelect: false,
    options: [
      { number: 1, label: "Yes", selected: true },
      { number: 2, label: "No, tell Claude what to do differently", selected: false },
    ],
  },
  mode: null,
  busy: false,
  doing: null,
};

let fetchMock: ReturnType<typeof vi.fn>;

const answer = (url: string, body: unknown) =>
  fetchMock.mockImplementation((u: string) =>
    Promise.resolve(
      new Response(JSON.stringify(u.includes(url) ? body : {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  resetPollCache();
  vi.unstubAllGlobals();
});

const draw = () =>
  render(
    <MemoryRouter>
      <WaitingSession session={session} />
    </MemoryRouter>,
  );

describe("WaitingSession", () => {
  /**
   * The bug this pins. The row used to carry "yes" and "no" beside a collapsed
   * body, and both typed a letter and pressed Return into a dialog the reader
   * had not seen. Return takes whatever the cursor rests on rather than the
   * letter typed, which is normally the first option — so "no" approved.
   */
  it("offers no answer at all until the output has been shown", () => {
    draw();
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["show and answer"]);
    expect(screen.queryByRole("button", { name: "yes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "no" })).toBeNull();
  });

  // Ten waiting sessions is ten rows, and each capture is a tmux call.
  it("asks the pod nothing while it is collapsed", () => {
    draw();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers the dialog's own option by its number, with no Return", async () => {
    answer("/prompt", dialog);
    draw();
    fireEvent.click(screen.getByRole("button", { name: "show and answer" }));

    const option = await screen.findByRole("button", { name: /No, tell Claude/ });
    fireEvent.click(option);

    const call = (fetchMock.mock.calls as [string, RequestInit][]).find(([u]) =>
      u.endsWith("/input"),
    );
    expect(JSON.parse(call?.[1].body as string)).toEqual({ text: "2", enter: false });
  });
});
