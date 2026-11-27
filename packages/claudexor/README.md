# claudexor

Local-first control plane for Claude Code, Codex, Cursor, and OpenCode. It keeps
one Claudexor coding thread moving across harnesses and can track quota and
rotate across multiple user-owned Claude Code and Codex subscriptions.

- Route planning, implementation, and review through different coding agents.
- Run Best-of-N candidates and cross-model reviews in isolated workspaces.
- Continue across harness or account lanes with bounded context packets.
- Inspect evidence, checks, review state, and typed apply gates before delivery.
- Expose the same control plane to existing agents through a local MCP server.

Quota telemetry and automatic subscription rotation apply to Claude Code and
Codex. Cursor and OpenCode participate in the multi-harness pool. Claudexor does
not migrate native vendor sessions between credential profiles.

## First Ask: did these CI checks already fail on main?

The standalone CLI runs on macOS or Linux with Node.js 24.15 or newer. Install
it and [connect one coding agent with a working account](https://github.com/razzant/claudexor#set-up-the-cli-and-account).
Use your existing connection if you have one. Doctor checks availability; on
a cold cache it can contact other configured providers and incur charges.

```sh
npm install -g claudexor
claudexor doctor
```

Save [ci-checks.txt](https://raw.githubusercontent.com/razzant/claudexor/main/docs/examples/libgit2-ci/ci-checks.txt)
in an empty folder. It contains the public job and step results for two libgit2
builds; you don't need to clone libgit2 or grant GitHub access. From that folder,
ask one read-only question:

```sh
claudexor ask 'Read ci-checks.txt. Which checks in the PR had already failed on main? Cite both runs. Can this file tell us whether the change caused the failures?' --web off
```

Check the answer against the [earlier main run](https://github.com/libgit2/libgit2/actions/runs/31426845872)
and the [PR run](https://github.com/libgit2/libgit2/actions/runs/31431787840).
The **Test** step failed in two jobs on both runs: Windows (amd64, Visual
Studio, Schannel, reftable) and macOS (reftable). The logs expired: matching
job names don't establish a common cause or clear the change. To reread the
answer and its evidence without starting another run, use `claudexor inspect`
followed by the run ID printed by Ask.

Ask uses Auto; subscription usage counts against the selected account and an
API-key route is billed by its provider. To choose a named account, add
`--harness <harness-id> --profile <profile-id>` with the IDs from its row in
`claudexor accounts --json`.

## When you want changes

Run these in the project you actually want to change, not as part of the
read-only example. Agent can edit files; Best-of runs competing candidates.

```sh
claudexor agent "implement the approved plan" --harness codex
claudexor best-of "implement the fix and add a regression test" --harness codex,claude --n 2
```

To connect another tool over stdio, use `claudexor mcp serve`.

This package is the bin wrapper over
[`@claudexor/cli`](https://www.npmjs.com/package/@claudexor/cli).

## Install in Pi

Pi can delegate a question to Claudexor and show the answer in your session.
Use [a configured CLI and account](https://github.com/razzant/claudexor#set-up-the-cli-and-account)
and a Pi version with built-in MCP and `registerMcpServer`, such as 1.5.2.
Pi integration by [Ouroboros](https://github.com/razzant/ouroboros).

If `npm view claudexor@latest pi.extensions --json` lists `./pi/index.js`,
install the published package in Pi.

```sh
pi install npm:claudexor
```

If the entry is missing, as it is in `claudexor@6.2.0` on npm,
[get a Git checkout containing the extension](https://github.com/razzant/claudexor#get-a-package-checkout)
and keep it in place. Pi loads the local package from that directory.

```sh
pi install "$HOME/claudexor-hosts/packages/claudexor"
```

Start Pi with `node` and `claudexor` on its PATH, or use `/reload` in an
existing session with that PATH. Enable built-in MCP and
the extension in `pi config` if needed. In `/mcp`, check that `claudexor` is
connected and your tool filters permit the first request's tools under
`mcp__claudexor__`. The extension is the source by default. A manual entry
named `claudexor` in `~/.pi/agent/mcp.json` or the project's `.pi/mcp.json`
overrides it even when disabled. Keep an intentional entry for a
[custom Claudexor store](https://github.com/razzant/claudexor/blob/main/docs/INTEGRATIONS.md#custom-claudexor-configuration-directory).
To use the packaged server instead, remove or rename the conflicting entry
and `/reload`. [Check status and get your first answer](https://github.com/razzant/claudexor#first-delegation-from-any-host).

For an explicit code-review request, the enabled Claudexor Skill asks the Pi
model to get one independent read-only second opinion alongside its own review.
This experimental default depends on the model loading and following the Skill.
It uses only material you cleared for sharing, inline, with `noProject: true`,
`web: "off"` and a zero paid budget. Use Claudexor 6.4.0 or later for both the
CLI and its daemon. The Skill makes no version check and skips this path if it
already sees an older engine or a CLI and daemon of different versions. A positive
budget requires a separate explicit request naming the amount. The Skill index
highlights reviews; you can still ask Pi to load the Skill and use Claudexor
explicitly for planning, research or delegation.

**Warning: subscription and billable add-on credits.** A zero paid budget
limits only the cash Claudexor itself accounts for. The second opinion runs on
the answering account's subscription quota. If the vendor account behind a
subscription route has paid add-on credits enabled, an automatic second opinion
can spend them, and the vendor bills you. Claudexor can neither see nor stop
that. The hard boundary is the vendor's own add-on credits setting; disabling
the Skill removes only the review instruction, and its tools stay available
through every active registration. Disabling the extension stops automatic
calls only where the extension supplies the only registration: a manual
`claudexor` entry in `~/.pi/agent/mcp.json` or the project's `.pi/mcp.json`
stays effective while it exists, so disable that entry as well and confirm the
connection is gone in `/mcp` after `/reload`.

The extension lists four read-only tools directly. That neither forces a call
nor changes any schema default. The harnesses named in Pi's server description
are examples, not an exhaustive list. The default is experimental and
model-mediated; it does not apply changes.
[Details and limits](https://github.com/razzant/claudexor/blob/main/docs/INTEGRATIONS.md#default-second-opinion-in-hermes-and-pi)

[Product overview](https://claudexor.ai/) ·
[documentation and source](https://github.com/razzant/claudexor#readme) ·
[releases](https://github.com/razzant/claudexor/releases/latest)
