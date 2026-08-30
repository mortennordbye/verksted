import { describe, expect, it } from "vitest";
import { cite, citePath } from "../src/components/chat/cite";

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
});
