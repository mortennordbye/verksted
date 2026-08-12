import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionChanges } from "../../shared/api";
import ChangesPanel from "../src/components/ChangesPanel";

const changes = (over: Partial<SessionChanges> = {}): SessionChanges => ({
  from: "1111111111111111111111111111111111111111",
  to: "2222222222222222222222222222222222222222",
  commits: [{ sha: "abc1234", subject: "tidy the schedules" }],
  files: [
    { path: "backend/src/git.ts", added: 12, removed: 3, binary: false },
    { path: "logo.png", added: 0, removed: 0, binary: true },
  ],
  truncated: false,
  review: { files: [], reviewed: 0, verdict: null },
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const answer = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );

describe("ChangesPanel", () => {
  it("shows the range, its commits and its files", async () => {
    answer(changes());
    render(<ChangesPanel sessionId="vk-demo-1" live={false} onOpenDiff={() => {}} />);

    expect(await screen.findByText("tidy the schedules")).toBeDefined();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sessions/vk-demo-1/changes");
    expect(screen.getByText("1111111..2222222")).toBeDefined();
    expect(screen.getByText("git.ts")).toBeDefined();
    expect(screen.getByText("+12")).toBeDefined();
    // A binary file has no line counts to show, and saying "+0 −0" would read
    // as "nothing changed".
    expect(screen.getByText("binary")).toBeDefined();
  });

  it("asks for the file's diff when a file is picked", async () => {
    answer(changes());
    const onOpenDiff = vi.fn();
    render(<ChangesPanel sessionId="vk-demo-1" live={false} onOpenDiff={onOpenDiff} />);

    fireEvent.click(await screen.findByText("git.ts"));
    expect(onOpenDiff).toHaveBeenCalledWith("backend/src/git.ts");
  });

  it("says a session that committed nothing committed nothing", async () => {
    answer(changes({ commits: [], files: [] }));
    render(<ChangesPanel sessionId="vk-demo-1" live={false} onOpenDiff={() => {}} />);
    expect(await screen.findByText(/nothing committed/)).toBeDefined();
  });

  it("says so when there is no range rather than showing an empty one", async () => {
    answer(changes({ from: null, to: null, commits: [], files: [] }));
    render(<ChangesPanel sessionId="vk-demo-1" live={false} onOpenDiff={() => {}} />);
    expect(await screen.findByText(/did not start in a git repo/)).toBeDefined();
  });

  // A reset branch answers 409: the range is unreadable, and reporting that as
  // "no changes" would clear a run that may well have done something.
  it("shows the backend's reason when the range cannot be read", async () => {
    answer({ error: "fatal: bad revision" }, 409);
    render(<ChangesPanel sessionId="vk-demo-1" live={false} onOpenDiff={() => {}} />);
    expect(await screen.findByText("fatal: bad revision")).toBeDefined();
  });
});
