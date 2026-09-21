import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPollCache } from "../src/api";
import FileViewer from "../src/components/FileViewer";
import Overlay from "../src/components/ui/Overlay";
import Docs from "../src/screens/Docs";
import { useUrlOverlay } from "../src/useUrlOverlay";

/**
 * F-22 and the overlay half of F-34: every modal on one Radix dialog, which
 * keeps focus inside it and puts it back afterwards, and the file and document
 * viewers as places in the URL rather than state a reload throws away.
 */
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        json(
          url.startsWith("/api/projects/demo/file")
            ? { path: "src/a.ts", content: "const a = 1;\n", etag: "e1" }
            : url.startsWith("/api/docs/read")
              ? { path: "notes.txt", text: "hello" }
              : [],
        ),
      ),
    ),
  );
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  cleanup();
  resetPollCache();
  vi.unstubAllGlobals();
});

describe("an overlay", () => {
  function Harness({ onClose }: { onClose: () => void }) {
    return (
      <Overlay label="a sheet" onClose={onClose} className="">
        <button>first</button>
        <button>last</button>
      </Overlay>
    );
  }

  it("takes focus on open, keeps Tab inside, and gives focus back on close", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const { unmount } = render(<Harness onClose={onClose} />);

    const dialog = await screen.findByRole("dialog", { name: "a sheet" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    // Not the first field: on a phone that is the keyboard coming up.
    expect(document.activeElement).toBe(dialog);

    screen.getByRole("button", { name: "last" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "first" }));

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });
});

/** Where the router is, and a Back that stays inside the memory router. */
const seen = { where: "" };
function Where() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    seen.where = pathname + search;
  }, [pathname, search]);
  return <button onClick={() => void navigate(-1)}>browser back</button>;
}

function Viewer() {
  const viewer = useUrlOverlay(["file", "line"]);
  const path = viewer.values.file;
  return (
    <>
      <button onClick={() => viewer.show({ file: "src/a.ts" })}>open a.ts</button>
      <FileViewer
        project="demo"
        sessionId="vk-demo-1"
        target={path ? { path } : null}
        onClose={viewer.hide}
      />
    </>
  );
}

const session = (entries: string[]) =>
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Viewer />
      <Where />
    </MemoryRouter>,
  );

describe("the file viewer", () => {
  it("is a place in the URL, and Back closes it", async () => {
    session(["/s/vk-demo-1"]);
    fireEvent.click(screen.getByRole("button", { name: "open a.ts" }));
    await screen.findByRole("dialog", { name: "src/a.ts" });
    expect(seen.where).toBe("/s/vk-demo-1?file=src%2Fa.ts");

    fireEvent.click(screen.getByText("browser back"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(seen.where).toBe("/s/vk-demo-1");
  });

  it("opens from a link, and closing it stays on the session", async () => {
    session(["/p/demo", "/s/vk-demo-1?file=src%2Fa.ts"]);
    await screen.findByText("const a = 1;");
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Not a Back: there is no entry of its own to step over, and one more would
    // have left for the project.
    expect(seen.where).toBe("/s/vk-demo-1");
  });

  it("asks before Back throws away an unsaved edit", async () => {
    session(["/s/vk-demo-1"]);
    fireEvent.click(screen.getByRole("button", { name: "open a.ts" }));
    fireEvent.click(await screen.findByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "src/a.ts (editing)" }), {
      target: { value: "const a = 2;\n" },
    });

    fireEvent.click(screen.getByText("browser back"));
    const discard = await screen.findByRole("button", { name: "discard them" });
    // Still open, on its own entry, with the edit still in it.
    expect(seen.where).toBe("/s/vk-demo-1?file=src%2Fa.ts");
    // Hidden from the tree by the confirm over it, which is how a modal should be.
    expect(
      screen.getByRole("textbox", { name: "src/a.ts (editing)", hidden: true }),
    ).toHaveProperty("value", "const a = 2;\n");

    await act(async () => {
      fireEvent.click(discard);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await waitFor(() => expect(seen.where).toBe("/s/vk-demo-1"));
    expect(screen.queryByRole("dialog", { name: "src/a.ts" })).toBeNull();
  });
});

describe("the docs viewer", () => {
  it("opens the document the URL names", async () => {
    render(
      <MemoryRouter initialEntries={["/docs?doc=notes.txt"]}>
        <Docs />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("dialog", { name: "notes.txt" })).toBeTruthy();
    expect(await screen.findByText("hello")).toBeTruthy();
  });
});
