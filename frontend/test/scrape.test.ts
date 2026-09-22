import { describe, expect, it } from "vitest";
import { AUTH_URL_RE } from "../src/components/terminal/scrape";

/**
 * F-09. The match used to be any URL with `oauth`, `login` or `verify` in it,
 * so a file named login.ts in a diff raised the sign-in bar. It is the
 * agents' own identity providers now, and nothing else.
 */
describe("AUTH_URL_RE", () => {
  it.each([
    "https://claude.ai/oauth/authorize?code=true&client_id=abc",
    "https://console.anthropic.com/oauth/authorize?code=true",
    "https://auth.openai.com/oauth/authorize?response_type=code",
    "https://auth.openai.com/codex/device?user_code=ABCD-EFGH",
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=1",
    "https://github.com/login/device",
  ])("matches a sign-in link an agent prints: %s", (url) => {
    expect(`open ${url} to sign in`.match(AUTH_URL_RE)?.[0]).toBe(url);
  });

  it.each([
    "https://github.com/acme/app/blob/main/src/login.ts",
    "https://example.com/docs/oauth/callback",
    "https://claude.ai/code/session_01ABC",
    "https://verksted.local/api/verify?token=1",
  ])("leaves a link that only has the word in it: %s", (url) => {
    expect(`see ${url}`).not.toMatch(AUTH_URL_RE);
  });
});
