import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.fn((url: string, init?: { body?: string }) => {
  const body = init?.body ? (JSON.parse(init.body) as { dryRun?: boolean }) : {};
  if (url.includes("/search")) return Promise.resolve([]);
  if (body.dryRun) {
    return Promise.resolve({
      files: 2,
      replacements: 3,
      dryRun: true,
      perFile: [
        { path: "src/a.ts", replacements: 2 },
        { path: "src/b.ts", replacements: 1 },
      ],
    });
  }
  return Promise.resolve({
    files: 1,
    replacements: 2,
    perFile: [{ path: "src/a.ts", replacements: 2 }],
  });
});
vi.mock("../src/api", async (orig) => ({
  ...(await orig<typeof import("../src/api")>()),
  api: (url: string, init?: { body?: string }) => api(url, init),
}));

const { default: SearchPanel } = await import("../src/components/SearchPanel");

afterEach(cleanup);

describe("replace across the repo (backlog)", () => {
  it("counts per file first, and writes only the files left ticked", async () => {
    render(<SearchPanel project="demo" onOpenFile={() => {}} />);
    fireEvent.change(screen.getByLabelText(/search/i, { selector: "input" }), {
      target: { value: "foo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "replace" }));
    fireEvent.change(screen.getByLabelText("replace matches with"), { target: { value: "bar" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "replace all" }));
    });

    // Nothing written yet: only the dry run was asked.
    expect(api.mock.calls.filter(([, i]) => i?.body && !i.body.includes("dryRun"))).toEqual([]);
    fireEvent.click(screen.getByRole("checkbox", { name: /src\/b\.ts/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "replace in 1 file" }));
    });
    const write = api.mock.calls.find(([, i]) => i?.body?.includes('"paths"'));
    expect(JSON.parse(write![1]!.body!)).toMatchObject({
      q: "foo",
      replace: "bar",
      paths: ["src/a.ts"],
    });
  });
});
