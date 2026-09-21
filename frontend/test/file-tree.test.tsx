import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TreeNode } from "../../shared/api";
import FileTree from "../src/components/FileTree";

/**
 * F-38. The sidebar is unmounted whenever the pane beside it changes — the
 * changes tab, search, the shell, the browser — and on a phone that is every
 * time you look at anything else. The expansion went with it, so coming back
 * meant opening four folders again to reach the file you had just been
 * reading.
 */
const nodes: TreeNode[] = [
  {
    name: "backend",
    path: "backend",
    type: "dir",
    children: [{ name: "index.ts", path: "backend/index.ts", type: "file" }],
  },
  { name: "readme.md", path: "readme.md", type: "file" },
];

afterEach(cleanup);

const draw = (treeKey = "demo") =>
  render(<FileTree treeKey={treeKey} title="~/demo" nodes={nodes} onOpenFile={() => undefined} />);

describe("a folder that was opened", () => {
  it("is still open after the sidebar has been away", () => {
    const first = draw();
    fireEvent.click(screen.getByRole("button", { name: "backend/" }));
    expect(screen.getByRole("button", { name: "index.ts" })).toBeTruthy();
    first.unmount();

    draw();
    expect(screen.getByRole("button", { name: "index.ts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "backend/" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("belongs to its own repo", () => {
    const first = draw("demo");
    fireEvent.click(screen.getByRole("button", { name: "backend/" }));
    first.unmount();

    draw("other");
    expect(screen.queryByRole("button", { name: "index.ts" })).toBeNull();
    expect(screen.getByRole("button", { name: "backend/" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("closes again on a second tap", () => {
    draw("closes");
    const folder = screen.getByRole("button", { name: "backend/" });
    fireEvent.click(folder);
    fireEvent.click(folder);
    expect(screen.queryByRole("button", { name: "index.ts" })).toBeNull();
    expect(folder.getAttribute("aria-expanded")).toBe("false");
  });
});
