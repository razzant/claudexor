#!/usr/bin/env bash
# Opt-in git hooks for THIS repository. Not auto-installed: run
#   bash scripts/install-hooks.sh
# to enable the per-commit review gate locally. CI/external agents run
# `node scripts/commit-review.mjs` directly (see CONTRIBUTING.md).
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
hooks_dir="$repo_root/.git/hooks"

cat > "$hooks_dir/pre-commit" <<'HOOK'
#!/usr/bin/env bash
# Claudexor per-commit review gate (installed by scripts/install-hooks.sh).
# Bypass (audited): SKIP_COMMIT_REVIEW="reason" git commit ...
exec node "$(git rev-parse --show-toplevel)/scripts/commit-review.mjs"
HOOK
chmod +x "$hooks_dir/pre-commit"

cat > "$hooks_dir/prepare-commit-msg" <<'HOOK'
#!/usr/bin/env bash
# Echo an audited review bypass into the commit body (the bypass is only
# honest if the commit itself discloses it).
marker="$(git rev-parse --show-toplevel)/.claudexor/logs/.last-bypass"
if [ -f "$marker" ]; then
  {
    echo ""
    cat "$marker"
  } >> "$1"
  rm -f "$marker"
fi
HOOK
chmod +x "$hooks_dir/prepare-commit-msg"

echo "installed: pre-commit (review gate) + prepare-commit-msg (bypass disclosure)"
