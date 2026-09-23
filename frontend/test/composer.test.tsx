import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Composer from "../src/components/chat/Composer";

afterEach(cleanup);

const image = (name: string) => new File(["x"], name, { type: "image/png" });

function setup(canSend = true) {
  const props = {
    onSend: vi.fn(),
    onAttach: vi.fn(),
    onRefused: vi.fn(),
  };
  render(
    <Composer
      value="hi"
      onChange={() => {}}
      canSend={canSend}
      label="message"
      placeholder=""
      fieldRef={null}
      {...props}
    />,
  );
  return props;
}

/** A paste carrying a screenshot as a clipboard item and no file, the Win+Shift+S case. */
function pasteItems(files: File[]) {
  fireEvent.paste(screen.getByLabelText("message"), {
    clipboardData: {
      files: [],
      items: files.map((f) => ({ kind: "file", getAsFile: () => f })),
    },
  });
}

describe("Composer (C-22)", () => {
  it("takes a screenshot that is on the clipboard only as an item", () => {
    const { onAttach } = setup();
    const shot = image("shot.png");
    pasteItems([shot]);
    expect(onAttach).toHaveBeenCalledWith([shot]);
  });

  it("says what it left out rather than dropping it", () => {
    const { onAttach, onRefused } = setup();
    pasteItems(["1", "2", "3", "4", "5"].map((n) => image(`${n}.png`)));
    expect(onAttach.mock.calls[0][0]).toHaveLength(4);
    expect(onRefused).toHaveBeenCalledWith("4 images at a time: 1 left out");
  });

  it("sends on Enter, breaks the line on shift+Enter, and not at all when it cannot", () => {
    const { onSend } = setup();
    const field = screen.getByLabelText("message");
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).toHaveBeenCalledOnce();

    cleanup();
    const blocked = setup(false);
    fireEvent.keyDown(screen.getByLabelText("message"), { key: "Enter" });
    expect(blocked.onSend).not.toHaveBeenCalled();
  });

  it("attaches images dropped on it (C-30)", () => {
    const { onAttach } = setup();
    const shot = image("drop.png");
    const card = screen.getByLabelText("message").parentElement as HTMLElement;
    fireEvent.drop(card, { dataTransfer: { types: ["Files"], files: [shot] } });
    expect(onAttach).toHaveBeenCalledWith([shot]);
  });
});
