# Linux Codex readonly probe (claudexor#337)

`.github/workflows/linux-codex-readonly-probe.yml` runs
`scripts/linux-codex-readonly-probe.mjs` on a GitHub-hosted `ubuntu-24.04` x86_64 runner. It asks
one question without any credential: does the real Codex 0.162.1 Linux read-only sandbox read a
project file and refuse a write for the same normal user, both directly and inside a systemd
service with the hardening reported in #337? It then runs the same four cells under two controlled
host changes, one at a time, to find which restriction the result depends on.

This is a diagnostic control on a disposable runner. The two host changes exist only to locate the
boundary behind #337 on that runner, and neither is a recommended setting for a host that runs
Claudexor.

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
  runner. Apart from those packages, the transient units and the two control phases below, each of
  which reverts its own change, nothing on the runner changes.

Four cells, every combination of:

| geometry | meaning |
| --- | --- |
| direct | the runner's normal user, from the workflow step |
| service | the same user in a transient `systemd-run` unit with `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=no`, `PrivateNetwork=no`, `PrivateUsers=no`, `RestrictNamespaces=no` and only the cell directory writable |

| helper | meaning |
| --- | --- |
| system | standard `PATH`; Codex selects the first suitable `bwrap` on it |
| bundled | a `PATH` without `bwrap`; Codex falls back to its own `codex-resources/bwrap` |

In each cell the worker first checks that Codex launches there at all: `codex --version` must print
`codex-cli 0.162.1`. It writes a random nonce into a project file and checks, outside Codex, that
the same user can read it and write that directory. Through `codex sandbox` it then runs `cat` of
the nonce file, an identity script (namespace ids, `NoNewPrivs`, `Seccomp`, `CapEff` and the
AppArmor label inside the sandbox) and a write into the project directory. A final `strace -f` run
of the read and the kernel log before and after the cell are kept as raw diagnostics.

Each transient unit also gets `RuntimeMaxSec=600` and `TimeoutStopSec=30`, which bound only its
life. However the wait ends, the probe reads that exact unit's state, stops it and reads it again.

## Phases

The four cells run three times, in this order:

| phase | host change during the phase |
| --- | --- |
| `baseline` | none: the runner as provisioned |
| `apparmor-bwrap-profile` | a per-binary AppArmor profile for `/usr/bin/bwrap` that grants `userns` |
| `userns-sysctl-relaxed` | `kernel.apparmor_restrict_unprivileged_userns=0` |

Every phase that starts reads the recorded sysctls (the user-namespace and AppArmor restrictions,
`user.max_user_namespaces`, Yama's ptrace scope and the printk rate limit) and the kernel's loaded
AppArmor profile list (`/sys/kernel/security/apparmor/profiles`) before its cells, after its change
in a control phase, and after it ends. It also keeps a kernel-log diff for each cell.

`apparmor-bwrap-profile` writes Ubuntu's minimal per-binary form for a third-party user of user
namespaces into the artifact directory, loads it with `sudo apparmor_parser -r` and removes it
with `sudo apparmor_parser -R` after the cells. Nothing is installed in `/etc/apparmor.d`.

    abi <abi/4.0>,
    include <tunables/global>

    profile bwrap /usr/bin/bwrap flags=(unconfined) {
      userns,
    }

The system-helper cells are the test. The bundled-helper cells are negative controls: the profile
attaches only to an executable at `/usr/bin/bwrap`, and Codex executes its bundled helper, a
different file, through `/proc/self/fd/N`. The service cells keep `NoNewPrivileges=yes`, which
restricts AppArmor profile transitions on exec. The probe does not adjust the unit for that; each
cell records its verdict, the AppArmor label inside the sandbox and the kernel's AppArmor lines,
so the run shows whether the profile attached there.

`userns-sysctl-relaxed` records the original value, runs
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, runs the cells and writes the
recorded value back the same way.

Both control phases follow the same rules:

- A phase changes the host only from the reported restriction: the sysctl reads `1` and no profile
  named `bwrap` is loaded. Otherwise it changes nothing and its cells are `not_run`.
- Its cells run only when the host state read after the change differs from the state before by
  exactly the intended change: the profile `bwrap (unconfined)` added, or the sysctl `1 -> 0`.
- Once it has attempted a change, it always reverts it, also when the change could not be verified
  or a cell failed.
- A phase has ended in its starting state only when the sysctls and the profile list read
  afterwards equal those read before it. Otherwise every later phase is `not_run`.

The privileged commands live in the probe script, and its tests pin their exact argv, order and
restore logic with injected commands. The workflow file runs no `sysctl`, `apparmor_parser` or
`aa-*` command itself.

## Verdicts

Each cell's verdict comes from its untraced runs only:

- `proven`: Codex launched; the nonce came back; the command ran in new user, mount and network
  namespaces; and the write started inside and failed with an exit status (no signal, error or
  timeout), leaving no host file. The network namespace counts because the #337 error comes from
  bubblewrap configuring loopback in a new one. `proven` does not attest which helper executed;
  see `trace.helper` below.
- `capability_failed`: Codex launched, but `codex sandbox` did not return the nonce, for example
  because the helper failed before the command. Its stderr, the trace and the kernel log stay
  evidence; they do not decide the verdict.
- `not_isolated`: the command ran in the caller's user, mount or network namespace.
- `write_not_refused`: the write reached the host file.
- `inconclusive`: an outside control failed, the namespace ids are unknown, or the write did not
  start inside or ended by signal, error or timeout.
- `worker_defect`: no sandbox ran. In that cell `codex --version` did not print the pinned version
  (a missing node or launcher, for example), a probe process could not be started, or the cell
  worker left no observations.
- `not_run`: the cell was planned but never started, because its phase's precondition or change
  was not verified or an earlier phase did not end in its starting state.

Each cell also reports:

- `trace.helper`: which `bwrap` the separately traced read executed. That read is a different
  process from the runs that decide the verdict. The system helper appears as an exec of
  `/usr/bin/bwrap` with argv0 `bwrap`. Codex runs its bundled helper by opening the file and
  executing `/proc/self/fd/N` with argv0 `bwrap`, so that exec alone does not name the file. The
  probe reports `bundled` only when the trace shows an `open` or `openat` in the same thread that
  returned N before the exec and named the installed helper; otherwise the attribution is inferred
  from the exec of `/proc/self/fd/N` with argv0 `bwrap` and reported as `bundled (inferred)`.
- `sandboxLabel`: the AppArmor label the identity script read inside the sandbox, when it ran.
- `kernelLog`: the dmesg lines added during the cell (`kernel-log-diff.txt` in its evidence), its
  AppArmor audit records grouped by operation, profile, target, capability and `execpath`, and the
  count in any `callbacks suppressed` line. The kernel prints that line only when the next audit
  line passes the limiter, so the count can cover lines dropped before the cell began. With no audit
  daemon, the kernel prints audit records to dmesg under the printk rate limit
  (`kernel.printk_ratelimit` seconds, `kernel.printk_ratelimit_burst` lines, both recorded), and
  AppArmor suppresses repeated audit records of the same capability denial for the same profile. The
  probe waits `kernel.printk_ratelimit` + 1 seconds before each cell, so every cell starts with a
  fresh window. A missing line is still not evidence that nothing was denied. Run 40865743092 logged
  exactly 10 audit lines in its first cell and none in later cells, which fits that limit at its
  default burst of 10.

A service cell also reports whether its geometry was established: the worker ran in the expected
unit, the kernel shows `NoNewPrivs: 1`, and `systemctl show` reports each requested value.

## Job conclusion

Sandbox verdicts are experimental data and never fail the job. `summary.json` records the harness
`outcome` and its `defects`, every phase with its host-state reads, setup and restore command
records, observed differences and sandbox outcome, and every cell labelled with its `phase`. The
run:

- exits 0 (`complete`) when all twelve planned cells ran with their evidence and every phase ended
  in its starting host state;
- exits 1 (`incomplete`) on any harness defect: a cell `not_run` or `worker_defect`, a failed
  outside control, a cell worker that did not exit 0, an unavailable kernel log, a missing trace,
  an unestablished service geometry, a transient unit not shown stopped, a control change that
  could not be verified, or a host state not restored;
- exits 2 for an unsupported host or a harness exception.

A kernel log that could not be read is reported as `unavailable`, never as empty. A phase's sandbox
outcome is `write_not_refused` when any write landed, `proven` only when all four of its cells are
`proven` without a defect, `not_run` when none ran, and `not_proven` otherwise.

The runner is discarded after the job, so the restores protect the comparison and the later
phases. A job stopped by its time limit restores nothing, and it fails.

## Running it

`workflow_dispatch` is available once this file is on the default branch. Before that, a push to
the single diagnostic branch runs it:

    git push origin <commit>:refs/heads/diag/linux-codex-readonly-probe

The artifact `linux-codex-readonly-probe-<run id>-<attempt>` holds `summary.json`, `summary.md`,
host and install receipts, and per phase under `phases/<phase>/`: the host-state reads
(`host-before/`, `host-applied/`, `host-after/`), the `setup` and `restore` command records and,
for `apparmor-bwrap-profile`, the loaded `bwrap.apparmor`. Each cell under
`phases/<phase>/cells/<cell>/` keeps its spec, observations, `kernel-log-diff.txt` and the complete
argv, env, stdout and stderr of every process it started, with `strace.txt` and the kernel log
captures.

## What a result can and cannot show

- No model turn or Claudexor review runs, so model-driven project reading remains unproven.
- A GitHub-hosted VM is not the #337 host: kernel build, AppArmor policy and unit details may
  differ. No result here establishes or excludes the original cause.
- The transient unit reproduces only the reported hardening. The original unit's other
  properties, environment, `PATH` and writable paths are unknown.
- A verdict that changes between phases shows which restriction this runner's failure depends on.
  It does not show that the original host failed for the same reason, and neither change becomes
  a fix to apply to a host.
- Helper choice is steered only through `PATH`, Codex's own selection rule. Which helper ran comes
  from the separately traced read; the bundled helper's file is named only when the trace binds
  its descriptor, and is otherwise inferred.

The same Codex build has a second credential-free route that this probe does not run: the
app-server Claudexor uses, after its `initialize` handshake, accepts `command/exec` with
`sandboxPolicy: {"type": "readOnly"}` and runs one command under its sandbox without a thread or
turn. A follow-up could add it to cover the app-server process itself.
