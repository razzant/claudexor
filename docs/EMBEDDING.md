# Embedding Claudex (Ouroboros substrate contract)

Claudex is designed to be embedded as the edit/review substrate inside other agents
(notably Ouroboros, replacing its `claude_code.py`). It exposes three stable,
language-agnostic boundaries. A Python caller can use any of them.

## 1. CLI with `--json`

Every command supports `--json` and prints a stable, schema-backed object.

```bash
claudex run "fix the failing auth test" --json
claudex ask "explain the auth flow" --json
claudex race "implement feature X" --n 4 --json
claudex plan "design a migration" --json
claudex inspect <run_id> --json
```

The JSON shape is the `OrchestratorResult` (run id, mode, status, winner, runDir,
candidates, decisionPath). Artifacts (TaskContract, events.jsonl, attempts,
reviews, arbitration/decision.yaml, final/work_product.yaml) live under
`<repo>/.claudex/runs/<run_id>/` and are themselves schema-validated.

Example (Python):

```python
import json, subprocess
res = json.loads(subprocess.check_output(["claudex", "run", "fix tests", "--json"]))
print(res["status"], res["runDir"])
```

## 2. JSON-RPC over stdio (adapter protocol)

`@claudex/adapter-protocol` defines a JSON-RPC-over-stdio protocol. It works in
two directions:

- **External harness adapters**: implement `claudex.discover/doctor/run/review/
  cancel` in any language; Claudex spawns and drives them (`spawnJsonRpcAdapter`).
- **Driving Claudex programmatically**: the daemon (`claudexd`) speaks JSON-RPC
  over a Unix socket (`claudex.health/enqueue/status/list/cancel/shutdown`).

```python
# Talk to the daemon over its unix socket (token in ~/.claudex/daemon/token).
import json, socket
def call(method, params=None):
    s = socket.socket(socket.AF_UNIX); s.connect(SOCK)
    s.sendall((json.dumps({"id":1,"method":method,"params":params,"token":TOKEN})+"\n").encode())
    return json.loads(s.makefile().readline())
```

## 3. MCP server

```bash
claudex mcp serve   # stdio JSON-RPC MCP server
```

Tools: `claudex_ask`, `claudex_run`, `claudex_race`, `claudex_plan`,
`claudex_create`, `claudex_status`. Any MCP client (Claude Code, Cursor,
Ouroboros' MCP client) can call them.

## ACP server

```bash
claudex acp serve   # Claudex as a meta-agent to editors (Zed/JetBrains/Neovim)
```

## Single-harness collapse

When only one harness is configured, Claudex behaves like that harness plus
artifacts/policies/budget ledger:

- only Codex configured -> Codex + artifacts
- only Claude configured -> Claude + artifacts

This is what makes Claudex a drop-in substrate: Ouroboros can swap its direct
`claude_code.py` calls for `claudex run --harness claude --json` (or the daemon /
MCP boundary) and get identical behavior plus the evidence ledger, with the
option to add cross-review and best-of-n later by configuring more harnesses.
