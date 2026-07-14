import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let sshDir: string;

beforeAll(async () => {
  sshDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vk-ssh-")), "dotssh");
  process.env.SSH_DIR = sshDir;
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-ssh-r-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-ssh-s-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

describe("SSH keys", () => {
  it("generates a keypair in the pod and lists it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ssh-keys/generate",
      payload: { name: "id_ed25519" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().publicKey).toMatch(/^ssh-ed25519 /);
    expect(res.json().fingerprint).toMatch(/^SHA256:/);

    const list = await app.inject({ url: "/api/ssh-keys" });
    expect(list.json()).toHaveLength(1);
    // the private half never appears in any response
    expect(list.body).not.toContain("PRIVATE KEY");
    expect(fs.readFileSync(path.join(sshDir, "id_ed25519"), "utf8")).toContain("PRIVATE KEY");
    // private key mode 0600
    expect(fs.statSync(path.join(sshDir, "id_ed25519")).mode & 0o777).toBe(0o600);
  });

  it("writes a non-interactive ssh config with an IdentityFile entry", () => {
    const config = fs.readFileSync(path.join(sshDir, "config"), "utf8");
    expect(config).toContain("StrictHostKeyChecking accept-new");
    expect(config).toContain(`IdentityFile ${path.join(sshDir, "id_ed25519")}`);
  });

  it("409s a duplicate name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ssh-keys/generate",
      payload: { name: "id_ed25519" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("installs a pasted private key and derives the public half", async () => {
    const tmp = path.join(os.tmpdir(), `vk-key-${process.pid}`);
    fs.rmSync(tmp, { force: true });
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "t", "-f", tmp]);
    const material = fs.readFileSync(tmp, "utf8");
    const expectedPub = fs.readFileSync(`${tmp}.pub`, "utf8").trim();

    const res = await app.inject({
      method: "POST",
      url: "/api/ssh-keys",
      payload: { name: "pasted", privateKey: material },
    });
    expect(res.statusCode).toBe(201);
    // ssh-keygen -y drops the comment; compare the key material itself
    expect(res.json().publicKey.split(" ").slice(0, 2)).toEqual(
      expectedPub.split(" ").slice(0, 2),
    );
  });

  it("rejects garbage and passphrase-less validation failures", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ssh-keys",
      payload: {
        name: "junk",
        privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a key\n-----END OPENSSH PRIVATE KEY-----",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(fs.existsSync(path.join(sshDir, "junk"))).toBe(false);
  });

  it("rejects non-key text outright", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ssh-keys",
      payload: { name: "junk2", privateKey: "hello" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects reserved and traversal names", async () => {
    for (const name of ["config", "known_hosts", "../evil", ".hidden"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/ssh-keys/generate",
        payload: { name },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("deletes a key pair and its config line", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/ssh-keys/pasted" });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(sshDir, "pasted"))).toBe(false);
    expect(fs.existsSync(path.join(sshDir, "pasted.pub"))).toBe(false);
    expect(fs.readFileSync(path.join(sshDir, "config"), "utf8")).not.toContain("pasted");
    const missing = await app.inject({ method: "DELETE", url: "/api/ssh-keys/pasted" });
    expect(missing.statusCode).toBe(404);
  });
});
