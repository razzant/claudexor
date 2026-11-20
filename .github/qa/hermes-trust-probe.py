#!/usr/bin/env python3
"""QA-only probe, not product code: Hermes 0.23.1 native approval for the installed Claudexor plugin.

Real: the pinned Hermes discovery, tool registry, MCP handler, trust gate and approval route, the
installed plugin's own manifest, and the effective config merge. Stand-ins: the stdio MCP server (a
stdlib counter with one read-labelled and one write-labelled no-op) and the person (a callback that can
only answer "deny"; there is no approve path in this file). No model, account, network or credential.

  python -I probe.py stock|unattended|custom --hermes-src DIR --hermes-sha SHA
                     [--readme FILE --integrations FILE]     # the last two: custom mode
Each mode runs in its own process with stdin closed, in a profile from its own fresh install.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=("stock", "unattended", "custom"))
parser.add_argument("--hermes-src", required=True)
parser.add_argument("--hermes-sha", required=True)
parser.add_argument("--readme")
parser.add_argument("--integrations")
A = parser.parse_args()
LOG = None


def fail(message):
    print("FAIL:", message, flush=True)
    if LOG is not None and LOG.exists():
        print("transport log:", LOG.read_text().strip(), flush=True)
    raise SystemExit(1)


def check(condition, message):
    if not condition:
        fail(message)


# ---- preconditions: fresh isolated state, no bypass, no foreign configuration ----
bad = sorted(k for k in os.environ if k.startswith(("HERMES_", "CLAUDEXOR_")))
check(not bad, f"unexpected environment: {bad}")
HOME = pathlib.Path.home().resolve()
RT = os.environ.get("RUNNER_TEMP")
check(RT and HOME.is_relative_to(pathlib.Path(RT).resolve()), f"HOME {HOME} is not under RUNNER_TEMP")
HH = HOME / ".hermes"
check(HH.is_dir(), f"{HH} missing")
SRC = pathlib.Path(A.hermes_src).resolve()
head = subprocess.run(["git", "-C", str(SRC), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
check(head == A.hermes_sha, f"Hermes checkout is {head!r}, not the pin {A.hermes_sha}")
sys.path.insert(0, str(SRC))

# Match Hermes bootstrap: activate the committed dependency tree inside the
# launcher interpreter before loading any of its third-party packages.
from pm.environments import activate_dependencies  # noqa: E402

activate_dependencies(SRC)

import ruamel.yaml  # noqa: E402
_yaml = ruamel.yaml.YAML(typ="safe")

CFG = HH / "config.yaml"
cfg = _yaml.load(CFG.read_text()) if CFG.exists() else None
cfg = {} if cfg is None else cfg
check(isinstance(cfg, dict), "config.yaml is not a mapping")
check(not cfg.get("command_allowlist"), "profile already remembers approvals (command_allowlist)")
# Pinned fresh default (hermes_cli/config_defaults.py): approvals.mode is "smart". No approval setting is written here.
approvals = {} if cfg.get("approvals") is None else cfg["approvals"]
check(isinstance(approvals, dict) and approvals.get("mode") in (None, "smart"), f"approvals are not at the fresh default: {approvals!r}")
mcp_servers = {} if cfg.get("mcp_servers") is None else cfg["mcp_servers"]
check(isinstance(mcp_servers, dict), "mcp_servers is not a mapping")

WORK = pathlib.Path(tempfile.mkdtemp(prefix="cxprobe-"))
LOG = WORK / "transport.jsonl"
STORE = str(WORK / "store")
os.mkdir(STORE)

STUB = r'''
import json, os, sys
LOG = "@LOG@"
def log(**kw):
    with open(LOG, "a") as f:
        f.write(json.dumps(kw) + "\n")
def tool(name, read_only):
    return {"name": name, "description": "QA no-op " + name,
            "inputSchema": {"type": "object", "properties": {}},
            "annotations": {"readOnlyHint": read_only}}
TOOLS = [tool("read_probe", True), tool("write_noop", False)]
log(ev="start", argv=sys.argv[1:], store=os.environ.get("CLAUDEXOR_CONFIG_DIR"), pid=os.getpid())
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    rid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if rid is None:
        continue
    if method == "initialize":
        out = {"result": {"protocolVersion": params.get("protocolVersion"), "capabilities": {"tools": {}},
                          "serverInfo": {"name": "qa-counting-stub", "version": "0"}}}
    elif method == "tools/list":
        out = {"result": {"tools": TOOLS}}
    elif method == "tools/call":
        log(ev="call", tool=params.get("name"), pid=os.getpid())
        out = {"result": {"content": [{"type": "text", "text": "ok:" + str(params.get("name"))}], "isError": False}}
    elif method == "ping":
        out = {"result": {}}
    else:
        out = {"error": {"code": -32601, "message": "method not found"}}
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid, **out}) + "\n")
    sys.stdout.flush()
'''
shim = WORK / "claudexor"
shim.write_text(f"#!{sys.executable}\n" + STUB.replace("@LOG@", str(LOG)))
shim.chmod(0o755)
os.environ["PATH"] = str(WORK) + os.pathsep + os.environ.get("PATH", "")
check(shutil.which("claudexor") == str(shim), "a different claudexor shadows the QA stub")

# ---- config under test ----
if A.mode == "custom":
    check(A.readme and A.integrations, "custom mode needs --readme and --integrations")
    fence = re.compile(r"```json\n(.*?)\n```", re.S)

    def documented(path):
        found = []
        for raw in fence.findall(pathlib.Path(path).read_text()):
            if "CLAUDEXOR_CONFIG_DIR" in raw and '"trust"' in raw:
                found.append(json.loads(raw))
        return found

    from_readme, from_docs = documented(A.readme), documented(A.integrations)
    check(len(from_readme) == 1 and len(from_docs) == 1, f"documented trust snippets: {len(from_readme)} / {len(from_docs)}")
    check(from_readme[0] == from_docs[0], "README and INTEGRATIONS document different custom-store snippets")
    snippet = from_readme[0]
    check(snippet.get("trust") == "untrusted", "documented snippet does not keep trust: untrusted")
    check(snippet["env"]["CLAUDEXOR_CONFIG_DIR"] == "/absolute/path/to/your/existing/store", "unexpected placeholder")
    snippet["env"]["CLAUDEXOR_CONFIG_DIR"] = STORE
    check("claudexor" not in mcp_servers, "a same-name override is already present")
    cfg["mcp_servers"] = {**mcp_servers, "claudexor": snippet}
    with CFG.open("w") as f:
        _yaml.dump(cfg, f)
else:
    check("claudexor" not in mcp_servers, "a same-name override is already present")

# ---- real Hermes, imported only after environment and config are final ----
try:
    from tools.approval import is_approval_bypass_active, is_approved
    from tools.approval_context import _get_approval_mode, set_current_session_key
    from tools.mcp_tool_config import _load_mcp_config
    from tools.mcp_tool_discovery import discover_mcp_tools
    from tools.registry import registry
    from tools.terminal_tool import set_approval_callback
    import tools.registry as _registry_module
    from pm.environments import committed_venv, site_packages
except Exception as exc:  # an unverified import name or signature is a stated gap, not a pass
    fail(f"import of the pinned Hermes failed: {exc!r}")
check(pathlib.Path(_registry_module.__file__).resolve().is_relative_to(SRC), "Hermes modules are not from the pinned checkout")
env_ = committed_venv(SRC)
check(env_ is not None, "no committed dependency environment is recorded for this install")
selected = site_packages(env_)
check(pathlib.Path(ruamel.yaml.__file__).resolve().is_relative_to(selected.resolve()),
      f"ruamel.yaml is not from the committed dependency environment: {ruamel.yaml.__file__}")

asks = []


def deny(command, description, **kw):  # stands in for a person pressing Deny; no allow branch exists
    asks.append({"command": str(command), "kw": sorted(kw)})
    return "deny"


set_current_session_key("qa-approval-probe")
set_approval_callback(deny)
check(not is_approval_bypass_active(), "approval bypass is active")
# The fresh pinned default is "smart". It only matters to the generic command check: the MCP prompt route
# (request_elicitation_consent) does not read it, and bypass needs "off" or YOLO, both rejected above.
check(_get_approval_mode() == "smart", f"approval mode is {_get_approval_mode()!r}, not the pinned fresh default 'smart'")
for _tool in ("read_probe", "write_noop"):
    check(not is_approved("qa-approval-probe", f"mcp:claudexor/{_tool}"), f"a remembered approval already covers {_tool}")

entry = (_load_mcp_config() or {}).get("claudexor")
check(entry, "no effective 'claudexor' server (plugin not enabled or not merged)")
env_keys = sorted((entry.get("env") or {}))
print("effective entry:", {k: entry.get(k) for k in ("command", "args", "trust")}, "env keys:", env_keys, flush=True)
check(entry.get("command") == "claudexor" and entry.get("args") == ["mcp", "serve"], "effective command is not claudexor mcp serve")
check(entry.get("trust") == "untrusted", "effective entry is not untrusted")
if A.mode == "custom":
    check((entry.get("env") or {}).get("CLAUDEXOR_CONFIG_DIR") == STORE, "override entry did not win")
else:
    check("CLAUDEXOR_CONFIG_DIR" not in (entry.get("env") or {}), "stock entry carries a store override")


def rows(kind):
    lines = LOG.read_text().splitlines() if LOG.exists() else []
    return [r for r in map(json.loads, lines) if r.get("ev") == kind]


def calls():
    return [r["tool"] for r in rows("call")]


def text(result):
    return result if isinstance(result, str) else json.dumps(result)


code = 1
try:
    names = discover_mcp_tools(["claudexor"])
    check(names, "discovery returned no tools")
    pick = {s: [n for n in names if "claudexor" in n and n.endswith(s)] for s in ("read_probe", "write_noop")}
    check(all(len(v) == 1 for v in pick.values()), f"tool names not found uniquely: {names}")
    check(not calls(), "transport was called during discovery")
    starts = rows("start")
    check(starts and all(s["argv"] == ["mcp", "serve"] for s in starts), f"server not launched as 'mcp serve': {starts}")
    check(all(s["store"] == (STORE if A.mode == "custom" else None) for s in starts), f"wrong store at launch: {starts}")
    check(len(starts) == 1 and starts[0]["pid"] != os.getpid(), f"expected exactly one out-of-process stub, saw {starts}")

    if A.mode == "unattended":  # Hermes itself must refuse when nobody can answer; the callback stays unused
        os.environ["HERMES_CRON_SESSION"] = "1"

    out = text(registry.dispatch(pick["read_probe"][0], {}))  # case 1: read-labelled
    check("ok:read_probe" in out and not asks and calls() == ["read_probe"], f"read case: {out!r} asks={asks} calls={calls()}")

    out = text(registry.dispatch(pick["write_noop"][0], {}))  # case 2: write-labelled no-op
    try:
        error = json.loads(out)["error"]
    except Exception:
        fail(f"write case did not return an error object: {out!r}")
    check("did not approve" in error and "NOT run" in error, f"unexpected denial text: {error!r}")
    check("unavailable" not in error, f"approval system unavailable, not a denial: {error!r}")
    check(calls() == ["read_probe"], f"write-labelled call reached the transport: {calls()}")
    check(all(r["pid"] == starts[0]["pid"] for r in rows("call")), "a call was counted by a process other than the stub")
    if A.mode == "unattended":
        check(asks == [], f"callback was consulted in an unattended session: {asks}")
    else:
        check(len(asks) == 1, f"expected exactly one approval request, saw {len(asks)}")
        print("approval request:", asks[0]["command"][:200].replace("\n", " "), "| args:", asks[0]["kw"], flush=True)
    print(f"RESULT {A.mode}: PASS read reached transport with 0 prompts; write no-op: {len(asks)} prompt(s), "
          f"refused before transport (calls={calls()}); scripted stand-ins, pinned Hermes {A.hermes_sha[:8]}", flush=True)
    code = 0
finally:
    print("transport log:", LOG.read_text().strip() if LOG.exists() else "(empty)", flush=True)
    try:
        from tools.mcp_tool_lifecycle import shutdown_mcp_servers
        shutdown_mcp_servers()
    except Exception as exc:
        print("shutdown skipped:", repr(exc), flush=True)
    sys.stdout.flush()
