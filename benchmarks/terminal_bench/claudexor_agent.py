"""Claudexor as a Harbor (Terminal-Bench 2.1) installed agent.

Harbor drives an agent inside each task's isolated container. This adapter installs
Node + the Claude Code and Codex CLIs and uploads a **prebuilt single-file Claudexor
CLI bundle** (no in-container clone/``pnpm install``/``tsc`` — that repeatedly tripped
Harbor's AgentSetupTimeout under Rosetta), then runs Claudexor in INTERNAL
ORCHESTRATION mode against the live ``/app`` tree:

    claudexor run --in-place --attempts N --harness <h> --access full <instruction>

i.e. one harness implements in place, a DIFFERENT provider family reviews the live
tree, and Claudexor repairs until the cross-family review is clean or the bounded
attempt budget is exhausted. This is what makes the benchmark measure *Claudexor's
orchestration* (repair + cross-family review) rather than a single bare model.

Why in-place / single live container (not diff-merge best-of-N): Terminal-Bench scores
the container's runtime STATE (services, files, packages), which cannot be merged
across independent attempts. So the paradigm-correct Claudexor contribution here is
intra-trial: convergence + cross-family review inside one container.

Anti-cheating: convergence is driven by cross-family review (and the agent's own
checks). The agent is INSTRUCTED (see ``_PREAMBLE``) not to search for, read, or run
Terminal-Bench's hidden grading tests, but this is prompt-enforced under ``--access
full`` — there is no sandboxed filesystem read-protection yet (a future improvement),
so treat it as an instruction, not a hard guarantee.

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
        mode: str = "single",
        n: int | str | None = None,
        codex_model: str | None = None,
        claude_model: str | None = None,
        *args,
        **kwargs,
    ) -> None:
        # "single" = in-place convergence (--attempts). "race" = literal best-of-N
        # (--n <N> --harness <list>): isolated candidate envelopes + cross-family
        # review, winner's git diff auto-adopted into /app. NEVER pass --attempts in
        # race mode (it selects convergence and forecloses the race).
        self._mode = str(mode).strip().lower()
        self._harness = str(harness)
        self._reviewer_model = (str(reviewer_model) or None) if reviewer_model else None
        self._attempts = max(1, int(attempts))
        # Race width defaults to the number of comma-separated harnesses
        # (harness=codex,claude -> n=2, one candidate per family); explicit n wins.
        if n not in (None, ""):
            self._n = max(1, int(n))
        else:
            self._n = max(1, len([h for h in self._harness.split(",") if h.strip()]))
        self._codex_model = (str(codex_model) or None) if codex_model else None
        self._claude_model = (str(claude_model) or None) if claude_model else None
        self._max_usd = float(max_usd) if max_usd not in (None, "") else None
        # Legacy / accepted-but-unused: the CLI now ships as a prebuilt single-file
        # bundle uploaded into the container (see install()), so the code under test is
        # whatever was bundled on the host — NOT cloned in-container. These kwargs are
        # still accepted so `--ak claudexor_ref=...` doesn't error; to change the code
        # under test, rebuild the bundle from that ref on the host (`pnpm bench:bundle`).
        self._claudexor_ref = str(claudexor_ref)
        self._claudexor_repo = str(claudexor_repo or os.environ.get("CLAUDEXOR_TB_REPO", ""))
        super().__init__(logs_dir, *args, **kwargs)

    # No auto version probe; the launcher resolves Node lazily via nvm.
    def get_version_command(self) -> str | None:
        return None

    def render_instruction(self, instruction: str) -> str:
        # Prepend the benchmark-container preamble, then apply any configured template.
        return super().render_instruction(_PREAMBLE + instruction)

    # Where the host-side prebuilt CLI bundles live, and where they land in the
    # container. Shipping prebuilt files replaces the in-container clone +
    # `pnpm install` + `tsc` (~30 packages) that kept blowing Harbor's
    # AgentSetupTimeout under Rosetta. Build them with `pnpm bench:bundle`.
    #
    # TWO sibling bundles, NOT one: agent mode (`claudexor run`) routes through
    # ensureDaemon(), which auto-starts the daemon by spawning the SIBLING file
    # `new URL("./claudexord.js", import.meta.url)` next to the running CLI bundle
    # (there is no in-process fallback — runs are always daemon-tracked). So
    # claudexord.js MUST be installed alongside claudexor-cli.js in the SAME dir,
    # preserving the sibling relationship ensureDaemon() resolves.
    _BUNDLE_DIR = "/opt/claudexor"
    _CLI_BUNDLE_NAME = "claudexor-cli.js"
    _DAEMON_BUNDLE_NAME = "claudexord.js"
    _BUNDLE_HOST_DIR = Path(__file__).resolve().parent / "dist"
    _BUNDLE_HOST_PATH = _BUNDLE_HOST_DIR / _CLI_BUNDLE_NAME
    _DAEMON_HOST_PATH = _BUNDLE_HOST_DIR / _DAEMON_BUNDLE_NAME
    _BUNDLE_CONTAINER_PATH = f"{_BUNDLE_DIR}/{_CLI_BUNDLE_NAME}"
    _DAEMON_CONTAINER_PATH = f"{_BUNDLE_DIR}/{_DAEMON_BUNDLE_NAME}"

    def _ensure_host_bundle(self) -> tuple[Path, Path]:
        """Return (cli, daemon) bundle paths, building both on demand if missing.

        bundle-cli.mjs emits BOTH sibling bundles in one run; we treat them as a
        unit so a partial/stale dist never ships only the CLI (which would make
        every daemon-backed run fail at ensureDaemon's sibling existsSync check).
        """
        cli = self._BUNDLE_HOST_PATH
        daemon = self._DAEMON_HOST_PATH
        if cli.is_file() and daemon.is_file():
            return cli, daemon
        # Build them: `node benchmarks/terminal_bench/scripts/bundle-cli.mjs`. Requires the
        # workspace to be built first (the script self-checks for packages/cli/dist/*.js).
        import subprocess

        repo_root = Path(__file__).resolve().parents[2]
        builder = self._BUNDLE_HOST_DIR.parent / "scripts" / "bundle-cli.mjs"
        try:
            subprocess.run(
                ["node", str(builder)], cwd=str(repo_root), check=True
            )
        except (OSError, subprocess.CalledProcessError) as exc:
            raise RuntimeError(
                f"Claudexor CLI bundles not found at {self._BUNDLE_HOST_DIR} and could not "
                f"be built ({exc}). Build them on the host first: "
                f"`pnpm build && pnpm bench:bundle`."
            ) from exc
        missing = [p for p in (cli, daemon) if not p.is_file()]
        if missing:
            raise RuntimeError(
                f"bundle-cli.mjs ran but {', '.join(str(p) for p in missing)} still "
                f"missing. Run `pnpm build && pnpm bench:bundle` on the host."
            )
        return cli, daemon

    async def install(self, environment: BaseEnvironment) -> None:
        # 0) Resolve (build if needed) BOTH host-side CLI bundles BEFORE touching the
        #    container, so a missing/partial dist fails fast with a clear hint.
        cli_bundle, daemon_bundle = self._ensure_host_bundle()

        # 1) System packages (root): curl + ca-certificates to fetch nvm. (No git/clone
        #    anymore — the CLI ships as a prebuilt bundle, not a source checkout.)
        await self.exec_as_root(
            environment,
            command=(
                "if command -v apt-get >/dev/null 2>&1; then "
                "  apt-get update && apt-get install -y curl ca-certificates; "
                "elif command -v apk >/dev/null 2>&1; then "
                "  apk add --no-cache curl bash ca-certificates; "
                "elif command -v yum >/dev/null 2>&1; then "
                "  yum install -y curl ca-certificates; "
                "fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
            timeout_sec=600,
        )

        # 2) Node 22 (nvm) + the harness CLIs, as the default agent user so the runtime
        #    user owns them. The Claudexor CLI bundle still needs a node runtime AND the
        #    `claude`/`codex` CLIs it shells out to for cross-family implement+review.
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
                # Pin 22.16: 22.22+ libuv asserts under colima kernel; node:sqlite etc.
                # need >=22.12 even with UV_USE_IO_URING=0 on the emulated kernel.
                "nvm install 22.16.0 && nvm alias default 22.16.0\n"
                # Disable libuv io_uring: Node 20.3+/22 crashes with a uv__io_poll
                # epoll assertion inside emulated / older-kernel containers.
                "export UV_USE_IO_URING=0\n"
                # Both families so cross-family review (claude implement / codex review,
                # or vice versa) is always available.
                "npm install -g @anthropic-ai/claude-code@latest @openai/codex@latest\n"
            ),
            env=install_env,
            timeout_sec=900,
        )

        # 3) Upload BOTH prebuilt bundles side-by-side (uploads as root) and make them
        #    world-readable + executable so the agent user can run them. The daemon
        #    bundle MUST land in the same dir as the CLI bundle and keep the name
        #    `claudexord.js`: agent runs auto-start the daemon via the CLI's sibling
        #    resolution `new URL("./claudexord.js", import.meta.url)`, so the sibling
        #    relationship in /opt/claudexor IS the wiring — break it and every
        #    daemon-backed run fails (there is no in-process fallback).
        await self.exec_as_root(
            environment,
            command=f"mkdir -p {shlex.quote(self._BUNDLE_DIR)}",
            timeout_sec=120,
        )
        await environment.upload_file(str(cli_bundle), self._BUNDLE_CONTAINER_PATH)
        await environment.upload_file(str(daemon_bundle), self._DAEMON_CONTAINER_PATH)
        await self.exec_as_root(
            environment,
            command=(
                f"chmod 0755 {shlex.quote(self._BUNDLE_CONTAINER_PATH)} "
                f"{shlex.quote(self._DAEMON_CONTAINER_PATH)}"
            ),
            timeout_sec=120,
        )

        # 4) `claudexor` launcher on PATH (root-written, agent-resolved at runtime). The
        #    quoted heredoc keeps $HOME unexpanded so nvm resolves to the agent's HOME
        #    when the launcher runs; it then execs the uploaded single-file bundle.
        await self.exec_as_root(
            environment,
            command=(
                "cat > /usr/local/bin/claudexor <<'LAUNCH'\n"
                "#!/usr/bin/env bash\n"
                'export NVM_DIR="$HOME/.nvm"\n'
                '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true\n'
                f'exec node {shlex.quote(self._BUNDLE_CONTAINER_PATH)} "$@"\n'
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
        # Pin the claude candidate/reviewer model. Prefer the explicit claude_model
        # kwarg (race mode suppresses Harbor's -m so a global --model can't collide
        # across candidates), else Harbor's model_name. Claude Code reads ANTHROPIC_MODEL.
        claude_model = self._claude_model or (self.model_name.split("/")[-1] if self.model_name else None)
        if claude_model:
            env["ANTHROPIC_MODEL"] = claude_model
        codex_model = self._codex_model or self._reviewer_model
        if codex_model:
            # Codex cost estimator (review and, in race mode, the codex candidate);
            # the codex candidate's actual model is pinned via the seeded config.
            env["CLAUDEXOR_CODEX_MODEL"] = codex_model
        return env

    def _claudexor_command(self, instruction: str) -> str:
        flags = ["run", "--in-place", "--harness", self._harness]
        if self._mode == "race":
            # Literal best-of-N: N isolated candidates, cross-family review, winner's
            # git diff auto-adopted into /app. No --attempts (it selects convergence).
            flags += ["--n", str(self._n)]
        else:
            flags += ["--attempts", str(self._attempts)]
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
        # v0.9 trust gate: `--access full` requires a user-local trust allow for
        # the repo (sha256 of the repo root path, first 16 hex chars). The
        # benchmark container IS the sandbox (IS_SANDBOX=1), so granting full
        # access to /app here is the intended Harbor parity.
        seed_trust = (
            "mkdir -p \"$HOME/.claudexor/trust\" && "
            "h=$(printf %s /app | sha256sum | cut -c1-16) && "
            "printf 'allow_full_access: true\\n' > \"$HOME/.claudexor/trust/$h.yaml\""
        )
        # Pin each candidate's model via the user-level GlobalConfig
        # (harnesses.<id>.default_model). A single global --model would collide across
        # the two race candidates, so per-harness default_model is the correct knob;
        # ANTHROPIC_MODEL (set in _run_env) additionally pins claude. Schema is
        # non-strict with all-default fields, so this minimal shape validates.
        codex_model = self._codex_model or self._reviewer_model
        claude_model = self._claude_model or (self.model_name.split("/")[-1] if self.model_name else None)
        harness_yaml = ""
        if codex_model:
            harness_yaml += f"  codex:\n    default_model: {codex_model}\n"
        if claude_model:
            harness_yaml += f"  claude:\n    default_model: {claude_model}\n"
        seed_models = ":"
        if harness_yaml:
            cfg_yaml = "version: 1\nharnesses:\n" + harness_yaml
            seed_models = (
                'mkdir -p "$HOME/.claudexor" && '
                "printf %s " + shlex.quote(cfg_yaml) + ' > "$HOME/.claudexor/config.yaml"'
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
            f"{seed_trust}\n"
            f"{seed_models}\n"
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
