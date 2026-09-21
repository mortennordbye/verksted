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
    fireEvent.click(screen.getByRole("treeitem", { name: "backend" }));
    expect(screen.getByRole("treeitem", { name: "index.ts" })).toBeTruthy();
    first.unmount();

    draw();
    expect(screen.getByRole("treeitem", { name: "index.ts" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "backend" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("belongs to its own repo", () => {
    const first = draw("demo");
    fireEvent.click(screen.getByRole("treeitem", { name: "backend" }));
    first.unmount();

    draw("other");
    expect(screen.queryByRole("treeitem", { name: "index.ts" })).toBeNull();
    expect(screen.getByRole("treeitem", { name: "backend" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("closes again on a second tap", () => {
    draw("closes");
    const folder = screen.getByRole("treeitem", { name: "backend" });
    fireEvent.click(folder);
    fireEvent.click(folder);
    expect(screen.queryByRole("treeitem", { name: "index.ts" })).toBeNull();
    expect(folder.getAttribute("aria-expanded")).toBe("false");
  });
});

/**
 * The other half of F-38: every row was its own button, so the fortieth file
 * was forty presses of Tab, and a screen reader heard a flat list of buttons.
 */
describe("the tree on a keyboard", () => {
  const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
  const focused = () => document.activeElement?.getAttribute("aria-label");

  it("is one tab stop, with the arrows between the rows", () => {
    draw("keys");
    const items = screen.getAllByRole("treeitem");
    expect(items.filter((i) => i.tabIndex === 0)).toHaveLength(1);

    items[0].focus();
    press("ArrowDown");
    expect(focused()).toBe("readme.md");
    press("ArrowUp");
    expect(focused()).toBe("backend");
  });

  it("opens a folder, steps into it, and climbs back out", () => {
    draw("walk");
    screen.getByRole("treeitem", { name: "backend" }).focus();
    press("ArrowRight");
    expect(screen.getByRole("treeitem", { name: "backend" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    press("ArrowRight");
    expect(focused()).toBe("index.ts");
    press("ArrowLeft");
    expect(focused()).toBe("backend");
    press("ArrowLeft");
    expect(screen.queryByRole("treeitem", { name: "index.ts" })).toBeNull();
  });

  it("opens a file on Enter, and jumps by its first letter", () => {
    const opened: string[] = [];
    render(
      <FileTree treeKey="enter" title="~/demo" nodes={nodes} onOpenFile={(p) => opened.push(p)} />,
    );
    screen.getByRole("treeitem", { name: "backend" }).focus();
    press("r");
    expect(focused()).toBe("readme.md");
    press("Enter");
    expect(opened).toEqual(["readme.md"]);
  });
});
