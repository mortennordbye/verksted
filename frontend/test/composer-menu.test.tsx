import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ComposerMenu, {
  matchingItems,
  useComposerMenu,
  type MenuItem,
} from "../src/components/chat/ComposerMenu";
import { ageGroup } from "../src/components/assistant/ThreadRail";

const ITEMS: MenuItem[] = [
  { value: "@ariel ", label: "@ariel", hint: "the money" },
  { value: "@all ", label: "@all", hint: "the whole council" },
  { value: "/new", label: "/new", hint: "start a new thread" },
];

afterEach(cleanup);

describe("what the composer menu offers", () => {
  it("completes only the first word, as it is being typed", () => {
    expect(matchingItems("@a", ITEMS).map((i) => i.label)).toEqual(["@ariel", "@all"]);
    expect(matchingItems("/", ITEMS).map((i) => i.label)).toEqual(["/new"]);
    expect(matchingItems("hello @a", ITEMS)).toEqual([]);
    expect(matchingItems("@ariel what", ITEMS)).toEqual([]);
    expect(matchingItems("", ITEMS)).toEqual([]);
  });
});

function Harness({ onPick }: { onPick: (i: MenuItem) => void }) {
  const [text, setText] = useState("");
  const menu = useComposerMenu(text, ITEMS, onPick);
  return (
    <>
      <ComposerMenu items={menu.shown} active={menu.active} onPick={onPick} />
      <textarea
        aria-label="field"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => menu.onKey(e)}
      />
    </>
  );
}

describe("the keys while it is open", () => {
  it("moves with the arrows and picks with enter", () => {
    const pick = vi.fn();
    render(<Harness onPick={pick} />);
    const field = screen.getByLabelText("field");

    fireEvent.change(field, { target: { value: "@a" } });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(pick).toHaveBeenCalledWith(ITEMS[1]);
  });

  it("gets out of the way on escape, so enter sends what was typed", () => {
    const pick = vi.fn();
    render(<Harness onPick={pick} />);
    const field = screen.getByLabelText("field");

    fireEvent.change(field, { target: { value: "@a" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(pick).not.toHaveBeenCalled();
  });
});

describe("where a thread goes in the rail", () => {
  const now = new Date("2026-11-05T15:00:00");

  it.each([
    ["2026-11-05T09:00:00", "today"],
    ["2026-11-04T23:00:00", "yesterday"],
    ["2026-11-01T12:00:00", "this week"],
    ["2026-10-01T12:00:00", "earlier"],
  ])("%s is %s", (at, group) => {
    expect(ageGroup(at, now)).toBe(group);
  });
});
