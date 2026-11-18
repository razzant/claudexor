# Claudexor for Claude Code and OpenClaw

A portable Skill and local MCP bridge for an existing Claudexor installation.
[Set up the CLI and connect an account](https://github.com/razzant/claudexor#set-up-the-cli-and-account)
on the machine that runs your agent.

## Claude Code

With `node` and `claudexor` on Claude Code's PATH, install this bundle from
the Claudexor repository's marketplace:

```sh
claude plugin marketplace add razzant/claudexor
claude plugin install claudexor@claudexor
```

Enable only one Claudexor integration in Claude Code. If you already use the
managed integration, keep using it. Contributors regenerate the Skill and
`.mcp.json` from the portable assets in `plugins/copilot` with `pnpm gen:version`.
[Claude Code setup and lifecycle](https://github.com/razzant/claudexor/blob/main/docs/INTEGRATIONS.md#portable-agent-skill-and-host-packages).

## Install in OpenClaw

Use a [package checkout](https://github.com/razzant/claudexor#get-a-package-checkout) on
the Gateway machine with both `node` and `claudexor` on the Gateway service's
PATH. OpenClaw 2026.11.5 needs Node 24.16.0–24.x or 26.1.0+.

```sh
openclaw plugins install "$HOME/claudexor-hosts/plugins/claude"
openclaw plugins inspect claudexor
```

If disabled, run `openclaw plugins enable claudexor`. If you use a plugin
allowlist, include `claudexor`. [OpenClaw plugin policy](https://docs.openclaw.ai/tools/plugin#configure-plugin-policy).
The embedded agent's tool policy and any sandbox
allowlist must permit the tools you intend to use, starting with
`claudexor__claudexor_status`. If the service PATH changed or the installer
requests it, run `openclaw gateway restart`. If your CLI uses a custom
`CLAUDEXOR_CONFIG_DIR`, [configure the MCP server to use the same store](https://github.com/razzant/claudexor/blob/main/docs/INTEGRATIONS.md#custom-claudexor-configuration-directory).
Open a fresh embedded agent session.
[Check status and get your first answer](https://github.com/razzant/claudexor#first-delegation-from-any-host).

Integration by [Ouroboros](https://github.com/razzant/ouroboros).
