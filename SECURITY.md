# Security

verksted is a personal tool, not a hosted service, and its threat model is
unusual enough to say out loud.

## What it is

A single container that runs coding agents in tmux, with a terminal, a file
editor and a git client in the browser. It holds agent credentials (Claude,
Codex, Antigravity, GitHub) and can push code. **There is no login.** Anyone who
can reach the app has a root shell in the container and every credential in it.

## The boundary

The network is the boundary. The app is meant to be reachable only over a
WireGuard VPN, and never from the public internet: no public ingress, no port
published on a LAN (`make dev` and `make run` bind to loopback by default).
Inside that boundary the app still defends what it can without an identity:

- Every write and every websocket checks the Origin, and requests addressed to
  a host the deployment does not answer to are refused (DNS rebinding).
- Every path a request names is resolved inside the repos directory by realpath
  (`backend/src/paths.ts`); `..` and symlinks out are refused.
- External commands run through `execFile` with argument arrays, never a shell
  string, and the git the backend runs has hooks, fsmonitor and textconv off.
- Unattended agent runs go through a guard hook that denies rather than asks
  (`runtime/vk-guard`).

What is known to be missing, and planned, is in `BACKLOG.md` and in the audit
(`FABLE-AUDIT-2026-09-19.md`, root cause 1): agents and the backend run as the
same user, so an agent can read what the backend can.

## Reporting a vulnerability

Please report it privately, through GitHub's
[private vulnerability reporting](https://github.com/mortennordbye/verksted/security/advisories/new)
for this repository, rather than in a public issue. Include what an attacker
needs (in particular, whether they need to be inside the VPN) and what they get.
This is maintained by one person; expect an answer within a week.

A report that amounts to "there is no authentication" is the design above, not
a finding. One that reaches the app, a credential or a shell from outside the
VPN, or crosses from one repo or session into what it should not reach, is.
