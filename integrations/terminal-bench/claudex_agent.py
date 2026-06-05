"""Claudex as a Terminal-Bench 2.1 installed agent.

Terminal-Bench drives an agent inside a per-task Docker container's tmux session.
This adapter installs Node + the chosen harness(es) + the Claudex CLI into the
container and runs `claudex run` (daily mode) against the task instruction.

Why daily / single-harness here:
  Terminal-Bench tasks are STATEFUL terminal tasks (install software, configure
  services, edit files). Claudex's cross-harness best-of-N is patch-oriented:
  it shines on SWE-bench-style file edits where independent candidate diffs can
  be reviewed and one selected. You cannot meaningfully "merge"/"select" two
  independent stateful terminal sessions, so on Terminal-Bench the paradigm-
  correct mode is daily: one harness drives the real container with `--access
  full`. Claudex still adds value (uniform routing, artifacts, budget ledger,
  honest cost) and collapses cleanly to the native harness.

Usage:
  tb run \
    --agent-import-path integrations.terminal_bench.claudex_agent:ClaudexAgent \
    --agent-kwarg harness=claude \
    -d terminal-bench-core==0.1.1 --task-id hello-world

Requires on the HOST env: ANTHROPIC_API_KEY and/or OPENAI_API_KEY for the chosen
harness, and GITHUB_TOKEN to fetch the (private) Claudex repo into the container.
"""

import os
import shlex
from pathlib import Path

from terminal_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from terminal_bench.terminal.models import TerminalCommand


class ClaudexAgent(AbstractInstalledAgent):
    @staticmethod
    def name() -> str:
        return "claudex"

    def __init__(
        self,
        model_name: str | None = None,
        harness: str = "claude",
        claudex_ref: str = "main",
        claudex_repo: str = "github.com/joi-lab/claudex.git",
        *args,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._model_name = (model_name or "").split("/")[-1]
        self._harness = harness
        self._claudex_ref = claudex_ref
        self._claudex_repo = claudex_repo

    @property
    def _env(self) -> dict[str, str]:
        env: dict[str, str] = {}
        for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"):
            val = os.environ.get(key)
            if val:
                env[key] = val
        env["CLAUDEX_HARNESS"] = self._harness
        if self._model_name:
            env["CLAUDEX_MODEL"] = self._model_name
        return env

    def _get_template_variables(self) -> dict[str, str]:
        return {
            "claudex_ref": self._claudex_ref,
            "claudex_repo": self._claudex_repo,
        }

    @property
    def _install_agent_script_path(self) -> Path:
        return self._get_templated_script_path("claudex-setup.sh.j2")

    def _run_agent_commands(self, instruction: str) -> list[TerminalCommand]:
        model_flag = f"--model {shlex.quote(self._model_name)} " if self._model_name else ""
        command = (
            'source "$HOME/.nvm/nvm.sh"; '
            f"claudex run --harness {shlex.quote(self._harness)} --access full "
            f"{model_flag}{shlex.quote(instruction)}"
        )
        return [
            TerminalCommand(
                command=command,
                min_timeout_sec=0.0,
                max_timeout_sec=float("inf"),
                block=True,
                append_enter=True,
            )
        ]
