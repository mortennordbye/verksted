import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import DataCard from "../src/components/chat/DataCard";

afterEach(cleanup);

describe("a tool's result as a picture", () => {
  it("shows a budget as three figures with what each is", () => {
    render(
      <DataCard
        card={{ kind: "budget", month: "2026-11", income: 52000, fixed: 31000, saved: 8000 }}
      />,
    );

    expect(screen.getByText("Budget, November 2026")).toBeTruthy();
    expect(screen.getByText("saved")).toBeTruthy();
    expect(screen.getByText(/8\s?000 kr/)).toBeTruthy();
  });

  it("draws one bar per week, each saying its figures", () => {
    const { container } = render(
      <DataCard
        card={{
          kind: "volume",
          weeks: [
            { weekStart: "2026-10-27", volumeKg: 12400, sessions: 3 },
            { weekStart: "2026-11-03", volumeKg: 9000, sessions: 2 },
          ],
        }}
      />,
    );

    expect(screen.getByRole("img", { name: /2 weeks/ })).toBeTruthy();
    const titles = [...container.querySelectorAll("title")].map((t) => t.textContent);
    expect(titles).toHaveLength(2);
    expect(titles[1]).toMatch(/9\s?000 kg, 2 sessions/);
  });
});
