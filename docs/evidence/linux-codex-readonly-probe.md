# Linux Codex readonly probe (claudexor#337)

`.github/workflows/linux-codex-readonly-probe.yml` runs
`scripts/linux-codex-readonly-probe.mjs` on a GitHub-hosted `ubuntu-24.04` x86_64 runner. It asks
one question without any credential: does the real Codex 0.162.1 Linux read-only sandbox read a
project file and refuse a write for the same normal user, both directly and inside a systemd
service with the hardening reported in #337?

## What runs

- Codex 0.162.1, the release-tested baseline, from its public npm tarballs. Each tarball must match
  its registry `sha512` integrity; it is unpacked into the npm global layout the managed installer
  produces, and the launcher, native binary and bundled `bwrap` must match pinned `sha256` digests.
- `codex sandbox -- <command>`, Codex's CLI entry point to its sandbox. Without configuration it
  applies the read-only policy and starts the `codex-linux-sandbox` helper with arguments from the
  same builder as the agent's command execution. No login, model, API key or token is involved:
  each Codex process gets an explicit seven-variable environment with a fresh `HOME` and
  `CODEX_HOME`.
- Ubuntu's `bubblewrap` (the reported system `bwrap`) and `strace` are installed on the disposable
  runner. Apart from those packages and the transient units, nothing on the runner changes: no
  kernel parameter, AppArmor policy or capability is touched.

Four cells, every combination of:

| geometry | meaning |
| --- | --- |
| direct | the runner's normal user, from the workflow step |
| service | the same user in a transient `systemd-run` unit with `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=no`, `PrivateNetwork=no`, `PrivateUsers=no`, `RestrictNamespaces=no` and only the cell directory writable |

| helper | meaning |
| --- | --- |
| system | standard `PATH`; Codex selects the first suitable `bwrap` on it |
| bundled | a `PATH` without `bwrap`; Codex falls back to its own `codex-resources/bwrap` |

In each cell the probe writes a random nonce into a project file and checks, outside Codex, that
the same user can read it and write that directory. Through `codex sandbox` it then runs `cat` of
the nonce file, a namespace identity script, and a write into the project directory. A final
`strace -f` run of the read and the kernel log before and after the cell are kept as raw
diagnostics.

Each transient unit also gets `RuntimeMaxSec=600` and `TimeoutStopSec=30`, which bound only its
life. However the wait ends, the probe reads that exact unit's state, stops it and reads it again.

## Verdicts

- `proven`: the nonce came back, the command ran in new user and mount namespaces, and the write
  started inside and failed with an exit status (no signal, error or timeout), leaving no host file.
- `capability_failed`: `codex sandbox` did not return the nonce, for example because the helper
  failed before the command. Its stderr, the trace and the kernel log stay evidence; they do not
  decide the verdict.
- `not_isolated`: the command ran in the caller's user or mount namespace.
- `write_not_refused`: the write reached the host file.
- `inconclusive`: a control failed or the evidence is incomplete.

A service cell also reports whether its geometry was established: the worker ran in the expected
unit, the kernel shows `NoNewPrivs: 1`, and `systemctl show` reports each requested value. The run
exits 0 only when every cell is `proven`, every service geometry is established and every unit is
shown stopped; 1 otherwise; 2 for an unsupported host or a harness failure. A kernel log that
could not be read is reported as `unavailable`, never as empty.

## Running it

`workflow_dispatch` is available once this file is on the default branch. Before that, a push to
the single diagnostic branch runs it:

    git push origin <commit>:refs/heads/diag/linux-codex-readonly-probe

The artifact `linux-codex-readonly-probe-<run id>-<attempt>` holds `summary.json`, `summary.md`,
host and install receipts, and for each cell its spec, observations, and the complete argv, env,
stdout and stderr of every process it started, with `strace.txt` and the kernel log captures.

## What a result can and cannot show

- No model turn or Claudexor review runs, so model-driven project reading remains unproven.
- A GitHub-hosted VM is not the #337 host: kernel build, AppArmor policy and unit details may
  differ. No result here establishes or excludes the original cause.
- The transient unit reproduces only the reported hardening. The original unit's other
  properties, environment, `PATH` and writable paths are unknown.
- Helper choice is steered only through `PATH`, Codex's own selection rule; the trace shows which
  `bwrap` was executed.

The same Codex build has a second credential-free route that this probe does not run: the
app-server Claudexor uses, after its `initialize` handshake, accepts `command/exec` with
`sandboxPolicy: {"type": "readOnly"}` and runs one command under its sandbox without a thread or
turn. A follow-up could add it to cover the app-server process itself.
