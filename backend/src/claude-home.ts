import path from "node:path";

/**
 * Where claude keeps a conversation: $HOME/.claude/projects/<cwd with the
 * slashes turned into dashes>/<conversation id>.jsonl. Verified against the
 * real thing rather than derived from documentation.
 *
 * On its own, with no imports from the rest of the app, because both the
 * session store (measuring a finished session) and the transcript readers
 * (which import the session store) need it.
 */

/** The directory claude keeps one repo's conversations in. */
export function claudeProjectDir(repoDir: string): string {
  const home = process.env.HOME ?? "/data/home";
  return path.join(home, ".claude", "projects", repoDir.replace(/\//g, "-"));
}

export function transcriptPath(repoDir: string, conversationId: string): string {
  return path.join(claudeProjectDir(repoDir), `${conversationId}.jsonl`);
}

/** Where the conversation's subagents keep theirs, one file each. */
export function subagentDir(repoDir: string, conversationId: string): string {
  return path.join(claudeProjectDir(repoDir), conversationId, "subagents");
}

/**
 * Where claude keeps the login it made for itself: the OAuth access token it
 * refreshes as it runs, with when it expires. What a pod with no token in its
 * environment signs in with, and so what the plan is read with there.
 */
export function claudeCredentialsFile(): string {
  const home = process.env.HOME ?? "/data/home";
  return path.join(home, ".claude", ".credentials.json");
}
