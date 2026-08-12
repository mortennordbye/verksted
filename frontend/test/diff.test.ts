import { describe, expect, it } from "vitest";
import { splitPatch } from "../src/diff";

/** Two files, as `git diff` prints them. */
const PATCH = `diff --git a/backend/src/git.ts b/backend/src/git.ts
index 1111111..2222222 100644
--- a/backend/src/git.ts
+++ b/backend/src/git.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
diff --git a/æ.txt b/æ.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/æ.txt
@@ -0,0 +1 @@
+hei
`;

describe("splitPatch", () => {
  it("splits a patch into its files, with the whole header kept", () => {
    const files = splitPatch(PATCH);
    expect(files.map((f) => f.path)).toEqual(["backend/src/git.ts", "æ.txt"]);
    expect(files[0].lines[0]).toBe("diff --git a/backend/src/git.ts b/backend/src/git.ts");
    expect(files[1].lines).toContain("+hei");
    // The trailing newline must not become a file with one blank line.
    expect(files[1].lines.at(-1)).toBe("+hei");
  });

  it("takes the name of a deleted file from the --- side", () => {
    const files = splitPatch(
      "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n",
    );
    expect(files.map((f) => f.path)).toEqual(["gone.txt"]);
  });

  it("reads a path with a space in it, which the git header cannot be split on", () => {
    const files = splitPatch(
      "diff --git a/my notes.md b/my notes.md\n--- a/my notes.md\n+++ b/my notes.md\n@@ -1 +1 @@\n+x\n",
    );
    expect(files.map((f) => f.path)).toEqual(["my notes.md"]);
  });

  it("keeps a chunk it cannot name rather than dropping changes from a review", () => {
    const files = splitPatch("diff --git a/x b/x\nBinary files a/x and b/x differ\n");
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("(unknown)");
  });

  it("has nothing to say about an empty patch", () => {
    expect(splitPatch("")).toEqual([]);
    expect(splitPatch("\n")).toEqual([]);
  });
});
