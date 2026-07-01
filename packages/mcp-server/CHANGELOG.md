# @claudexor/mcp-server

## 0.14.1

- Expose advanced one-shot run controls (`reviewerPanel`, reviewer model/effort
  overrides, tests, budget, access, and protected-path approvals) in the MCP tool
  schema so the MCP surface stays a thin view of the CLI/control contract.
- Validate those advanced run controls at the MCP JSON-RPC boundary instead of
  silently dropping malformed arrays, maps, budget values, or reviewer entries.

## 0.14.0

## 0.13.3

## 0.12.1
