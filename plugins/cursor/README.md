# Claudexor for Cursor

A portable Skill and local MCP bridge for an existing Claudexor installation.
This package contains no runtime, credentials, hooks, or automatic setup.

Before enabling it, make the preinstalled `claudexor` command available on
Cursor's PATH and configure the existing Claudexor daemon/account route. Use
macOS or Linux with Node.js 24.15 or newer. Do not enable this alongside an
existing generated Claudexor integration in the same host.

The repository's `.cursor-plugin/marketplace.json` points to this package. It
can also be loaded as a local Cursor plugin. Host installation, tool discovery,
and an agent-in-the-loop run are separate acceptance checks, not implied by
manifest validation. See [integration instructions and limitations](https://github.com/razzant/claudexor/blob/main/docs/INTEGRATIONS.md#portable-agent-skill-and-host-packages).

The Skill and `mcp.json` are generated copies of the canonical portable assets
in `plugins/copilot`; contributors regenerate them with `pnpm gen:version`.
