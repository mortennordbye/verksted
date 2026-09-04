import { describe, expect, it } from "vitest";
import { cite, citePath, citeUrl } from "../src/components/chat/cite";

/**
 * Citations: the bracket form the persona writes becomes a link the markdown
 * renderer can draw as a chip, and each kind knows where it goes.
 */
describe("cite", () => {
  it("rewrites the bracket forms it knows and leaves the rest", () => {
    expect(cite("Review asked for [feed:github:77], and the domain [loop:renew-the-domain].")).toBe(
      "Review asked for [feed:github:77](vk:feed/github:77), and the domain [loop:renew-the-domain](vk:loop/renew-the-domain).",
    );
    expect(cite("a [note:x] and a [link](https://x)")).toBe("a [note:x] and a [link](https://x)");
  });

  it("knows where each kind goes", () => {
    expect(citePath("vk:feed/github:77")).toEqual({ to: "/runs#github:77", label: "github:77" });
    expect(citePath("vk:session/vk-demo-1")).toEqual({ to: "/s/vk-demo-1", label: "vk-demo-1" });
    expect(citePath("vk:pr/verksted#97")).toEqual({
      to: "/p/verksted?side=prs",
      label: "verksted #97",
    });
    expect(citePath("vk:mail/42")).toEqual({ to: "/runs#mail:42", label: "mail 42" });
    expect(citePath("https://example.com")).toBeNull();
  });

  // The bug this guards: react-markdown sanitises every scheme it does not
  // know, so the link cite() had just written reached the element map as an
  // empty string and every chip in the app drew an anchor pointing nowhere.
  it("lets its own scheme through the renderer's sanitiser, and nothing else", () => {
    expect(citeUrl("vk:session/vk-demo-1")).toBe("vk:session/vk-demo-1");
    expect(citeUrl("https://example.com")).toBe("https://example.com");
    expect(citeUrl("/runs#github:77")).toBe("/runs#github:77");
    expect(citeUrl("javascript:alert(1)")).toBe("");
  });
});
