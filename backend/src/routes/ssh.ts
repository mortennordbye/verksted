import { exec } from "../exec.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { SshKey } from "../../../shared/api.js";
import { env } from "../env.js";

// Leading alnum rules out "..", dotfiles and option-like names.
const KEY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED = new Set(["config", "known_hosts", "authorized_keys", "environment", "rc"]);

function keyPath(name: string): string {
  return path.join(env.SSH_DIR, name);
}

async function ensureSshDir(): Promise<void> {
  await fs.mkdir(env.SSH_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Keep ssh usable non-interactively: accept-new host keys (a prompt inside an
 * agent session would just hang), and an explicit IdentityFile per managed key
 * so non-default names work too. Never touches a user-authored config.
 */
async function ensureConfig(name: string): Promise<void> {
  const config = path.join(env.SSH_DIR, "config");
  let content = await fs.readFile(config, "utf8").catch(() => null);
  if (content === null) {
    content = "# managed by verksted (settings > ssh keys)\nStrictHostKeyChecking accept-new\n";
  } else if (!content.startsWith("# managed by verksted")) {
    return; // hand-written config: leave it alone
  }
  const line = `IdentityFile ${keyPath(name)}`;
  if (!content.includes(`${line}\n`)) content += `${line}\n`;
  await fs.writeFile(config, content, { mode: 0o600 });
}

async function dropFromConfig(name: string): Promise<void> {
  const config = path.join(env.SSH_DIR, "config");
  const content = await fs.readFile(config, "utf8").catch(() => null);
  if (content === null || !content.startsWith("# managed by verksted")) return;
  const kept = content
    .split("\n")
    .filter((l) => l !== `IdentityFile ${keyPath(name)}`)
    .join("\n");
  await fs.writeFile(config, kept, { mode: 0o600 });
}

/** Whether a key of this name is already installed. */
async function taken(name: string): Promise<boolean> {
  return fs
    .access(keyPath(name))
    .then(() => true)
    .catch(() => false);
}

async function keyEntry(name: string): Promise<SshKey> {
  const publicKey = (await fs.readFile(`${keyPath(name)}.pub`, "utf8")).trim();
  const fingerprint = await exec("ssh-keygen", ["-lf", `${keyPath(name)}.pub`])
    .then((r) => r.stdout.trim().split(" ")[1] ?? "?")
    .catch(() => "?");
  return { name, publicKey, fingerprint };
}

export default async function sshRoutes(app: FastifyInstance) {
  app.get("/api/ssh-keys", async (): Promise<SshKey[]> => {
    const files = await fs.readdir(env.SSH_DIR).catch(() => []);
    const keys = await Promise.all(
      files
        .filter((f) => f.endsWith(".pub") && KEY_NAME_RE.test(f.slice(0, -4)))
        .map((f) => keyEntry(f.slice(0, -4)).catch(() => null)),
    );
    return keys.filter((k): k is SshKey => k !== null).sort((a, b) => a.name.localeCompare(b.name));
  });

  // Install a pasted private key. The public half is derived, the private half
  // is never returned by any endpoint.
  app.post<{ Body: { name: string; privateKey: string } }>(
    "/api/ssh-keys",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "privateKey"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 64 },
            privateKey: { type: "string", minLength: 1, maxLength: 20_000 },
          },
        },
      },
    },
    async (req, reply) => {
      const { name } = req.body;
      if (!KEY_NAME_RE.test(name) || RESERVED.has(name) || name.endsWith(".pub")) {
        return reply.code(400).send({ error: "invalid key name" });
      }
      const material = req.body.privateKey.trim();
      if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(material)) {
        return reply.code(400).send({ error: "not a private key" });
      }
      await ensureSshDir();
      const file = keyPath(name);
      // Generate has always answered 409 here; import wrote first and asked
      // nothing, so re-using a name replaced a working key — and a paste that
      // then failed validation deleted it, leaving the agent with no key at all
      // and nothing on screen to say which one went.
      if (await taken(name)) return reply.code(409).send({ error: "key already exists" });
      // Validated where a failure costs nothing, then moved into place. ssh
      // requires a trailing newline and 0600 on private keys.
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${material}\n`, { mode: 0o600 });
      let publicHalf: string;
      try {
        publicHalf = (await exec("ssh-keygen", ["-y", "-P", "", "-f", tmp])).stdout;
      } catch (err) {
        await fs.rm(tmp, { force: true });
        req.log.info(err, "ssh key rejected");
        return reply.code(400).send({ error: "invalid or passphrase-protected key" });
      }
      await fs.rename(tmp, file);
      await fs.writeFile(`${file}.pub`, publicHalf, { mode: 0o644 });
      await ensureConfig(name);
      return reply.code(201).send(await keyEntry(name));
    },
  );

  // Generate a keypair in the pod — the private key never travels at all.
  app.post<{ Body: { name: string; comment?: string } }>(
    "/api/ssh-keys/generate",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 64 },
            comment: { type: "string", maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      const { name } = req.body;
      if (!KEY_NAME_RE.test(name) || RESERVED.has(name) || name.endsWith(".pub")) {
        return reply.code(400).send({ error: "invalid key name" });
      }
      await ensureSshDir();
      const file = keyPath(name);
      if (await taken(name)) return reply.code(409).send({ error: "key already exists" });
      const comment = (req.body.comment ?? "verksted").replace(/[^\w@.: -]/g, "");
      await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", file]);
      await ensureConfig(name);
      return reply.code(201).send(await keyEntry(name));
    },
  );

  app.delete<{ Params: { name: string } }>("/api/ssh-keys/:name", async (req, reply) => {
    const { name } = req.params;
    if (!KEY_NAME_RE.test(name) || RESERVED.has(name)) {
      return reply.code(400).send({ error: "invalid key name" });
    }
    try {
      await fs.access(keyPath(name));
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    await fs.rm(keyPath(name), { force: true });
    await fs.rm(`${keyPath(name)}.pub`, { force: true });
    await dropFromConfig(name);
    return { name };
  });
}
