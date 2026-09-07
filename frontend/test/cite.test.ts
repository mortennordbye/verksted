import { describe, expect, it } from "vitest";
import { cite, citePath, citeUrl, uncite } from "../src/components/chat/cite";

/**
 * Citations: the bracket form the persona writes becomes a link the markdown
 * renderer can draw as a chip, and each kind knows where it goes.
 */
describe("cite", () => {
  it("rewrites the bracket forms it knows and leaves the rest", () => {
    expect(cite("Review asked for [feed:github:77], and the domain [loop:renew-the-domain].")).toBe(
      "Review asked for [feed:github:77](vk:feed/github%3A77), and the domain [loop:renew-the-domain](vk:loop/renew-the-domain).",
    );
    expect(cite("the contract [doc:documents/Kontrakt/nimtech.pdf].")).toBe(
      "the contract [doc:documents/Kontrakt/nimtech.pdf](vk:doc/documents%2FKontrakt%2Fnimtech.pdf).",
    );
    expect(cite("a [note:x] and a [link](https://x)")).toBe("a [note:x] and a [link](https://x)");
  });

  it("knows where each kind goes", () => {
    expect(citePath("vk:feed/github%3A77")).toEqual({
      to: "/runs#github:77",
      label: "github:77",
    });
    expect(citePath("vk:session/vk-demo-1")).toEqual({ to: "/s/vk-demo-1", label: "vk-demo-1" });
    expect(citePath("vk:pr/verksted%2397")).toEqual({
      to: "/p/verksted?side=prs",
      label: "verksted #97",
    });
    expect(citePath("vk:mail/42")).toEqual({ to: "/runs#mail:42", label: "mail 42" });
    // A document has no route: it is read where it was cited, under the name
    // on the share rather than the whole path it was found at.
    expect(citePath("vk:doc/documents%2FKontrakt%2Fnimtech-21.06.25.pdf")).toEqual({
      doc: "documents/Kontrakt/nimtech-21.06.25.pdf",
      label: "nimtech-21.06.25.pdf",
    });
    expect(citePath("https://example.com")).toBeNull();
  });

  // A markdown destination ends at the first space, so a document whose folder
  // is called "Kontrakt Nimtech" drew no chip at all until the id was encoded.
  it("survives a path with spaces in it", () => {
    const written = cite("signed on the 21st [doc:Delte dokumenter/Kontrakt Nimtech/avtale.pdf].");
    expect(written).toBe(
      "signed on the 21st [doc:Delte dokumenter/Kontrakt Nimtech/avtale.pdf](vk:doc/Delte%20dokumenter%2FKontrakt%20Nimtech%2Favtale.pdf).",
    );
    expect(citePath("vk:doc/Delte%20dokumenter%2FKontrakt%20Nimtech%2Favtale.pdf")).toEqual({
      doc: "Delte dokumenter/Kontrakt Nimtech/avtale.pdf",
      label: "avtale.pdf",
    });
  });

  // Read aloud, a chip is nothing to tap: it was said, path and all.
  it("takes the citations back out for the voice", () => {
    expect(uncite("per the signed contract [doc:documents/Kontrakt/nimtech.pdf].")).toBe(
      "per the signed contract.",
    );
    expect(uncite("nothing cited here")).toBe("nothing cited here");
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
