"""Claudexor as a Harbor (Terminal-Bench 2.1) installed agent.

Harbor drives an agent inside each task's isolated container. This adapter installs
Node + the Claude Code and Codex CLIs + the Claudexor control plane, then runs Claudexor
in INTERNAL ORCHESTRATION mode against the live ``/app`` tree:

    claudexor run --in-place --attempts N --harness <h> --access full <instruction>

i.e. one harness implements in place, a DIFFERENT provider family reviews the live
tree, and Claudexor repairs until the cross-family review is clean or the bounded
attempt budget is exhausted. This is what makes the benchmark measure *Claudexor's
orchestration* (repair + cross-family review) rather than a single bare model.

Why in-place / single live container (not diff-merge best-of-N): Terminal-Bench scores
the container's runtime STATE (services, files, packages), which cannot be merged
across independent attempts. So the paradigm-correct Claudexor contribution here is
intra-trial: convergence + cross-family review inside one container.

Anti-cheating: convergence is driven ONLY by cross-family review (and the agent's own
checks), never by Terminal-Bench's hidden grading tests.

Run (PYTHONPATH must include the repo root so this module is importable):

    PYTHONPATH=<repo> harbor run \\
      -d terminal-bench/terminal-bench-2-1 \\
      --agent-import-path benchmarks.terminal_bench.claudexor_agent:ClaudexorAgent \\
      -m anthropic/claude-opus-4-7 \\
      --ak harness=claude --ak reviewer_model=<openai-model> --ak attempts=2

Host env required: ANTHROPIC_API_KEY and/or OPENAI_API_KEY for the chosen harness
and cross-family reviewer. The Claudexor repo URL/ref are configurable via agent kwargs.
"""

from __future__ import annotations

import os
import re
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Prepended to every task instruction so the harness behaves correctly inside an
# autonomous, isolated benchmark container (no human, hidden tests off-limits).
_PREAMBLE = (
    "You are operating fully autonomously inside an isolated benchmark container.\n"
    "- Complete the task end to end. Do NOT ask questions; there is no human to answer.\n"
    "- Inspect the local environment first (files, running services, available CLIs,\n"
    "  localhost ports). Prefer services/APIs already present in the container over real\n"
    "  external or cloud accounts; if the task names a local endpoint, use it.\n"
    "- Do NOT search for, read, or run the grading/verifier tests; they are hidden by\n"
    "  design. Solve the task on its merits.\n"
    "- Produce exactly the files, paths, and outputs the task specifies.\n\n"
    "Task:\n"
)


class ClaudexorAgent(BaseInstalledAgent):
    """Run the Claudexor control plane (in-place convergence + cross-family review)."""

    SUPPORTS_ATIF: bool = False

    @staticmethod
    def name() -> str:
        return "claudexor"

    def __init__(
        self,
        logs_dir: Path,
        harness: str = "claude",
        reviewer_model: str | None = None,
        attempts: int | str = 2,
        max_usd: float | str | None = None,
        claudexor_ref: str = "main",
        claudexor_repo: str | None = None,
        *args,
        **kwargs,
    ) -> None:
        self._harness = str(harness)
        self._reviewer_model = (str(reviewer_model) or None) if reviewer_model else None
        self._attempts = max(1, int(attempts))
        self._max_usd = float(max_usd) if max_usd not in (None, "") else None
        self._claudexor_ref = str(claudexor_ref)
        self._claudexor_repo = str(claudexor_repo or os.environ.get("CLAUDEXOR_TB_REPO", "https://github.com/joi-lab/claudexor.git"))
        super().__init__(logs_dir, *args, **kwargs)

    # No auto version probe; the launcher resolves Node lazily via nvm.
    def get_version_command(self) -> str | None:
        return None

    def render_instruction(self, instruction: str) -> str:
        # Prepend the benchmark-container preamble, then apply any configured template.
        return super().render_instruction(_PREAMBLE + instruction)

    async def install(self, environment: BaseEnvironment) -> None:
        # 1) System packages (root): curl + git to fetch nvm and clone Claudexor.
        await self.exec_as_root(
            environment,
            command=(
                "if command -v apt-get >/dev/null 2>&1; then "
                "  apt-get update && apt-get install -y curl git ca-certificates; "
                "elif command -v apk >/dev/null 2>&1; then "
                "  apk add --no-cache curl git bash ca-certificates; "
                "elif command -v yum >/dev/null 2>&1; then "
                "  yum install -y curl git ca-certificates; "
                "fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
            timeout_sec=600,
        )

        # 2) Node 22 (nvm), the harness CLIs, and the Claudexor CLI (built from source),
        #    all as the default agent user so the runtime user owns them.
        install_env: dict[str, str] = {"COREPACK_ENABLE_DOWNLOAD_PROMPT": "0"}
        await self.exec_as_agent(
            environment,
            command=(
                'set -euo pipefail\n'
                # Persist the full install log to the host trial dir even on failure.
                "mkdir -p /logs/agent 2>/dev/null || true\n"
                'exec > >(tee -a /logs/agent/claudexor-install.log) 2>&1\n'
                'export NVM_DIR="$HOME/.nvm"\n'
                'mkdir -p "$NVM_DIR"\n'
                "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash\n"
                '. "$NVM_DIR/nvm.sh"\n'
                # Node 22 is required by the repo's pinned pnpm@11 (uses node:sqlite).
                # Pin 22.16: 22.22+ libuv asserts under colima kernel; pnpm@11 needs >=22.12 (uv__io_poll EEXIST assert) under
                # colima's emulated kernel even with UV_USE_IO_URING=0.
                "nvm install 22.16.0 && nvm alias default 22.16.0\n"
                "corepack enable\n"
                # Node 22.11's bundled corepack ships stale npm signing keys
                # ("Cannot find matching keyid"); skip integrity pinning here.
                "export COREPACK_INTEGRITY_KEYS=0\n"
                "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0\n"
                # Cap V8 heap; TB task containers are memory-limited and a parallel
                # 29-package tsc build otherwise OOMs (SIGABRT / exit 134).
                "export NODE_OPTIONS=\"--max-old-space-size=2048\"\n"
                # Disable libuv io_uring: Node 20.3+/22 crashes with a uv__io_poll
                # epoll assertion inside emulated / older-kernel containers.
                "export UV_USE_IO_URING=0\n"
                # Both families so cross-family review (claude implement / codex review,
                # or vice versa) is always available.
                "npm install -g @anthropic-ai/claude-code@latest @openai/codex@latest\n"
                f"git clone --depth 1 --branch {shlex.quote(self._claudexor_ref)} "
                f"{shlex.quote(self._claudexor_repo)} \"$HOME/claudexor\"\n"
                'cd "$HOME/claudexor"\n'
                # --ignore-scripts skips dependency postinstalls; the esbuild native
                # binary's postinstall SIGSEGVs in TB's sandboxed container, and esbuild
                # is needed neither by the tsc build nor the JS runtime.
                # Serialize pnpm io: high-parallelism fd polling trips a racy epoll
                # EEXIST assert (libuv) on colima's virtiofs/QEMU stack.
                "export UV_THREADPOOL_SIZE=4\n"
                "pnpm install --frozen-lockfile --ignore-scripts --network-concurrency=2 --child-concurrency=1\n"
                # Serialize the build so only one tsc runs at a time (low peak memory).
                "pnpm build -- --concurrency=1\n"
            ),
            env=install_env,
            timeout_sec=1800,
        )

        # 3) `claudexor` launcher on PATH (root-written, agent-resolved at runtime). The
        #    quoted heredoc keeps $HOME unexpanded so it resolves to the agent's HOME
        #    when the launcher runs.
        await self.exec_as_root(
            environment,
            command=(
                "cat > /usr/local/bin/claudexor <<'LAUNCH'\n"
                "#!/usr/bin/env bash\n"
                'export NVM_DIR="$HOME/.nvm"\n'
                '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true\n'
                'exec node "$HOME/claudexor/packages/cli/dist/cli.js" "$@"\n'
                "LAUNCH\n"
                "chmod +x /usr/local/bin/claudexor"
            ),
            timeout_sec=120,
        )

    def _run_env(self) -> dict[str, str]:
        env: dict[str, str] = {}
        for key in (
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
        ):
            val = self._get_env(key)
            if val:
                env[key] = val
        # Let Claude Code use bypassPermissions even when the container's default user
        # is root (this is how Harbor's own claude-code agent runs).
        env["IS_SANDBOX"] = "1"
        # Avoid the libuv io_uring crash (uv__io_poll assertion) that aborts Node
        # 20.3+/22 in emulated / older-kernel containers; inherited by claude/codex too.
        env["UV_USE_IO_URING"] = "0"
        if self.model_name:
            model = self.model_name.split("/")[-1]
            # Pin the Claude implementer/reviewer model via Claude Code's env knob.
            env["ANTHROPIC_MODEL"] = model
        if self._reviewer_model:
            # Used by Claudexor's codex cost estimator when codex reviews.
            env["CLAUDEXOR_CODEX_MODEL"] = self._reviewer_model
        return env

    def _claudexor_command(self, instruction: str) -> str:
        flags = [
            "run",
            "--in-place",
            "--attempts",
            str(self._attempts),
            "--harness",
            self._harness,
        ]
        if self._reviewer_model:
            flags += ["--reviewer-model", f"openai={self._reviewer_model}"]
        # A value-flag (`--access full`, optionally `--max-usd`) is always the last
        # flag so the trailing instruction stays a positional and is never swallowed
        # by the boolean `--in-place`.
        flags += ["--access", "full"]
        if self._max_usd is not None:
            flags += ["--max-usd", str(self._max_usd)]
        cmd = "claudexor " + " ".join(shlex.quote(f) for f in flags) + " " + shlex.quote(instruction)

        seed_codex_auth = (
            'if [ -n "${OPENAI_API_KEY:-}" ]; then '
            'mkdir -p "$HOME/.codex" && '
            'printf \'{"auth_mode":"apikey","OPENAI_API_KEY":"%s"}\\n\' "$OPENAI_API_KEY" '
            '> "$HOME/.codex/auth.json"; fi'
        )
        # Always exit 0: Terminal-Bench scores the container STATE via hidden tests, not
        # the agent's exit code. A non-converged Claudexor run still leaves valid work in
        # /app; let the verifier judge it. Claudexor's own status lives in the artifacts.
        export_artifacts = (
            "mkdir -p /logs/agent/claudexor-runs && "
            "cp -R /app/.claudexor/runs/. /logs/agent/claudexor-runs/ 2>/dev/null || true"
        )
        return (
            "cd /app\n"
            f"{seed_codex_auth}\n"
            f"{cmd} || true\n"
            f"{export_artifacts}\n"
        )

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        await self.exec_as_agent(
            environment,
            command=self._claudexor_command(instruction),
            env=self._run_env(),
            cwd="/app",
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        # Best-effort: sum cost_usd across copied Claudexor attempt artifacts so Harbor
        # reports a non-zero cost for the trial. No hard dependency on a YAML parser.
        runs_dir = self.logs_dir / "claudexor-runs"
        if not runs_dir.exists():
            return
        total = 0.0
        found = False
        for attempt in runs_dir.rglob("attempt.yaml"):
            try:
                text = attempt.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            m = re.search(r"cost_usd:\s*([0-9]+(?:\.[0-9]+)?)", text)
            if m:
                total += float(m.group(1))
                found = True
        if found:
            context.cost_usd = total
