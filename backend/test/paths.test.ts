import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveInsideRepos, PathDeniedError } from "../src/paths.js";

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  fs.mkdirSync(path.join(root, "demo", "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "demo", "a.txt"), "hello");
  fs.writeFileSync(path.join(root, "demo", "sub", "b.txt"), "world");
  fs.mkdirSync(path.join(root, "other"));
  fs.writeFileSync(path.join(root, "other", "secret.txt"), "s");
  fs.symlinkSync("/etc", path.join(root, "demo", "evil"));
});

describe("resolveInsideRepos", () => {
  it("resolves the project dir itself", () => {
    expect(resolveInsideRepos("demo", "", root)).toBe(
      fs.realpathSync(path.join(root, "demo")),
    );
  });

  it("resolves files inside the project", () => {
    expect(resolveInsideRepos("demo", "a.txt", root)).toMatch(/a\.txt$/);
    expect(resolveInsideRepos("demo", "sub/b.txt", root)).toMatch(/b\.txt$/);
  });

  it("denies .. traversal into a sibling project", () => {
    expect(() => resolveInsideRepos("demo", "../other/secret.txt", root)).toThrow(PathDeniedError);
    expect(() => resolveInsideRepos("demo", "..", root)).toThrow(PathDeniedError);
    expect(() => resolveInsideRepos("demo", "sub/../../other/secret.txt", root)).toThrow(
      PathDeniedError,
    );
  });

  it("denies absolute paths", () => {
    expect(() => resolveInsideRepos("demo", "/etc/passwd", root)).toThrow(PathDeniedError);
  });

  it("denies symlink escapes", () => {
    expect(() => resolveInsideRepos("demo", "evil", root)).toThrow(PathDeniedError);
    expect(() => resolveInsideRepos("demo", "evil/passwd", root)).toThrow(PathDeniedError);
  });

  it("denies bad project names", () => {
    for (const name of ["..", "a/b", ".hidden", "", "../other", "demo/../other"]) {
      expect(() => resolveInsideRepos(name, "", root)).toThrow(PathDeniedError);
    }
  });

  it("denies nonexistent projects and paths", () => {
    expect(() => resolveInsideRepos("ghost", "", root)).toThrow(PathDeniedError);
    expect(() => resolveInsideRepos("demo", "nope.txt", root)).toThrow(PathDeniedError);
  });
});
