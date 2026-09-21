import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Ago, { dayLabel, newDay } from "../src/components/Ago";

describe("Ago", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-09-21T12:00:00Z") }));
  afterEach(() => vi.useRealTimers());

  it("moves on with the clock, where a label drawn once stayed at just now", () => {
    render(<Ago at="2026-09-21T12:00:00Z" />);
    expect(screen.getByText("just now")).toBeTruthy();

    act(() => void vi.advanceTimersByTime(5 * 60_000));
    expect(screen.getByText("5 min ago")).toBeTruthy();
  });

  it("is a <time> that carries the moment itself", () => {
    render(<Ago at="2026-09-21T11:00:00Z" />);
    const el = screen.getByText("1 h ago");
    expect(el.tagName).toBe("TIME");
    expect(el.getAttribute("datetime")).toBe("2026-09-21T11:00:00Z");
    expect(el.getAttribute("title")).toBeTruthy();
  });
});

describe("day separators", () => {
  const now = new Date(2026, 8, 21, 12);

  it("names today and yesterday, and dates anything older", () => {
    expect(dayLabel(new Date(2026, 8, 21, 1).toISOString(), now)).toBe("today");
    expect(dayLabel(new Date(2026, 8, 20, 23).toISOString(), now)).toBe("yesterday");
    expect(dayLabel(new Date(2026, 8, 14, 9).toISOString(), now)).toMatch(/14/);
  });

  it("opens a thread with one, and draws the next only when the day changes", () => {
    const a = new Date(2026, 8, 20, 23, 50).toISOString();
    const b = new Date(2026, 8, 20, 23, 59).toISOString();
    const c = new Date(2026, 8, 21, 0, 1).toISOString();
    expect(newDay(undefined, a)).toBe(true);
    expect(newDay(a, b)).toBe(false);
    expect(newDay(b, c)).toBe(true);
  });
});
