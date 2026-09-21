import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedItem, Session as SessionInfo } from "../../shared/api";
import { resetPollCache } from "../src/api";
import ConnectionBanner from "../src/components/ConnectionBanner";
import HashScroll from "../src/components/HashScroll";
import { reportReachable, reportUnreachable } from "../src/connection";
import Inbox from "../src/screens/Inbox";
import Project from "../src/screens/Project";
import Session from "../src/screens/Session";
import Today from "../src/screens/Today";

/**
 * Part 5's navigation findings: F-34, view state that lived in component state
 * and so reset on every reload — which on iOS, evicting a backgrounded app as
 * often as it does, is every other time you come back to one — and a scroll
 * position carried from one screen into the next; and F-33, the offline banner
 * lying over the back arrow at exactly the moment you want to leave.
 */
const at = (): FeedItem => ({
  id: "",
  source: "github",
  urgency: "new",
  state: "new",
  title: "",
  detail: "",
  facts: [],
  at: new Date().toISOString(),
  until: null,
  link: null,
  loop: null,
  did: null,
  triaged: true,
  pushed: false,
  version: "1",
  from: null,
});
const feed: FeedItem[] = [
  { ...at(), id: "github-1", source: "github", title: "review the parser PR" },
  { ...at(), id: "mail-1", source: "mail", title: "the invoice from the landlord" },
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => Promise.resolve(json(url.startsWith("/api/feed") ? feed : []))),
  );
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  cleanup();
  resetPollCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Where the router is, read from inside it. */
const seen = { where: "" };
function Where() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    seen.where = pathname + search;
  }, [pathname, search]);
  return null;
}

describe("the inbox's filters", () => {
  const inbox = (url: string) =>
    render(
      <MemoryRouter initialEntries={[url]}>
        <Inbox />
        <Where />
      </MemoryRouter>,
    );

  it("come back as they were left", async () => {
    inbox("/runs?source=mail");
    expect(await screen.findByText("the invoice from the landlord")).toBeTruthy();
    expect(screen.queryByText("review the parser PR")).toBeNull();
  });

  it("are written where a reload will find them, without a history entry each", async () => {
    inbox("/runs");
    await screen.findByText("review the parser PR");
    fireEvent.click(screen.getByRole("button", { name: /^mail/ }));

    await waitFor(() => expect(seen.where).toBe("/runs?source=mail"));
    expect(screen.queryByText("review the parser PR")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^all/ }));
    await waitFor(() => expect(seen.where).toBe("/runs"));
  });

  it("treat a source nothing in the app has as no filter at all", async () => {
    inbox("/runs?source=nonsense");
    expect(await screen.findByText("review the parser PR")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^all/ }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the project's tab", () => {
  const project = (url: string) =>
    render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/p/:name" element={<Project />} />
        </Routes>
        <Where />
      </MemoryRouter>,
    );
  const pressed = (name: string) =>
    screen
      .getAllByRole("button", { name: new RegExp(`^${name}`) })
      .find((b) => b.hasAttribute("aria-pressed"))!
      .getAttribute("aria-pressed");

  it("comes back on the tab it was left on", () => {
    project("/p/demo?tab=schedules");
    expect(pressed("schedules")).toBe("true");
    expect(pressed("sessions")).toBe("false");
  });

  it("is written into the URL, and the default leaves it clean", async () => {
    project("/p/demo");
    fireEvent.click(screen.getAllByRole("button", { name: /^actions/ })[0]);
    await waitFor(() => expect(seen.where).toBe("/p/demo?tab=actions"));
    fireEvent.click(screen.getAllByRole("button", { name: /^sessions/ })[0]);
    await waitFor(() => expect(seen.where).toBe("/p/demo"));
  });
});

describe("a session's side panel", () => {
  // Finished, so the screen draws no live terminal for jsdom to choke on.
  const session = {
    id: "vk-demo-1",
    project: "demo",
    agent: "claude",
    title: "fix the parser",
    createdAt: new Date().toISOString(),
    endedAt: null,
    status: "done",
    report: null,
    outcome: "done",
    work: null,
    usage: null,
    measured: true,
    lastActivityAt: null,
    review: { verdict: null, note: null, at: null },
    unattended: null,
  } as unknown as SessionInfo;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          json(
            url.startsWith("/api/sessions/vk-demo-1")
              ? session
              : url.endsWith("/git")
                ? { branch: "main", files: [] }
                : url.endsWith("/tree")
                  ? { nodes: [], truncated: false }
                  : [],
          ),
        ),
      ),
    );
  });

  const open = (url: string) =>
    render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/s/:id" element={<Session />} />
        </Routes>
        <Where />
      </MemoryRouter>,
    );
  const tab = async (name: string) =>
    within(await screen.findByRole("group", { name: "side panel" })).getByRole("button", {
      name: new RegExp(`^${name}`),
    });

  it("comes back on the tab it was left on", async () => {
    open("/s/vk-demo-1?pane=tree&side=git");
    expect((await tab("git")).getAttribute("aria-pressed")).toBe("true");
    expect((await tab("files")).getAttribute("aria-pressed")).toBe("false");
  });

  it("still takes the inbox's link to a run's diff, which names only the side", async () => {
    open("/s/vk-demo-1?side=changes");
    expect((await tab("changes")).getAttribute("aria-pressed")).toBe("true");
  });

  it("is written into the URL when it changes", async () => {
    open("/s/vk-demo-1");
    fireEvent.click(await tab("search"));
    await waitFor(() => expect(seen.where).toContain("side=search"));
    expect((await tab("search")).getAttribute("aria-pressed")).toBe("true");
  });
});

/**
 * F-10. The answer's sheet on Today ignored every way out while the turn ran —
 * and a turn is allowed eleven minutes. Back was the worst of them: it popped
 * the sheet's history entry without closing the sheet, and the next Back left
 * the screen from behind it. The turn is posted to the thread either way.
 */
describe("a question asked from Today", () => {
  it("can be put away while it is answered, and brought back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        // The turn, still running — and every read but the one naming the
        // assistant, which leaves the rest of the screen on its skeletons.
        url === "/api/assistant/config" && !init?.method
          ? Promise.resolve(json({ name: "Gabriel" }))
          : new Promise(() => {}),
      ),
    );
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    render(
      <MemoryRouter>
        <Today />
      </MemoryRouter>,
    );
    const box = await screen.findByPlaceholderText(/^ask /);
    fireEvent.change(box, { target: { value: "what is on tomorrow?" } });
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/working on “what is on tomorrow\?”/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "show" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("a link followed from halfway down a page", () => {
  function Screen() {
    const navigate = useNavigate();
    return (
      <>
        <Link to="/p/demo">open the project</Link>
        <button onClick={() => navigate("/bench?tab=x", { replace: true })}>filter</button>
      </>
    );
  }

  it("lands at the top of the next one — and a filter on this one does not", () => {
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    render(
      <MemoryRouter initialEntries={["/bench"]}>
        <HashScroll />
        <Screen />
      </MemoryRouter>,
    );
    scrollTo.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "filter" }));
    expect(scrollTo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("open the project"));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});

describe("the offline banner", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it("tells the top bars how much of the screen it is standing on", () => {
    // jsdom lays nothing out, so the height is given; a browser measures it.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(52);
    render(<ConnectionBanner />);
    const published = () => document.documentElement.style.getPropertyValue("--banner-h");
    expect(published()).toBe("");

    act(() => {
      reportUnreachable();
      reportUnreachable();
    });
    expect(screen.getByRole("status")).toBeTruthy();
    expect(published()).toBe("52px");

    // And gives the room back the moment the pod answers.
    act(() => reportReachable());
    expect(screen.queryByRole("status")).toBeNull();
    expect(published()).toBe("");
  });
});
