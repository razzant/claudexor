# Claudexor for Claude Code

A portable Skill and local MCP bridge for an existing Claudexor installation,
distributed directly from the Claudexor GitHub repository.

Before enabling it, make the preinstalled `claudexor` command available on
Claude Code's PATH and configure the existing Claudexor daemon/account route.
Use macOS or Linux with Node.js 24.15 or newer. This package contains no runtime,
credentials, hooks, status-line collector, or automatic setup. Do not enable it
alongside an existing generated Claudexor integration in the same host.

The repository's `.claude-plugin/marketplace.json` points to this package.
See [installation instructions and limitations](https://github.com/razzant/claudexor/blob/main/docs/INTEGRATIONS.md#portable-agent-skill-and-host-packages).
Manifest validation does not prove host installation, tool discovery, or an
agent-in-the-loop run.

The Skill and `.mcp.json` are generated copies of the canonical portable assets
in `plugins/copilot`; contributors regenerate them with `pnpm gen:version`.
