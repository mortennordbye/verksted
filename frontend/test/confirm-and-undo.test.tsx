import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Loop, Settings as SettingsInfo } from "../../shared/api";
import { resetPollCache } from "../src/api";
import SearchPanel from "../src/components/SearchPanel";
import Inbox from "../src/screens/Inbox";
import Settings from "../src/screens/Settings";

/**
 * F-30, F-31 and F-36 from part 5: taps that could not be taken back, the one
 * way back there was sitting where nobody could see it, and a search hit that
 * opened its file at the top.
 */
let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const posted = (match: string) =>
  (fetchMock.mock.calls as [string, RequestInit?][]).filter(
    ([url, init]) => url.includes(match) && init?.method,
  );

afterEach(() => {
  cleanup();
  resetPollCache();
  vi.unstubAllGlobals();
});

describe("a stored credential", () => {
  const settings: SettingsInfo = {
    server: {},
    vars: [{ key: "GH_TOKEN", source: "settings", fingerprint: "…a1b2" }],
    schedulesPaused: false,
    blockedOwners: [],
  };

  beforeEach(() => {
    fetchMock = vi.fn((url: string) =>
      Promise.resolve(json(url.startsWith("/api/settings") ? settings : [])),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  const draw = () =>
    render(
      <MemoryRouter initialEntries={["/settings?tab=agents"]}>
        <Settings />
      </MemoryRouter>,
    );

  it("is not removed by one tap", async () => {
    draw();
    fireEvent.click(await screen.findByRole("button", { name: "clear" }));

    const dialog = await screen.findByRole("dialog", { name: "Remove GH_TOKEN?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted("/api/settings")).toHaveLength(0);
  });

  it("is removed once that is what was said", async () => {
    draw();
    fireEvent.click(await screen.findByRole("button", { name: "clear" }));
    fireEvent.click(await screen.findByRole("button", { name: "remove it" }));

    await waitFor(() => expect(posted("/api/settings")).toHaveLength(1));
    expect(JSON.parse(posted("/api/settings")[0][1]!.body as string)).toEqual({
      vars: { GH_TOKEN: null },
    });
  });
});

describe("a loop closed from the inbox", () => {
  const loop: Loop = {
    slug: "chase-the-plumber",
    what: "chase the plumber",
    who: null,
    from: null,
    due: null,
    state: "open",
    openedAt: new Date().toISOString(),
    closedAt: null,
  };

  beforeEach(() => {
    fetchMock = vi.fn((url: string, init?: RequestInit) =>
      Promise.resolve(json(init?.method ? loop : url.startsWith("/api/loops") ? [loop] : [])),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  it("can be opened again from where the tap was made", async () => {
    render(
      <MemoryRouter>
        <Inbox />
      </MemoryRouter>,
    );
    await screen.findByText("chase the plumber");
    fireEvent.click(screen.getByRole("button", { name: "close" }));

    // The offer floats over the screen rather than sitting above the first
    // row, where on a phone it was four screens up from the row you tapped.
    const offer = await screen.findByRole("status");
    expect(offer.textContent).toContain("closed “chase the plumber”");
    fireEvent.click(within(offer).getByRole("button", { name: "undo" }));

    await waitFor(() => expect(posted("/api/loops/chase-the-plumber/reopen")).toHaveLength(1));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("a repo search hit", () => {
  it("opens its file on the line it matched", async () => {
    fetchMock = vi.fn(() =>
      Promise.resolve(
        json([
          { path: "src/parse.ts", line: 3, text: "const x = 1" },
          { path: "src/parse.ts", line: 212, text: "return tokens" },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onOpenFile = vi.fn();
    render(<SearchPanel project="demo" onOpenFile={onOpenFile} />);

    const box = screen.getByLabelText("search this repo");
    fireEvent.change(box, { target: { value: "tokens" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(await screen.findByText("return tokens"));

    expect(onOpenFile).toHaveBeenCalledWith("src/parse.ts", 212);
  });
});
