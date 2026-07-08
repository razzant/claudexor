# Security Policy

Claudexor is a local-first control plane: it runs on your machine, spawns
vendor coding CLIs with your credentials, serves a loopback-only control API,
and applies patches to your repositories. Security reports matter.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**, not in public issues:

- Open a private advisory via GitHub Security Advisories
  ("Report a vulnerability" on the repository's **Security** tab), or
- email the maintainer at the address on the GitHub profile that owns this
  repository.

Include what you observed, how to reproduce it, the affected version
(`claudexor --version` or the git SHA), and the impact you expect. A minimal
proof-of-concept helps.

Please do not run automated scanners against infrastructure you do not own on
Claudexor's behalf; the product is local, so a local reproduction is enough.

## Response expectations

This is a small project. Expect an initial acknowledgement within about a
week. Fixes ship in a normal release; if a fix is security-sensitive, the
release notes will say so once users have had a reasonable chance to update.

## Supported versions

Only the latest released version is supported. There are no backported
security fixes for older tags; upgrade to the current release.

## Scope and posture

What Claudexor already does, so you can calibrate reports:

- The control API binds `127.0.0.1` only, requires a bearer token
  (timing-safe comparison), and enforces a loopback host/origin guard;
  `/healthz` is the only unauthenticated route.
- Secret values are stored in the OS keychain where available, else in a
  `0600` file; secret material is redacted from event logs, job records,
  thread stores, and reviewer artifacts.
- No telemetry, analytics, or crash reporting is collected (see the Privacy
  section of the README). The only outbound network traffic is to the model
  and harness endpoints you configure.

In scope: the CLI, daemon, control API, MCP/ACP servers, the macOS app, and
the host-integration plugin writers. Out of scope: vulnerabilities in the
third-party vendor CLIs (Codex, Claude Code, Cursor, OpenCode) themselves —
report those to their vendors.
