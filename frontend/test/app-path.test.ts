import { describe, expect, it } from "vitest";
import { appPath } from "../src/app-path";

const HERE = "https://verksted.example";

describe("appPath", () => {
  it("keeps a path in this app, query and hash included", () => {
    expect(appPath("/inbox", HERE)).toBe("/inbox");
    expect(appPath("/sessions/vk-demo-1?tab=chat#bottom", HERE)).toBe(
      "/sessions/vk-demo-1?tab=chat#bottom",
    );
    expect(appPath("/", HERE)).toBe("/");
  });

  it("sends anywhere else to the hub", () => {
    // The backslash is the shape worth pinning: it looks like a path, and URL
    // parsing reads it as the second slash of an authority.
    for (const url of [
      "/\\evil.example",
      "//evil.example",
      "https://evil.example/inbox",
      "javascript:alert(1)",
      "",
      undefined,
      42,
    ]) {
      expect(appPath(url, HERE), String(url)).toBe("/");
    }
  });
});
