# Claudexor Host Integrations

`claudexor plugin` installs and manages user-global host integrations for
Claude Code, Codex, Cursor, and OpenCode. These integrations package Claudexor
instructions and MCP configuration for each host; orchestration remains owned by
the local Claudexor CLI/engine. MCP tools are one-shot final-output calls, not
live Claudexor thread parity.

```bash
claudexor plugin install all
claudexor plugin status all --json
claudexor plugin doctor all
claudexor plugin repair cursor
claudexor plugin uninstall opencode
```

The lifecycle commands are ownership-aware. Generated files carry Claudexor
markers and hashes in `~/.claudexor/plugins/state.json`; uninstall removes only
owned Claudexor files/config entries. Unknown user files fail loudly instead of
being overwritten. `--force` only reapplies verified Claudexor-owned drift; it
does not overwrite unowned files.

## Host Layouts

| Host | Installed artifacts |
| --- | --- |
| Claude Code | `~/.claude/skills/claudexor/` with `.claude-plugin/plugin.json`, skill, command, and `.mcp.json`. |
| Codex | Plugin source under `~/.codex/plugins/claudexor` and personal marketplace entry in `~/.agents/plugins/marketplace.json`. Status is `registered`; finish enablement from Codex Plugins. |
| Cursor | Local plugin under `~/.cursor/plugins/local/claudexor` with manifest, skill, command, and `mcp.json`. Reload Cursor if it does not auto-enable. |
| OpenCode | Global skill, command, `experimental.chat.system.transform` JS plugin, and `mcp.claudexor` in `~/.config/opencode/opencode.json` or strict-parseable `opencode.jsonc`. |

`--dry-run` reports the planned actions without writing files, deleting legacy
shims, or changing host configs. `plugin doctor` verifies install health and the
Claudexor MCP server startup; harness readiness remains `claudexor doctor`.
