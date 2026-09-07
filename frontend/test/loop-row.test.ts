import { describe, expect, it } from "vitest";
import { loopLink } from "../src/screens/Today";

/**
 * A loop's row links to whatever opened it. Everything the pollers file is a
 * feed item with an anchor on the inbox; a document is not, and used to send
 * the row to an anchor no item answers to.
 */
describe("loopLink", () => {
  it("sends a feed item to its row on the inbox", () => {
    expect(loopLink("mail:412")).toBe("/runs#mail:412");
    expect(loopLink(null)).toBe("/runs");
  });

  it("sends a document to the folder it is in", () => {
    expect(loopLink("doc:Delte dokumenter/Forsikring/police.pdf")).toBe(
      "/docs?path=Delte%20dokumenter%2FForsikring",
    );
    expect(loopLink("doc:loose.pdf")).toBe("/docs");
  });
});
