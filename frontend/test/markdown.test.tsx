import { render, screen } from "@testing-library/react";
import Markdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { MD, REMARK } from "../src/components/chat/markdown";

/**
 * The dialect the agents actually write. A comparison comes back as a pipe
 * table every time, and without the plugin it arrived as a wall of pipes and
 * dashes: this is what keeps the plugin passed at the call sites.
 */
describe("MD", () => {
  it("draws a table rather than the pipes it was written with", () => {
    render(
      <Markdown components={MD} remarkPlugins={REMARK}>
        {"| repo | pr |\n| --- | --- |\n| verksted | 131 |"}
      </Markdown>,
    );
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "repo" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "131" })).toBeTruthy();
  });

  it("leaves the pipes alone when the plugin is not passed", () => {
    const { container } = render(
      <Markdown components={MD}>{"| repo | pr |\n| --- | --- |\n| verksted | 131 |"}</Markdown>,
    );
    expect(container.querySelector("table")).toBeNull();
  });
});
