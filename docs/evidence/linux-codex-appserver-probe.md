# Linux Codex app-server probe

`.github/workflows/linux-codex-appserver-probe.yml` runs `scripts/linux-codex-appserver-probe.mjs`
on a disposable GitHub-hosted `ubuntu-24.04` runner. It asks, without any credential or model:
under the reported systemd hardening, does Ubuntu noble's packaged `bwrap-userns-restrict`
AppArmor profile restore the real Codex 0.162.1 sandbox that Claudexor's managed Codex route
reaches, both when one app-server is driven directly and when the real Claudexor daemon runs a
readonly ask, and does the failure return once the profile is removed again?

It is a diagnostic control. The profile changes exist only to locate the boundary on this
runner; neither their presence nor their absence is a recommendation for a host.

## What runs

- **Codex**: 0.162.1 from its public npm tarballs (registry `sha512` integrity, then pinned
  `sha256` of the launcher, native binary and bundled `bwrap`), unpacked into the npm global
  layout the managed installer produces. Each cell links it as `$HOME/.claudexor/node`, the
  managed prefix the harness PATH resolves `codex` from.
- **Product**: the built modules (`pnpm build` of `@claudexor/cli` and its dependencies), not
  copies of them.
- **Geometry**: every cell's worker is the main process of a transient system unit run as the
  runner's normal user with `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=no`,
  `PrivateNetwork=no`, `PrivateUsers=no`, `RestrictNamespaces=no`, and only its cell directory
  writable. A deliberate addition, not part of the report: `IPAddressDeny=any` with
  `IPAddressAllow=localhost`. Before any thread or daemon starts, the worker sends one UDP
  datagram to 192.0.2.1:9 (RFC 5737, never routed) and proceeds only when the send itself fails
  with `EPERM`, the unit filter's answer (a dropped TCP SYN is retransmitted, not reported);
  every proxy variable also points at a closed loopback port. A second deliberate addition:
  `PrivateTmp=yes`. Before it builds any restricted bwrap command, Codex 0.162.1 creates its
  fixed app-server socket rendezvous `/tmp/codex-daemon-<uid>` (mode 0700, independent of
  TMPDIR, HOME and CODEX_HOME by design; `codex-rs/uds/src/daemon_directory.rs:12-39`,
  `codex-rs/linux-sandbox/src/bwrap.rs:431` at `rust-v0.162.1`). With the host's /tmp read-only
  under `ProtectSystem=strict` that mkdir fails, and every readonly and workspace-write command
  ends `error building bubblewrap command: Read-only file system (os error 30)` before bwrap
  runs: run 40993163090's baseline, a failure unrelated to user namespaces that 0.153.3 (no such
  directory) cannot have. The worker checks its own cgroup, `NoNewPrivs` and `systemctl show`
  values, `PrivateTmp` included, and that its /tmp is writable (`access(2)`, nothing created);
  if not, capture is unknown and no Codex process starts.
- **Provider**: a loopback scripted Responses server inside the worker, never a model. It plays
  one script in whichever tool surface Codex offers: classic `exec_command` then `view_image`,
  or code mode (the JavaScript `exec` tool Codex 0.162.1 offers for Claudexor's default model),
  one cell whose nested `tools.exec_command` and `tools.view_image` reach the same sandboxed
  handlers. When asked for Claudexor's strict `work_report` envelope it answers `completed` only
  if the read exited 0, else `needs_input`. It logs every request, any credential header and
  every tool output by call id.

## Cells

| cell | what it drives | helper |
| --- | --- | --- |
| `system` | one app-server spawned by core `spawnProcess` with the adapter's own arguments (`CODEX_FILE_AUTH_ARGS`, `CODEX_PROJECT_DOC_FALLBACK_ARGS`, `app-server --stdio`), `providerScrubEnv()` plus a cell `CODEX_HOME` holding the provider config, the harness PATH, the adapter's `initialize`, `thread/start` and `turn/start` parameters for a readonly ask | the managed PATH unchanged: Codex can select `/usr/bin/bwrap` |
| `bundled` | the same | negative control: the managed PATH minus every directory holding a `bwrap`, a disclosed deviation that simulates a host without the bubblewrap package. The worker checks the PATH the native app-server actually ran with (`/proc/<pid>/environ`) and reports the control ineffective if it still holds a `bwrap` |
| `daemon` | `claudexor daemon start` of the built CLI in the cell's own data root, then one readonly ask through the product's `enqueueAndAwait` (mode `ask`, harness `codex`, access `readonly`, web off, no model, effort or profile pinned), the run detail, the run directory and `daemon stop` | the daemon resolves `codex` itself through its managed PATH |

The `daemon` cell takes the product's own api_key route: the cell's environment holds a
labelled dummy `OPENAI_API_KEY` that is never sent, and `CLAUDEXOR_DISABLE_STORED_SECRETS=1`.
The daemon's doctor runs `codex login status` (logged out) and its isolated API-key smoke
(`Reply exactly OK`); the run gets a fresh `CODEX_HOME` holding only `auth.json`, provider
variables scrubbed. The one redirect is outside Claudexor: Codex's system config layer,
`/etc/codex/config.toml`, which Codex 0.162.1 loads below `${CODEX_HOME}/config.toml`
(`codex-rs/config/src/loader/mod.rs:80,127` at `rust-v0.162.1`), names the loopback provider.
The probe installs it once per run as root 0644 (never over an existing file), persists the
restore record first, and removes it and any `/etc/codex` it created after the phases. The
provider answers the doctor's smoke with `OK`: admission through a fixture route, never auth
readiness. The paid budget is explicitly unlimited because the fixture can spend nothing; a
finite cap fails the run `cost_unverifiable` because Codex reports tokens, not cash.

Each app-server cell starts ONE app-server and asks, in order:

- `command/exec` readOnly: `cat` of `research/input.txt` (32 random bytes as hex); an identity
  script (namespace ids, `NoNewPrivs`, `Seccomp`, `CapEff`, AppArmor label, `PATH`,
  `command -v bwrap`); a write into the project, which must not land.
- `command/exec` workspaceWrite (Codex's echoed shape with its native `/tmp` and `TMPDIR` roots):
  a write into the project, which must land, and a write into a cell directory outside the
  project, `TMPDIR` and `/tmp` that the unit itself can write, which must not.
- `command/exec` dangerFullAccess: the same read and a write into the cell's own control
  directory, both expected to work in every phase.
- One scripted model turn under `sandbox: "read-only"`: the shell tool runs the nonce read, the
  identity facts and a write into the project (`write_rc=`), then `view_image` on a 1x1 PNG
  (Codex's filesystem helper, a separate sandboxed surface), then a message quoting both.

The `daemon` cell's scripted turn runs the same command and image inside the real daemon run.
The nonce never appears in any prompt or script; it reaches an answer only through a tool output.

Codex's `configWarning` and `warning` notifications are kept verbatim in the app-server cells.
The startup list counts as complete only when the `remoteControl/status/changed` frame, which the
server sends right after its startup warnings, has arrived. In the `daemon` cell those frames
stay inside the adapter (counted in the run telemetry's `dropped_events`).

## Phases

| phase | host change |
| --- | --- |
| `baseline` | none |
| `distro-profile` | `bwrap-userns-restrict` from `apparmor-profiles` 4.0.1really4.0.1-0ubuntu0.24.04.9 (.deb and file `sha256` pinned) copied to `/etc/apparmor.d` as root 0644 and loaded with `apparmor_parser -K -r` |
| `restored-baseline` | none, after the profile was unloaded and the file restored |
| `minimal-profile` | only if the distro profile showed a known read failure for the system helper (not inconclusive or unknown evidence) with every earlier phase verified: the prior minimal `flags=(unconfined) { userns, }` profile for `/usr/bin/bwrap` (byte for byte as `bdd217377a9f` loaded it) loaded from a file with `apparmor_parser -K -r`, nothing installed |
| `minimal-restored` | none, after the minimal profile was unloaded |

The distro file is extracted from the pinned `.deb`; the package is not installed, so none of its
other profiles load. `-K` skips the binary cache so a restore leaves no cache file. Any earlier
file at the install path is kept with its mode and owner and restored byte for byte. The minimal
comparison is not a product fallback or a recommended setup; when its condition does not hold
its cells are `skipped`.

## Verdicts

Only exit codes, the exact random bytes, host file existence and content, namespace ids and the
typed shape of a tool output decide a verdict. Vendor stderr, warnings and kernel lines are
evidence.

- readonly: `usable` (read exact, write refused without host effect, new user, mount and network
  namespaces), `capability_failed` (the read did not return the bytes), `write_not_refused`,
  `not_isolated`, `inconclusive`, `unknown`.
- workspace_write: `usable` (project write landed with the exact marker, outside write refused),
  `capability_failed`, `outside_write_landed`, `inconclusive`, `unknown`.
- full: `usable` or `failed`.
- turn exec_command: `read` (the app-server's commandExecution item exited 0 and its first output
  line is the exact nonce) or `not_read`. With no commandExecution item, `not_read` comes only
  from Codex 0.162.1's pre-start denial frame: a sandboxed launch that exits non-zero within its
  150 ms early-exit grace with a denial keyword is returned as SandboxDenied before the item is
  begun, and the model receives `Chunk ID … / Wall time: 0.0000 seconds / Process exited with
  code N / Original token count … / Output:` (`core/src/unified_exec/process.rs:381-398`,
  `process_manager.rs:521-592`, `tools/handlers/unified_exec/exec_command.rs:441-461`); the
  frame must be untruncated, without the nonce, in a completed turn, and is recorded as
  `execEvidence: denied_before_start`. Any other item-less output, a success above all, stays
  `capture_unknown`; view_image: `returned_image` (the provider received an
  `input_image`) or `failed` (it received Codex's error text); write: `refused` (`write_rc` not 0,
  no host file), `landed`, `not_started`.
- daemon read: `read` (the provider received a tool output that exited 0 with the nonce as its
  first line, and the daemon's recorded answer carries the nonce), `not_read`, `not_admitted`
  (no harness attempt started), `capture_unknown`; view_image and write as above, plus
  view_image `not_reached` when the code-mode cell returned no `view_image` line. Beside them:
  the run status and work state, requested and effective access, and from the run's own
  `final/telemetry.yaml` the auth mode, observed model, `tool_errors_total`,
  `unrecovered_tool_errors` and `dropped_events`.

Helper identity comes from evidence inside and around the sandbox, never from PATH alone: every
executable the worker's cgroup sampler saw (`/proc/<pid>/exe` every 20 ms; the bundled helper
runs as `/proc/self/fd/N`, whose exe link still names its file), the sha256 of the native
app-server binary it saw against the pin, the in-sandbox label, `command -v bwrap`, Codex's
startup `configWarning`, and AppArmor `execpath` kernel lines.

## How to read

- Compare phases only in a `complete` run; a `not_run` cell or any defect leaves the comparison open. A `skipped` phase is a comparison whose condition did not hold, not a defect.
- Remedy support needs: `system` readonly and workspace_write `capability_failed` at baseline, `usable` under distro-profile with the scripted turn's exec_command `read`, view_image `returned_image` and write `refused`, the `daemon` cell `read` with effective access readonly, and the baseline verdicts back in restored-baseline.
- `daemon` is the real built daemon, orchestrator and Codex adapter on the api_key route with a labelled dummy key; Codex's system config layer names the loopback provider, which also answers the doctor's `Reply exactly OK` smoke. That is admission through a fixture route, never auth readiness. Its `read` needs the tool output and the daemon's recorded answer to carry the nonce.
- `bundled` is a negative control (no bwrap on its PATH, a disclosed deviation from the managed PATH, checked against the PATH the app-server actually ran with): the profile names /usr/bin/bwrap, so `bundled` usable under distro-profile breaks the control.
- `full` runs without bubblewrap and should stay `usable` in every phase; a failure there is not about the userns restriction.
- minimal-profile runs only after a known read failure of the system helper under the distro profile (readonly `capability_failed`, the turn's exec_command or the daemon read `not_read`) with every earlier phase verified; inconclusive or unknown evidence is data and never admits it. A system cell that passes there but failed under distro-profile points at the distro profile itself (its stacked `unpriv_bwrap` child, NoNewPrivileges), not at the userns restriction.
- Helper identity comes from evidence, not PATH: executables the cgroup sampler saw (a short-lived failing helper can be missed), the in-sandbox label (`bwrap//&unpriv_bwrap` expected under the distro profile), `command -v bwrap`, Codex's startup configWarning, and kernel `execpath` lines. A missing kernel line is not evidence that nothing happened.
- A configWarning list counts as complete only when `settled` (Codex's remote-control status frame, sent right after its startup warnings, arrived).
- A sandbox that refuses (`not_read`, `capability_failed`, a refused write) is data; a missing model request, tool call or captured tool result (`no_model_request`, `not_called`, `capture_unknown`, `rpc_error`) for the scripted turn's exec_command or the daemon read is a harness defect, and unknown namespace identity alone only leaves readonly `inconclusive`. Without a commandExecution item the turn's exec_command is `not_read` only from Codex's pre-start denial frame (wall time zero, non-zero exit, a denial keyword, untruncated, no nonce, turn completed; `execEvidence: denied_before_start`); any other item-less output stays `capture_unknown`.
- Model-path verdicts come from a scripted provider: they show the tool surfaces and Claudexor's handling of a report derived from the tool result, not a real model's choices or `needs_input` judgement.

## Stop rules and the job result

A cell whose capture is unknown (missing observations, a worker that did not exit 0 by itself
including an `ENOBUFS` or timed-out unit run, an unreadable frame, a request that timed out or
found the app-server gone, the wrong Codex version, an outside-write target under a native
writable root, egress not shown closed, a daemon that did not start fresh or a run that did not
end) or whose cleanup is unknown (no observed app-server or daemon exit, a process tree
`spawnProcess` could not confirm ended, any process left in the unit cgroup, a unit not shown
stopped), or whose classified verdict is unknown or unexercised (`capture_unknown`, `rpc_error`, `no_model_request`, `not_called`, an unknown access mode; the same set the summary reports as defects), stops every later cell and phase; a change already applied is still restored. A phase
whose end state does not equal its start (sysctls, loaded profiles, the profile file) stops the
rest. The workflow re-runs the idempotent restore of every recorded change (both profiles and
`/etc/codex/config.toml`) in an `always()` step.

Sandbox verdicts never fail the job. It exits 0 `complete` only when every planned cell ran with
known capture and cleanup, a scripted turn exec_command and daemon read that reached the model path, outside controls, geometry, closed egress and kernel log, the fixture
unchanged, no credential header, an effective bundled control, an admitted daemon route, the
provider route installed and removed, and every phase ended in its starting state; 1
`incomplete` otherwise; 2 for an unsupported host (not Linux x64, root, no systemd-run or sudo,
missing build, a work directory under `/tmp` or too long for the daemon socket, an existing
`/etc/codex/config.toml`) or a harness error.

## Running it

`workflow_dispatch` once the file is on the default branch; before that, a push to the single
diagnostic branch:

    git push origin <commit>:refs/heads/diag/linux-codex-appserver-probe

The artifact `linux-codex-appserver-probe-<run id>-<attempt>` holds `summary.json`,
`summary.md`, host and install receipts, the distro profile receipt and file, the provider-route
records, per phase the host reads and every `sudo` command record, and per cell
`phases/<phase>/cells/<cell>/`: spec, observations, unit and dmesg records, the kernel-log diff,
provider request bodies and replies, and for app-server cells the complete app-server
stdin/stdout/stderr streams and notifications; for the daemon cell the CLI start/stop records,
the harness list, the request, outcome and run detail, the whole run directory and the daemon log.

## What a result cannot show

- A real model's tool choices, observed model and `needs_input` judgement: the scripted provider
  derives its report from the tool result.
- The native subscription route of the #337 runs (`auth_mode: local_session`): it needs a real
  login. The daemon cells use the api_key route with a dummy key.
- Codex 0.162.1 only (the #337 host ran 0.153.3), on a GitHub VM rather than the #337 host.
- A read-only host /tmp under 0.162.1: each cell gets a private /tmp. Run 40993163090's baseline
  (shared, read-only /tmp) already showed that every restricted command then fails before bwrap.
- The `bundled` cell's PATH deviates from the managed one on purpose.
