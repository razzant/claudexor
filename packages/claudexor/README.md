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

```bash
npm install -g claudexor
claudexor doctor

claudexor ask "map this repository"
claudexor agent "implement the approved plan" --harness codex
claudexor best-of "review this patch" --harness codex,claude --n 2
claudexor mcp serve
```

This package is the bin wrapper over
[`@claudexor/cli`](https://www.npmjs.com/package/@claudexor/cli).

[Product overview](https://razzant.github.io/claudexor/) ·
[documentation and source](https://github.com/razzant/claudexor#readme) ·
[releases](https://github.com/razzant/claudexor/releases/latest)
