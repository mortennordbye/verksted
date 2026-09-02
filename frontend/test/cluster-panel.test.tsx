import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterSnapshot } from "../../shared/api";
import ClusterPanel from "../src/components/ClusterPanel";

const NODES = "NAME     STATUS   ROLES\ntalos-1  Ready    control-plane\ntalos-2  Ready    <none>";
const PODS = "NAMESPACE  NAME      READY  STATUS\nargocd     repo-abc  0/1    CrashLoopBackOff";

const snapshot = (over: Partial<ClusterSnapshot> = {}): ClusterSnapshot => ({
  reachable: true,
  sections: [
    { title: "NODES", text: NODES },
    { title: "UNHEALTHY PODS", text: PODS },
    { title: "RECENT WARNINGS", text: "(none)" },
  ],
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

/** The tables are drawn in a <pre>, so their whitespace is the content. */
const asWritten = { normalizer: (text: string) => text };

const answer = (body: unknown) =>
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

describe("ClusterPanel", () => {
  it("counts each section's rows and opens the ones that want looking at", async () => {
    answer(snapshot());
    render(<ClusterPanel />);

    expect(await screen.findByText("NODES")).toBeDefined();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/cluster");
    // The header line is not a row.
    expect(screen.getByText("2 rows")).toBeDefined();
    // Unhealthy pods are open without being asked; the nodes table is not.
    expect(screen.getByText(PODS, asWritten)).toBeDefined();
    expect(screen.queryByText(NODES, asWritten)).toBeNull();
    // A placeholder says what it says, rather than being counted.
    expect(screen.getByText("none")).toBeDefined();
  });

  it("opens a section that was closed", async () => {
    answer(snapshot());
    render(<ClusterPanel />);

    fireEvent.click(await screen.findByText("NODES"));
    expect(screen.getByText(NODES, asWritten)).toBeDefined();
  });

  it("draws nothing at all off the cluster", async () => {
    answer({ reachable: false, sections: [] } satisfies ClusterSnapshot);
    const { container } = render(<ClusterPanel />);
    // Nothing to wait for, so wait for the answer itself to have been read.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.querySelector("section")).toBeNull();
  });
});
