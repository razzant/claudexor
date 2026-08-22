# Changelog

Release history for Claudexor. The current version is declared in the root
`package.json` (the version SSOT); tags `v*` correspond to GitHub Releases.

- **v3.8.1** (2026-08-22): profile-scoped Antigravity runs now create and use
  a private macOS keychain under each profile HOME before the vendor touches
  Keychain Services. This removes the recurring “Keychain not found” dialog
  without changing the host default keychain, native-HOME behavior, or
  multi-account separation. The release also carries the pending daemon
  concurrency and native delegated-access changes already merged on `main`.
- **v3.8.0** (2026-08-20): a host embedding Claudexor can finish `Connect` for
  a vendor CLI that is not installed yet. `claudexor harness install` gains an
  explicit `--target local`: npm-pinned vendors install into the managed
  toolchain root (`~/.claudexor/node`) that local binary resolution and
  confinement already read, instead of the SSH-host prefix the historical
  `remote` target owns; the script vendors (cursor, agy) keep choosing their
  own destination (`~/.local/bin` / `~/.cursor/bin`) — the receipt discloses
  where, and the resolver reads both.
  The watched remote flow keeps its prefix, its disclosure and its exit-code
  contract, and neither the install lease, the post-install proof, nor the
  empty-download refusal applies to it. Two deliberate differences remain and
  are the whole list: a refused install no longer creates an empty vendor root
  before refusing, and — because the resolver now reads Cursor's own
  `~/.cursor/bin` — vendor children resolve executables through one more
  user-owned directory of the same trust class as the `~/.local/bin` they
  already searched. The lease also does not serialize a local install against
  a concurrent remote one writing the same vendor-chosen launcher; upstream
  had no serialization anywhere, so that is the inherited baseline, disclosed
  rather than claimed away. What the unattended local path
  has instead of a human at the terminal is proof: concurrent
  installs into one prefix serialize on a cross-process lease (a lease whose
  owner died fails closed with a typed `install_lock_stale` and its exact
  cleanup path, never an ABA-prone auto-reclaim), and success requires
  resolving the installed launcher and executing its `--version` — a child
  exiting zero without that postcondition is a typed
  `install_verification_failed`, so `ok:true` always carries `installedBinary`
  and `installedVersion`. A script vendor installed this way is disclosed as
  `unattended_unpinned` and records the downloaded installer's size and
  sha256; it never claims the `human_observed` verification the watched path
  earns. The signed runtime closure now also ships `claudexor.bundle.cjs`
  stamped with the same build sha as the daemon, so the host invokes that
  exact reviewed CLI rather than anything it found on PATH. Three model-gate
  defects found by the release review are fixed with it: a cursor account
  pinned by a credential profile now answers its OWN model inventory through
  the same route resolver its run uses (previously the gate consulted the
  engine-default ladder, got an empty list, and refused a model the pinned
  account genuinely offers); the pre-run gate no
  longer replays an admitted credential route as an auth preference for every
  adapter (a non-Cursor `auto` run was enumerated against an inventory its own
  spawn would not use), and no spawned spec is rewritten any more, so Cursor's
  `auth_switched`/`readiness_preferred` disclosure survives an explicit-model
  `auto` run. The Cursor model inventory now also runs in the run's `cwd`.
  This publish uses the owner-approved one-release `skip_custom_ed25519`
  waiver: Apple codesigning/notarization, GitHub provenance and npm provenance
  are unchanged, and the three custom Ed25519 documents are simply absent
  rather than unsigned — no client signature check is weakened.
  The release also carries the Windows Antigravity work merged from PR #207:
  credential-profile custody and managed setup login become platform-aware,
  with an exact Windows Antigravity one-binding policy, vendor-proven
  doctor/quota results, durable ambiguity handling, and host-resolved terminal
  capability projection.
- **v3.6.0** (2026-08-18): the unified account model (INV-135 rewrite,
  owner-approved). Every account is a named registry row; the separate
  "default"/"CLI login" account type is gone. A detected legacy claude/codex
  default-store login auto-registers at daemon start as the ordinary
  `<harness>-default` row through a crash-recoverable migration: while it is
  incomplete the affected harness refuses runs with a typed error, and
  `POST /v2/accounts-migration/rollback` is the supported downgrade path.
  Unpinned runs route through a quota-aware pool of enabled+ready rows with
  sticky, disclosed thread bindings; explicit pins stay strict (typed
  `subscription_window_exhausted` refusal, no silent rotation); pool
  exhaustion is a typed `credential_pool_exhausted` terminal carrying the
  pool's earliest known reset, and the paid API-key route serves it only under
  the explicit `api_key` preference, never silently under `auto` (owner Q3=A).
  New wire surface is additive: the `accountPools` pool authority plus
  `GET /v2/account-pools` (the feature marker) and the migration rollback
  endpoint; `harnessAccounts` stays on the wire as `[]` for legacy strict
  clients. Cursor host-Keychain logins are retired — every cursor account
  lives in an isolated vendor file-store row, and `auth login` becomes
  bootstrap sugar into the `<harness>-default` row. Deleting a row is provable
  (typed retryable error on partial cleanup) and retires migrated legacy
  aliases in the same operation. See PR #206 for the full story.
- **v3.5.0** (2026-08-17): Google's Antigravity CLI (`agy`) becomes a
  Claudexor harness, with the thing the vendor itself does not offer — several
  Google AI Pro/Ultra subscriptions signed in side by side and rotated on
  quota. Accounts are named profiles, each a Claudexor-owned home directory
  where the vendor keeps its own token file, so the operator's real home and
  login keychain stay untouched (live-proven across three Google accounts on
  macOS). Sign-in works from the app card: the vendor prints a link and waits
  sixty seconds for a pasted code, reads that code only from a real terminal
  (the daemon-hosted runner interposes `expect(1)` and propagates the vendor's
  own exit status), and the job's deadline IS the vendor's window — published
  as fixed, refused on extend, with a bounded exchange grace after the paste
  so the clock cannot cancel a sign-in that succeeded. `claudexor quota` reads
  each account's own `/quota`; every Antigravity window is model-scoped, so an
  exhausted Gemini budget does not block the account's Claude/GPT slugs, and a
  run naming no model is governed by whichever budget the profile's selected
  model actually spends. `claudexor harness install agy` downloads Google's
  official installer in full (PowerShell one on Windows), prints its size and
  sha256, and runs the file it showed — never a piped script. Disclosed
  honestly rather than hidden: the vendor exposes no config-dir variable, so
  one profile home also holds its conversation state and threads are not
  isolated from each other; no machine-readable account identity exists;
  platform isolation is proven on macOS only and doctor says so elsewhere.
  Also in this release: the Windows process-identity reader no longer times
  out on a cold PowerShell, silently degrading Windows runs. Development ran
  as five parallel reviewed phases plus an integration wave; the closing
  triad+scope wave ran through Claudexor's own agentic flow and its sol slot
  caught the resident-TUI login defect none of seven prior waves saw.
- **v3.4.2** (2026-08-16): every mutating delegated cursor run on macOS
  crashed within seconds — `RetriableError: [internal] unable to open database
  file` (SQLITE_CANTOPEN). cursor-agent keeps its chat store in SQLite under
  the scoped HOME, SQLite canonicalizes the database path on open
  (`realpath(3)` lstat/readlinks every intermediate component), and the
  Seatbelt profile's runtime-root read deny covered the components between the
  runtime root and the allowed scoped home. This is the same class the 3.3.15
  CODEX_HOME fix closed for the native state root — and the residual its
  review predicted for the scoped home — so the metadata traversal carve-out
  now covers the union of EVERY own root's denied ancestors (scoped home,
  worktree, native state root): literal, metadata-only, placed after the deny
  it punches through. Nothing else is re-opened — file data under the runtime
  root, sibling projects, and directory listings stay denied, and the boundary
  probe semantics are unchanged. Two-sided `sandbox-exec` regressions pin the
  class (canonicalize of each own root, a cursor-shaped SQLite open+WAL write,
  and both pre-fix reproductions with the carve-out stripped), and the
  real-harness battery's delegated-confinement phase grows a cursor case
  beside codex, capability-checked against the real repo mutation and its
  green test gate rather than exit status alone.
- **v3.4.1** (2026-08-15): the Windows native-login groundwork, grown from
  community PR #189 (Renat, @dead9111) and reworked with the contributor's
  three commits preserved. Windows could not reach the login lane at all: the
  sealed manifest rejected `C:\...` paths and process identity answered
  `unsupported_platform`, so no execution permit was ever issued. The
  absolute-path contract is now a REGEX covering POSIX, drive-rooted, and UNC
  spellings — chosen over a `node:path` refinement because only a regex
  survives `schema:gen` as a JSON Schema `pattern` (the refinement silently
  relaxed the generated wire contract to `minLength: 1`) — with drive-relative
  `C:x` and root-relative `\x` refused and the Swift decoder mirroring the
  same rule. Process identity gains an OPT-IN win32 reader that takes the
  kernel's own process creation time (`GetProcessTimes` via the absolute
  System32 PowerShell) as the birth token, so a recycled PID compares
  DIFFERENT exactly as on POSIX; the default service still answers
  `unsupported_platform`, so run capture, the orphan reaper, and the daemon
  writer lease keep their fail-closed Windows behavior. Windows has no process
  groups and no cooperative TERM, so on the login lane both escalation steps
  are one identity-gated `taskkill /T /F` of the recorded leader's tree — the
  terminator this repo already owns — and emptiness is the leader's identity
  being gone, disclosed in ARCHITECTURE as a leader-death proof rather than
  the POSIX group-ESRCH proof. The vendor binary is still executed without a
  shell: on win32 the harness resolver offers only executable images
  (`.exe`/`.com`, the v3.3.9 `git.exe` rule), and an npm `.cmd`/shell shim is
  refused with an advisory naming the real cause (issue #191 tracks spawning
  shims through their JS entry). Login env allowlists forward the Windows
  process-environment keys and match them case-insensitively on win32 only
  (`SystemRoot` vs `SYSTEMROOT`; on POSIX `http_proxy` and `HTTP_PROXY` stay
  distinct) through one shared picker that also repairs the pre-existing
  `SYSTEMROOT` hole in clean-env spawns. The journal partition walker now
  addresses entries with `join`, fixing a real 3.4.0 Windows regression where
  the second daemon start read its own journal as missing and demanded
  recovery (the contributor's own find). The detached login runner passes
  `windowsHide` so "no Terminal" also means no console window, and a failed
  codex login no longer recommends the macOS-only `--browser-redirect`
  Terminal handoff off macOS. A `windows-latest` CI lane is REQUIRED through
  the `build-test` aggregate and earned its place on its first run: it caught
  8.3-short-path temp fixtures, live-proved the PowerShell identity reader,
  and surfaced that journal compaction cannot rename over its own open handle
  on Windows (issue #190; those four cases are skipped there with the cause
  named). Ordinary codex runs on Windows with an npm install remain
  non-functional (the shim class, issue #191) — this release makes the
  refusal typed and honest rather than ENOENT.
- **v3.4.0** (2026-08-15) — Shared data roots are now protected by a
  persistent root-authority barrier: the daemon records a writer epoch and a
  proven serving-version floor, refuses grants from released or foreign
  leases, and rejects malformed version candidates even on a fresh floor.
  Startup runs in two stages — a strictly read-only preparation that inspects
  the writer lease and journal partitions, then, only after the authority is
  won and the preparation revalidates, the floor advance, crash garbage
  collection, and journal activation. A stale flat-layout root from an older
  daemon migrates in place with no window where the anchor file is absent,
  and staleness is only concluded from a proven-dead writer. When a partition
  needs recovery the daemon serves recovery-only: product routes answer a
  typed error while recovery routes stay available, and a successful
  quarantine reopens the journals and completes normal admission in the same
  process, so repair needs no restart. The serving mode is reported honestly
  across the control handshake, CLI start report, remote commands, the macOS
  app, and the harness battery. Quarantining one partition can no longer
  disturb a healthy sibling's preparation identity, and the setup supervisor
  cannot be started twice after an in-process reopen. The daemon also
  recovers automatically from Linux zombie writer leases while keeping live
  or uncertain owners fail-closed, survives disconnected RPC followers
  instead of crashing, and treats web access as optional for every non-off
  policy with native Cursor web approvals for managed read-only runs. CLI
  readiness waits through the transient recovery-only startup window: acting
  commands and `daemon start` keep re-handshaking until normal admission
  opens or the start budget expires, so a healthy journal-heavy startup is
  never misreported as a recovery-blocked daemon.

- **v3.3.16** (2026-08-15) — The macOS packager now removes the exact
  pre-3.3.13 `dist/Claudexor.app` only after a successful Swift build produces
  the release executable; failed or incomplete builds preserve both app paths,
  and unrelated `dist` content survives. Data-root ownership is now explicit by
  mode: the default root recognizes archived `v2` and active `v3`, while `v1`
  remains unrecognized because v1-era bytes lived directly under
  `~/.claudexor`; an explicit `CLAUDEXOR_CONFIG_DIR` treats `v1`, `v2`, and
  `v3` children as ordinary unrecognized entries. Reporting remains advisory
  and never deletes these paths. The Cursor adapter follows the current stream
  contract by dropping strict user prompt echoes, preserving nested token usage
  without inventing a dollar cost, and classifying permission-denied tool
  results as denied. The built-in OpenRouter route now preserves finite
  non-negative `usage.cost`, including zero, as an exact USD receipt; explicit
  terminal provider-error completions fail with safe typed evidence, while
  ordinary stop and length completions remain successful. Cold daemon starts
  now wait up to 90 seconds for large journals instead of reporting failure
  after 15 seconds while initialization continues in the background.

- **v3.3.15** (2026-08-10) — Mutating delegated codex runs work again on
  macOS. Codex canonicalizes its `CODEX_HOME` at startup, and the Seatbelt
  profile's runtime-root read deny covered the intermediate path components
  between the runtime root and the allowed native state root, so every
  confined `workspace_write` codex run died in seconds with `failed to
  canonicalize CODEX_HOME … Operation not permitted`
  (`route.transient.exhausted: process_crash`). The profile now grants a
  literal, metadata-only (`file-read-metadata`) allowance for exactly that
  ancestor chain, placed after the deny it traverses. File data under the
  runtime root — including the daemon token — and directory listings (readdir
  is a data read) stay denied, and the boundary-probe semantics are unchanged.
  The profile also grants read+exec on the managed toolchain subtree
  (`~/.claudexor/node` — subpath, derived from the launcher's own
  `managedNodeRoot` helper, emitted only when it lies inside the runtime
  root): in the default layout the harness binaries live inside the denied
  tree, and the VM battery's phase 13 proved exec of
  `<runtime root>/node/bin/codex` died with `sandbox-exec: execvp() …
  Operation not permitted` (exit 71); toolchain writes and everything else
  under the runtime root stay denied.
  Two-sided `sandbox-exec` tests pin both directions, and the real-harness
  battery gains phase 13: a live delegated mutating codex run under the OS
  boundary with per-candidate confinement evidence.

- **v3.3.14** (2026-08-09) — Accounts and quota reliability. The macOS
  Accounts popover now keeps its header fixed above a screen-bounded scroller,
  labels the implicit vendor identity `CLI login`, and carries Cursor emails
  from the existing typed status probe without another subprocess. Opening or
  connecting hydrates the cacheable account registry instead of launching a
  full provider cycle; expensive readiness/quota refresh is explicit, while
  live quota markers coalesce into a display-only read with at most one
  trailing request. Last-known figures remain visible with a stale/error
  disclosure, and a failed refresh no longer erases account rows or presents
  old readiness as current. Model-scoped windows and the server-owned quota
  availability projection now reach Swift, so a Fable-only exhausted window is
  labelled as scoped and cannot become an unqualified account-wide 100%.
  Daemon polling now derives demand only from each enabled subject's primary
  refreshable source, ignores stale reactive evidence as a trigger, runs the
  three top-level refreshers concurrently, and applies completion-anchored
  single-flight exponential pacing after partial or absent observations. A
  credential-generation fence retires an older provider cycle before it can
  restore a removed account or satisfy a post-login refresh with the old
  credential; post-change callers coalesce into one current-generation cycle.
  Large compacted journals reopen and compact iteratively instead of passing
  roughly 176,000 records as JavaScript call arguments, fixing the 3.3.13
  machine-wide startup failure. Browser media uses a marker-owned per-run child
  so a pre-existing `.claudexor-artifacts` root and unrelated same-basename
  paths are captured and preserved. Crash recovery persists the envelope id and
  workspace mode, so startup cleanup removes that same marked child from an
  in-place project without touching the shared root or user siblings. The
  release also pins the ACP/daemon typed
  inline-secret refusals and removes wall-clock timing from the reported macOS
  replay-order test.
- **v3.3.13** (2026-08-08) — dev-hygiene follow-up. The packaged macOS app
  bundle and the DMG staging directory now build into
  `apps/macos/dist/bundle.noindex/`, which Spotlight does not index, so local
  release builds across many worktrees no longer flood Launchpad and search
  with duplicate Claudexor icons; the DMG/ZIP outputs and the release
  byte-promotion contract remain on their existing `apps/macos/dist/` paths.
  A source-built dev app (version "dev") no longer presents the automatic
  "Update available" chip it used to recompute from the shared
  `~/.claudexor/runtime/current.json` pointer; it shows an honest dev-build
  status instead, and the manual Check for Updates flow is unchanged.
  `claudexor gc` can now report top-level entries of the Claudexor data root
  that the engine does not own, as an opt-in advisory on the receipt
  (`data_root_unrecognized`): the CLI requests it only from a same-version
  daemon, so both skew directions keep their exact pre-3.3.13 shapes; the
  scan flags wrong-kind/symlink anomalies, never deletes anything, and scan
  failures land in the existing `errors[]`. Confinement policy-shape
  contradictions (a carve-out that would swallow a denied path) are now
  refused before the platform-availability probe, identically on every OS —
  this was latent on Linux since v3.3.7 and kept CI red; the fix restored the
  green matrix.
- **v3.3.12** (2026-08-08) — an eight-issue fix batch on top of 3.3.11.
  Harness stderr is no longer discarded on clean exits: the shared CLI run
  loop attaches a bounded, redacted `stderr_tail` to the terminal completed
  payload on every exit path (zero exit and abort included; previously
  nonzero-exit only), reaching the raw attempt-event channel (events.jsonl /
  SSE / `--json-stream`) whenever the stream is drained to completion; an
  orchestrator-side abort that stops consuming before the terminal event does
  not persist the tail (bounded residue, ledgered). Raw diagnostics only: no
  timeline/CLI surfacing, no severity classification, no schema field (#120).
  Artifact listings and the review-findings projection now tolerate
  concurrent tree mutation (a vanished entry/directory yields a partial
  snapshot instead of a 500), and `.git` entries are never enumerated in
  listings — they remain fetchable by explicit path (#128). The harness
  inactivity watchdog default (`runtime.harness_inactivity_timeout_ms`) is
  raised from 20 to 60 minutes: long silent reasoning stretches (codex exec
  has no delta transport; racing/agent claude lanes are delta-free by design)
  were killed as false-positive hangs. The issue asked to raise the default
  for reasoning tiers; what ships is a flat bump for every tier — per-effort
  scaling was investigated and rejected because explicit-vs-default
  provenance is lost at config parse. Tradeoff: a genuinely wedged CLI now
  parks up to 60 minutes before its typed timeout. The new default applies
  only to configs without an explicit value — an existing persisted `1200000`
  is never migrated; to adopt the new value, edit
  `runtime.harness_inactivity_timeout_ms` in `~/.claudexor/v3/config.yaml` or
  set `CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS` (#129). A daemon that refuses
  the control-protocol handshake now surfaces the server's typed
  `incompatible_protocol_major` problem with the `claudexor daemon stop`
  remedy instead of the misleading "control API is not reachable
  (CLAUDEXOR_NO_CONTROL_API=1)" timeout — and the remedy shows on the
  terminal, not only in the machine envelope; read-only lookups no longer
  report a live incompatible daemon as "not running"/"no such run";
  `claudexor follow` reports typed daemon problems through the canonical
  failure envelope instead of a flattened one-liner; a corrupt
  `control-api.json` pointer is reported loudly with its path instead of
  reading as "daemon not running"; and when a same-major daemon/CLI version
  skew was observed on the connection, every typed daemon failure
  (`config_invalid` included) additionally carries `context.engineSkew`
  {daemonVersion, daemonSha?, cliVersion} plus the stop remedy in
  requiredActions (#93). Write-mode Git auto-initialization refuses
  implausible roots (INV-075 exception): a root equal to the user home
  directory or a filesystem root — or one that cannot be classified (no safe
  home resolves, or the root itself does not physically resolve; both fail
  closed) — is refused with the typed `git_boundary_root_refused` error
  before any mutation, carrying cause-specific required actions: the home
  and filesystem-root refusals offer a project subfolder or a self-run
  `git init` plus a first commit, while an unclassifiable root names its
  classification failure and its own remedy; both operands are classified
  on their physical resolution, so a symlinked spelling of the home cannot
  slip past the guard and a home that fails to resolve physically refuses
  fail-closed; a home that is already a healthy repository (dotfiles
  users) is respected untouched, and ordinary non-git roots keep the
  announced auto-init (#130). Route classification consumes the frozen
  admission route first and the RESOLVED per-harness auth preference after
  it, instead of the raw request field, so the documented config-level
  `auth_preference: api_key` workaround is reliable (the reporter's
  degraded-key + native-cooldown pool survives and spawns with the api_key
  preference). Deliberate visibility change: a config-level API key with a
  passing smoke now honestly classifies as metered billing, so
  `paid_fallback: never` excludes that lane — matching run-level
  `--auth api_key` semantics (#121, part 1). macOS: storing an OpenRouter key
  works end-to-end — the auth sheet maps openrouter to its managed secret
  slot and both API-key readiness mappings — and the Store-key control for
  every key family (opencode, raw, openrouter) visibly disables with a
  cause-specific hover (engine offline / action in flight / empty key field)
  instead of silently doing nothing. After storing an API key the harness
  honestly reports degraded — key present but route unproven — because the
  raw-api doctor never spends paid calls to verify it; the harness card now
  reflects that state immediately after the store, and the sheet's footer
  offers Retry check (not Done) to run a real fresh probe (#132). The agent
  convergence-preflight refusal's remediation is honest: it now says
  "Configure reviewers from a second provider family and check
  `claudexor doctor` for reviewer readiness" instead of advising a
  nonexistent knob; the machine-matched first sentence is unchanged
  (#133, part c).
- **v3.3.11** (2026-08-07): typed model-aware availability on `/v2/quota`.
  A downstream consumer buried a whole healthy claude route because a
  `claude_oauth_usage` snapshot carried a spent model-scoped window
  (`weekly_scoped:Fable`, `applies_to_models: ["fable","claude-fable-5",
  "best"]`, `used_ratio: 1.0`) and the consumer's own aggregation read "any
  spent constraint" as "profile dead". Each snapshot in the `/v2/quota`
  response now carries a derived `availability` projection — `state`
  (`available`/`exhausted`/`cooldown`), `blocking_constraints`, earliest
  known `resets_at`, and `model_scoped_exhaustions` — so consumers no longer
  invent constraint aggregation. Only windows applying to EVERY model can
  set `exhausted`/`cooldown`; a model-scoped spent window keeps the subject
  available and is disclosed separately. `POST /v2/quota` accepts an
  optional `{"model": …}` body (case-insensitive alias containment in either
  direction) to compute `state` against the model the caller intends to
  spend; blocking semantics mirror the router's `BudgetLedger` (a spent
  ratio whose reset elapsed or is unknown is stale data, not a live block).
  Purely additive: the projection is applied at the response boundary, so
  journals, projection signatures, raw embedded snapshots, and absences are
  byte-identical.
- **v3.3.10** (2026-08-07): Windows secret-store durability fix, discovered
  by both live API-key lanes in the downstream 3-OS Ouroboros gate against
  public 3.3.9. The Windows fixture lane passed runtime installation, daemon
  boot, and the `git.exe` capability probe because it does not set a secret;
  each live lane instead failed immediately after `claudexor secrets set`
  with `EPERM: operation not permitted, fsync`. `SecretStore.writeFileStore`
  kept its own direct directory-handle open/fsync/close sequence, bypassing
  the shared `fsyncDirectory` durability owner whose win32-only tolerance
  already handles that directory-handle refusal. The store now delegates its
  post-rename directory flush to the shared helper. The temporary file's
  descriptor-level fsync before rename, atomic replacement, 0600 file mode,
  and non-win32 error behavior are unchanged. A package audit found no other
  direct directory-fd fsync duplicate outside `@claudexor/util`. The same
  bounded Windows live-path review found two regular-file durability checks
  reopening an already-written temp read-only (`runFacts`, `ResourceStore`);
  those handles are now opened read/write because Windows FlushFileBuffers
  rejects read-only file handles, without changing file content or POSIX
  ordering.
- **v3.3.9** (2026-08-06): the next Windows-parity layer, one deeper than
  3.3.8. With the daemon booting on Windows, the downstream 3-OS platform
  gate's fixture lane died at the Git capability probe with `git_missing`:
  `resolveGitExecutable` walked the engine PATH probing `<dir>/git` with no
  extension, and Windows has no extensionless `git` — every real
  distribution (Git for Windows, Scoop/Chocolatey shims) ships `git.exe` —
  so the probe could never succeed there. The resolver now probes
  platform-shaped candidate names (`git.exe` on win32, the bare name
  elsewhere; deliberately not a general PATHEXT walk — `git.cmd` died with
  msysgit 1.x and Node's execFile refuses `.cmd` without a shell), with the
  platform injectable so both branches are unit-proven without a Windows
  host. This repairs every consumer of the shared probe at its single root:
  request preflight, run applicability, readiness/doctor capabilities,
  control services, and accounts services. An audit of the rest of the
  code the fixture lane reaches (handshake, project registration, fake-run
  lifecycle, artifact read, identity-bound `--stop`) found no further
  win32-fatal pattern of the 3.3.7/3.3.8 classes: the harness binary
  resolver already carries PATHEXT candidates, direct `git` spawns resolve
  `git.exe` through libuv's own PATH search, the directory
  fchmod/fsync tolerance from 3.3.8 owns both directory-handle mutations,
  path-prefix guards on this lane use `path.sep`, and the `ps`-based
  envelope-owner start-time identity degrades to a declared bounded
  freshness keep rather than a failure.
- **v3.3.8** (2026-08-06): Windows daemon boot fix. Establishing a
  daemon-owned private directory (`ensureCanonicalPrivateDirectory`) applied
  `fchmod(fd, 0o700)` unconditionally, and win32 has no POSIX mode bits on
  directories (directory access there is governed by ACLs; the READONLY
  attribute that fchmod maps onto is not honored on directories), so the
  descriptor-level chmod failed with `EPERM: operation not permitted, fchmod`
  and `claudexord` could not boot on Windows — found by the downstream 3-OS
  platform gate against the published 3.3.7 bytes. The directory chmod now
  carries the same attempt-first win32 tolerance as the directory-handle
  flush in the same module (injectable `platform`, refusal forgiven only on
  win32); the inode/pathname identity proofs before the mutation are
  unchanged on every platform, and the file-level `fchmod(fd, 0o600)` writers
  (daemon token, journal, recovery files, login sidecars) are untouched —
  on win32 those map to clearing the READONLY attribute on a file handle,
  which succeeds.
- **v3.3.7** (2026-08-06): the Ouroboros-integration line, rebased onto the
  3.2.1 release. The `CLAUDEXOR_CLAUDE_NATIVE_DIR`/`CLAUDEXOR_CODEX_NATIVE_HOME`
  override guards now confine to the Claudexor-owned root (`~/.claudexor`)
  instead of the narrower config root, so pointing a run at a registered
  credential-profile store under `~/.claudexor/profiles/…` works instead of
  hard-erroring. Durable idempotency digests are now computed over a
  wire-stable projection: the parse-injected `execution.delegated: false` /
  project `scope.ephemeral: false` defaults (both new in this line) are elided
  before hashing, so replaying an accepted request's Idempotency-Key across an
  upgrade from 3.2.1 or 3.3.7-rc.0 returns the original handle instead of a
  spurious `idempotency_conflict`. A failed terminal login's durable failure
  tail now also drops every URL query string before persisting (host+path
  stay): an OAuth authorization URL's `state`/`code_challenge`/`user_code`
  values ride only the transient disclosure sidecar, never runner-result.json
  or the journaled job message. The `auth_revoked` snapshot retirement
  appends its durable REMOVED record before mutating the live projection
  (matching the upsert and explicit-removal paths), so an append failure can
  no longer leave a restart resurrecting a vendor-revoked window. The release
  now ships a relocatable managed runtime closure
  (`claudexor-runtime-<version>.tar.gz`): the same single engine closure the
  in-app updater installs also materializes internal package links into a
  regular-file/directory-only archive, so a host application can embed the
  exact-pinned runtime without a second payload or trust root. Credential
  profiles gained named Cursor accounts: a cursor `config_dir_login` profile
  selects the CLI's vendor file credential store inside a Claudexor-owned
  profile HOME, the default login keeps the OS Keychain untouched, and a
  logged-out or out-of-tree profile is a typed refusal before any child
  spawns. The owner-review release gate moved to transport v6 (protocol
  `cursor-operator-fable-sol-v1`, owner decision 2026-08-06): the formal
  reviewer pair executes as Cursor operator subagents (one `fable` and one
  `sol` slot, each restricted to its owner-approved tier set, both on the
  full context), each slot sealing a markdown report plus exact-shape
  operator-attested metadata (model slug, genuinely overlapping ISO
  intervals, `pass|warn` verdict, mandatory `review_scope: "full"`, report
  SHA-256); the native-harness schema-v5 sol-delta protocol
  (`native-fable-full-sol-delta-v2`) joined v2-v4 as
  archive-signature-only. Claude and cursor logins no longer
  open a Terminal window: both run as daemon-hosted detached runners
  (`url_disclosure` for cursor with `NO_OPEN_BROWSER=1` — its login
  self-completes by server-side polling from any browser; `url_disclosure_with_input`
  for claude — the card shows the captured sign-in link plus a one-shot paste
  field delivered to the vendor CLI's stdin via the new
  `POST /v2/setup/jobs/:id/input` route and a transient never-journaled
  `runner-input.json` sidecar), which also makes claude/cursor login work on
  Linux for the first time; the legacy Terminal handoff remains only for the
  codex `browser_redirect` fallback. Login verification gained a bounded
  post-deadline grace re-probe: a vendor credential flush landing moments
  after the 30s deadline now verifies as the success it is instead of
  reporting "Login failed" against a completed sign-in, and the timeout
  message now says the sign-in itself may have succeeded. Claudexor's control endpoint now resolves on Windows:
  `defaultSocketPath()` gained a `win32` branch returning the named pipe
  `\\.\pipe\claudexord-<digest16>` that Node IPC actually requires there,
  where it previously always built a Unix-style `.sock` path that could not be
  bound — the digest of the daemon dir keeps concurrent daemons with distinct
  `CLAUDEXOR_CONFIG_DIR`s on distinct endpoints, and the `CLAUDEXOR_DAEMON_SOCK`
  override is unchanged. Downstream platform gates that assert a per-platform
  endpoint depend on this branch existing. Alongside it the cancel path stops
  lying on Windows: `resolveKillTreeStrategy` names its mechanism once
  (`posix_process_group` everywhere, `windows_taskkill` on win32), the win32 leg
  issues one pinned `taskkill /T /F` while the root still probes alive, and
  because no group probe can prove whole-tree death there the outcome is the
  typed unconfirmed reason rather than a false CONFIRMED. A readonly cursor run
  is now genuinely read-only — it dispatches onto `--mode ask`, the only mode
  that CLI documents as withholding the write tools (under the previous argv a
  readonly agent created a file on instruction), and the manifest stops claiming
  `fs_sandbox` for a mechanism that is really a tool allowlist. Disclosed with
  it, because it is a real narrowing and not only a fix: ask mode withholds
  COMMAND EXECUTION as well as edits. The vendor's own mode roster in the pinned
  CLI build calls it "Q&A mode - no edits or command execution", so a readonly
  cursor run can no longer run a shell command it could run before — it now
  matches the claude adapter, whose readonly allowlist has always excluded
  `Bash`, while a readonly codex run still gets commands under a read-only
  filesystem. Confinement proof
  gained the control it was missing: `proveConfinementDenial` credited nearly
  every nonzero exit as a proven denial, so a Seatbelt profile that failed to
  apply or failed to compile recorded a `verified_denied_path` that proved
  nothing; a positive control (an allow-listed own root must stay readable under
  the sandbox) plus launch-fault discrimination on stderr now separate a real
  deny from a launcher failure. Delegated mutating runs became routable on the
  cursor and opencode adapters, which refused `external_sandbox_full` — the
  profile that tells the adapter to stand its weaker sandbox down; the engine
  applies and proves its own OS boundary on the delegated path (requested
  directly the profile carries no engine boundary and runs unrestricted) —
  while bare `full`, which claims no boundary at all, is still refused. The release itself now reaches the channel
  it is consumed on: publishing moved only `latest`, and nothing in the repo had
  ever moved `next`, so `claudexor@next` stayed stranded on 3.3.7-rc.0 while
  stable releases came and went; the publisher now moves `next` to the published
  version after the signature audit, and the workflow gate fails if that move is
  ever dropped. An attempt that died before its harness HOME was decided no
  longer reports `harness_home_isolated: false` — a positive claim that the
  engine ran the child in the operator's own home — and instead omits the field,
  so a gap in the record reads as a gap. Finally, a claude/cursor terminal login
  discloses its OAuth URL as a structural field on the login job instead of only
  printing it into the PTY, so a surface without a terminal has something to
  render.

- **v3.3.6** (2026-08-03): a delegated MUTATING run now works on Linux and
  Windows instead of failing closed there. 3.3.2 could only complete such a run
  on macOS: `applyConfinement` threw on every other platform and the terminal
  evidence gate refused any attempt that carried no proven boundary, so
  `execution.delegated` was a macOS-only feature wearing a general name. macOS
  keeps its Seatbelt boundary, applied and PROVEN against a path it denies before
  the harness spawns. Every other platform gets, by decision, no kernel boundary
  at all — the scoped harness `HOME` as before, no mechanism recorded, and the
  absence disclosed in three places: the attempt record
  (`confinement_unavailable_reason`), the child's own prompt, and the caller's
  run detail (`candidates[].confinement`). A mechanism is never named without the
  path it was proven to deny: the schema makes the pair inseparable, one owner
  answers "is there really a boundary", the mechanism identifier is opaque, and
  nothing branches on the platform. The terminal gate now separates MISSING
  evidence (still a refusal — an attempt that cannot say what it ran under is
  unauditable) from evidence that honestly states there was no boundary
  (complete, terminalizes normally). Finally, a delegated lane is told to stand
  its own sandbox down only where Claudexor will actually replace it — the
  `external_sandbox_full` escalation was unconditional and would have stripped a
  harness's native sandbox on hosts that got nothing in return.

- **v3.3.2** (2026-08-03): a delegated MUTATING run is now confined by an
  OS-enforced filesystem boundary, not by a convention. The scoped harness
  `HOME` 3.3.0 introduced redirects `~`-relative lookups and nothing else — a
  live `workspace_write` agent run read `~/.claudexor/v3/daemon/token`, a bearer
  for the whole control API, straight off its absolute path. Such an attempt now
  starts inside a macOS Seatbelt profile that denies the Claudexor runtime tree
  and the operator's credential stores (derived from the sensitive-resource
  owner, never re-listed), applied at the ONE shared CLI spawn seam so no adapter
  can forget it, and PROVEN against a path it denies before the harness runs.
  Because macOS refuses a nested sandbox, the engine states the existing
  `external_sandbox_full` access profile so the harness stands its own down — an
  access profile, never a harness-name branch. Every attempt records what it
  actually ran under (HOME, access, credential profile, boundary digest and
  verified denied path) on the success AND failure paths, a delegated mutating
  terminal without that proof refuses, and the three confinement refusals are
  typed `RunFailureCode`s instead of being flattened to `code: null`. What the
  boundary does not cover is written down in `docs/DELEGATED_CONFINEMENT.md`.

- **v3.3.1** (2026-08-03): three surfaces that the 3.3.0 batch changed on one
  branch and left untouched on its twin. Thread worktree recovery deregisters
  only the one lost registration instead of running the repo-wide
  `git worktree prune` against the user's project — the exact harm
  `worktreePrune` was gated for, from the one caller that still bypassed it.
  The vendor-verification overlay now runs at RUN ADMISSION and rotation
  readiness, not only in the Accounts listing, so a profile the vendor already
  rejected (`auth_revoked`) is refused before spawn instead of being dispatched
  into while the Accounts card calls it revoked. And `scope.ephemeral` is
  honored on `POST /threads` as it already was on `POST /runs`: a declared
  one-shot root is no longer silently entered into the durable project
  registry, which is what the field's own description promises.

- **v3.3.0** (2026-08-03): preconditions for an external orchestrator driving
  Claudexor runs. `RunScope.ephemeral` declares a one-shot project root — it
  anchors a single run, never enters the durable project registry, and its
  commands and run events live in the global no-project partition, so a host
  that hands Claudexor a disposable worktree per subagent stops filling the
  registry with entries that are dead on arrival. `RunExecution.delegated`
  marks a run driven by a machine orchestrator rather than an operator at a
  surface: every attempt is confined to a scoped harness HOME even under
  `isolation: "live"`, the run refuses rather than degrades when that home is
  absent, and the applied isolation is recorded on the attempt so the caller
  verifies confinement instead of trusting it. Credential-profile readiness
  discloses `verification_source`, separating "this profile's material is
  present locally" from "the vendor answered a request made with this
  profile's credential"; a vendor 401/403 on a subject's own token becomes the
  typed quota absence `auth_revoked` instead of an undiagnosed refresh
  failure. A spent subscription window is refused typed end to end —
  `subscription_window_exhausted` with a structural `RunFailure.resetsAt`,
  carried out of a candidate attempt's catch onto the run terminal only when
  every candidate died of the same refusal — so a scheduler reads a field
  instead of parsing the message. `worktreePrune` no longer deregisters
  worktrees Claudexor does not own. Internally, `RunFailure` moves to
  `control-run-failure.ts` and the thread continuity-context builder to
  `thread-continuity-context.ts`, keeping both tracked files under the
  readability ratchet and putting the continuity filters under test.

- **v3.2.1** (2026-08-03): a focused macOS plan-answer and diagnostics repair,
  based on reports from Walter Siamruk (#102–#108). Composer-selected models,
  effort, and auth route now reach turns started from plan cards; Implement plan
  names and binds its Agent write scope; multi-harness non-race runs no longer
  claim a Best-of result; and an unpinned account has one stable Automatic
  identity. Plan option chips are suggestions, including on saved 3.2.0 runs;
  every required answer has visible state, card text is selectable, and a
  durable typed relation restores the exact submitted receipt after reload
  while preventing duplicate turns. Diagnostics can copy the full run id or a
  directly runnable bundled/remote inspect command. CI now executes the
  ClaudexorApp tests (#91). GitHub Actions move to checkout 7.0.1,
  pnpm/action-setup 6.0.9, and download-artifact 8.0.1; the one Node 20 timer
  fixture exposed during refresh now uses deterministic fake time. The repaired
  real-harness battery (#94) can use existing authenticated sessions in a
  disposable VM without relocating or copying credentials, refuses a live
  daemon, forces and digests the exact source build, binds cleanup to the daemon
  it started, leaves the default config byte-identical, revokes temporary trust,
  scans every durable route interval, and fails acceptance on any FAIL, ENV, or
  SKIP. API fallback disclosure before process start no longer creates a
  fictitious unpaid interval and incorrectly ends an exact paid run as
  `cost_unverifiable`. The macOS app now treats the terminal review axis as the
  decision authority, so advisory findings cannot show `Needs you` controls
  beside an approved, already-applied winner; failed final checks retain their
  server-authorized risk-decision path, and remote sync times stay English under
  non-English host locales. Claude advisory quota warnings no longer cool a
  healthy account, model-scoped Fable limits no longer block explicit Opus
  routes or a viable vendor-native default, typed Opus/Sonnet rejections retain
  their model scope, fallback and budget-downgrade attempts preflight the model
  they actually run, and opt-in account rotation selects a ready profile before
  the exhausted default can be filtered out. Model-scoped quota stays durable
  across current-engine restarts without breaking the supported updater
  rollback: 3.2.0 can replay the compatible base record while current engines
  restore the exact typed scope from its atomically journaled prepare/base pair.
  The real-harness battery now proves its expected convergence refusal from the
  canonical failure instead of incidental review fields.

- **v3.2.0** (2026-07-29) — an eight-pull-request batch: remote execution, a
  canonical run receipt, and the toolchain moved forward. Remote SSH
  execution (#82, kazzand): a thread can bind to a concrete `~/.ssh/config`
  host, where the app delegates transport and auth to the system
  `/usr/bin/ssh` (interactive auth runs in an ephemeral SwiftTerm PTY and
  nothing is persisted) and installs a signed remote runtime — an Ed25519
  `kind`-separated manifest binds four platform archives with pinned Node
  digests, atomic activate/rollback, no sudo — then drives the complete
  engine through a loopback SSH forward with location-tagged threads, remote
  setup and login, log tails, and preview forwarding. Remote browsing lists
  only visible home-contained directories and refuses every other path with
  one constant answer; remote markdown images ride a registered-project
  endpoint that identifies raster images by magic bytes and refuses anything
  else before reading its content; both remote endpoints are wired only into
  the remote runtime, so a local daemon answers 501. The release pipeline
  builds, attests, SBOMs, and publishes the four remote-runtime archives, the
  signed remote manifest, and the remote SBOM as first-class assets (inside the
  12-asset candidate allowlist; publish adds the review attestation as the
  thirteenth final asset, with provenance verified before any use). Runtime
  activation is admission-safe across local install, steady
  reconciliation, remote install, and rollback: the daemon atomically proves
  run/setup idleness and fences every ingress before stopping, while a late
  busy or unknown result leaves the serving process and runtime pointer intact.
  Canonical RunFacts receipt (GH #29, Alex Basis): every terminal run seals its
  outcome into one immutable, invariant-validated object built once from
  canonical artifacts, embedded in the terminal journal event, persisted as
  `final/run_facts.yaml`, and served verbatim by the control API, terminal
  CLI JSON/NDJSON, and `claudexor inspect` through one shared validation
  owner. Fail-loud throughout: a present-but-invalid receipt is a typed
  `run_facts_invalid` failure on every surface, a corrupted canonical
  artifact or malformed review finding fails the terminal instead of
  projecting "not configured", and restart reconciliation neither re-reads
  evidence for settled terminals nor poisons a partition whose run directory
  retention legitimately reclaimed. The checks axis now covers ALL
  deterministic checks, so a refused delivery or failed fresh verify blocks a
  zero-gate run exactly like a gated one; the reviewer NEEDS_HUMAN gate is
  winner-only and fail-closed; a zero-byte deliverable is never reported
  present. Cursor model pickers are bounded by a shared layout token and one
  truncated-label owner, so a long vendor catalog can no longer widen the
  composer or Settings menus (GH #53, Alex Basis). The Claude manifest pins
  `claude-opus-5` and `claude-opus-4-5` against the verified CLI (#54,
  ndrew1337). The release also ships a carried-over changeset: portable Agent
  Skill and GitHub Copilot plugin artifacts, official MCP Registry
  distribution metadata, experimental ACP Terminal Auth for Codex, and
  repository-configured protected path gates.
  Settings → Connections can create an SSH host without leaving the app: a
  `New SSH Host…` sheet (replacing the short-lived disclosure whose label was
  inert — only the chevron toggled) with live field-local validation, a
  writer-rendered "Will append to ~/.ssh/config" preview that is byte-identical
  to the actual append, and a one-step `Create & Add` that writes the block,
  rescans, and adds the connection, leaving a dismissible receipt naming the
  config and backup paths (a freshly created config honestly reports that no
  backup existed) and surfacing a written-but-not-added partial outcome. The
  config scan is typed — missing config, no concrete aliases, all aliases
  already added, and scan failed each get their own picker copy instead of one
  silent empty list. The dead-label disclosure class is fixed app-wide by a
  shared `DisclosureRow` (whole-header button, rotating chevron, hover and
  keyboard/VoiceOver support) adopted by every Advanced disclosure, the
  Workspace Evidence rows, and the diff file headers; Connections also adopts
  the shared `SettingsGroup` shell, `AlignedListRow` row headers, and the
  documented status ladder (Connecting/Installing accent, Needs authentication
  caution, Failed danger).
  The remote harness installer returns from the PR #82 cut as a disclosed,
  exact-pinned flow (issue #89): a `claudexor harness install
  <claude|codex|cursor|opencode>` CLI verb plus a Settings → Harnesses entry
  point for connected hosts. Claude, Codex, and OpenCode install one exact
  npm version aliased from each harness package's vendor-version SSOT (never
  `@latest`; npm verifies the registry integrity checksum; the OpenCode pin
  is a deterministic install target with no recorded verification fixture).
  Cursor cannot be pinned and is not pretended to be: its vendor script is
  downloaded in full (never piped to a shell), its size and SHA-256 print,
  and it runs in the visible embedded terminal where the operator watches
  it. Nothing executes before disclosure — the CLI prints the exact command
  and destination and requires a TTY confirmation or `--yes`, and the macOS
  dialog shows the remote CLI's own `--dry-run --json` disclosure verbatim
  before opening the terminal sheet; Harness Doctor verifies the result
  afterward.
  Dogfood hardening closes the shared contract gaps found across Plan, Agent,
  Settings, long-running research, terminal output, and refused turns. Plan can
  receive read-only attachments but never Agent-only reviewer or protected-path
  controls; engine-side attachment admission now has one pool resolver, while
  Swift composer strategy and pool mirrors are parity-checked against an
  engine-generated fixture. Settings autosave is location- and
  lane-scoped, failed initial loads never become editable defaults, and the
  interaction wait offers either a positive duration or no automatic expiry.
  Extended remote login jobs remain attachable after their original deadline:
  the mutable journal deadline authorizes a fresh, bounded client-PTY permit
  without rewriting the sealed runner manifest. Setup continuations stay bound
  to the server-owned account even when opened from another account's sheet,
  and transient device codes disappear as soon as an authoritative frame or
  terminal connection state withdraws them.
  Deep Research resets inactivity only for genuine agent progress, while typed
  refusals, Git readiness, retry remedies, terminal output, and final RunFacts
  retain the same durable reason across UI, CLI, API, MCP, and ACP. Successful
  run-detail responses are schema-checked, degraded MCP/ACP errors are redacted,
  and auth-route summaries retain the deciding credential profile.
  Concurrency and upgrade paths are hardened at their owning boundaries. Remote
  setup, install, project, preview, directory, and terminal actions carry exact
  generation-scoped leases; runtime activation commits only after the tunneled
  handshake identifies the lease-owned candidate and exact pointer, while every
  reconnect binds bootstrap, tunneled engine, and final pointer identity before
  publication. Failed activation still rolls back through the same opaque lease.
  The packaged app probes the selected local daemon closure and reconciles exact
  version plus build identity before hydrating state, deferring safely while
  work is active. A failed or unreachable post-swap relaunch now restores and
  proves the prior exact runtime through the same admission-safe stop instead of
  leaving an unverified candidate pointer active. Idempotent thread recovery
  returns an already accepted command, but refuses a historical runless orphan
  after the conversation advances; Exact Retry also preserves the implemented
  plan hash and readiness override, and recorded risk-decision replays precede a
  later turn's idle gate.
  Both local-update and remote-runtime manifests reject unsigned extension
  fields in every JS, TypeScript, and Swift verifier;
  installer children receive no provider secrets, and offline signing keys are
  read only from same-user, non-symlinked 0600 files.
  Accounts and Settings share explicit location-scoped loading truth. File and
  screenshot attachments are admitted from an opened regular-file descriptor
  before a bounded read, reject same-size replacement or in-place mutation,
  revalidate on publication, and retire on an explicit conversation switch.
  TTY choice prompts accept only the complete numeric grammar they advertise,
  so numeric-prefixed prose and multiple picks for a single-choice question are
  preserved as prose. Native reviewer workspaces now project only Git-visible
  candidate files plus exact diff postimages; unrelated ignored local state
  stays outside the separately copied evidence plane. Formal release review is
  now one native full-context pair on the complete frozen repository: Claude
  Code Fable/max and Codex sol/xhigh share the same manifest-bound evidence,
  owner dialogue, complete diff, tests, and internet access. Schema-v5 sealing
  derives both verdicts from candidate-built Claudexor artifacts and binds their
  observed routes, prompts, transcripts, normalized events, and runtime
  identity to the exact full-gate receipt. Frozen reviewers now force live web
  context, run without hidden transient retries, record distinct overlapping
  sessions, and seal transcripts re-derived from normalized events. Sealed
  completions accept exactly one JSON value, with no surrounding prose or
  duplicate envelope. The full gate emits a small candidate verifier plus the
  packaged CLI, binds both byte digests and its real stdout/stderr logs into the
  receipt, and the sealer revalidates those receipt-owned bytes. The packet-split OpenRouter panel, coverage
  checker, and old broad runtime bundle are deleted rather than kept as
  competing or fallback release paths; schemas 2-4 remain archive-verifiable
  but cannot publish a new release.
  These dogfood repairs landed after the lockstep 3.2.0 versioning commit but
  before the first public 3.2.0 publication. The affected package changelogs
  therefore absorb them into their existing 3.2.0 sections; there is no second
  changeset or semver bump.
  Toolchain: `@modelcontextprotocol/server` 2.0.0 GA with the
  2026-07-28 discover envelope pinned by regression, TypeScript 7.0.2 with a
  sidecar for the one compiler-API consumer, and zod 4.4.3 with the schema
  package bridged through the `zod/v3` subpath so all generated JSON Schema
  stays byte-identical.

- **v3.1.2** (2026-07-26) — Delegate recovery patch. Packaged macOS and npm
  installs now expose the six-tool delegation belt through the exact daemon
  self-entry instead of failing because a neighboring `cli.js` is absent.
  Claude Code and Codex treat the injected MCP server as required: a known
  pre-start incompatibility continues as ordinary Agent only with a durable,
  visible requested/effective/used/reason/remediation receipt, while failure
  after injection is terminal. Parent and child runs share one daemon-owned
  budget, depth/count admission, cancellation, and drain barrier; late child
  spend can no longer escape the parent's terminal decision. Control API, CLI,
  and macOS preserve typed Delegate lineage, degradation warnings, failure
  reasons, child ordering, and reconnect/reload truth without confusing native
  vendor subagents for Claudexor children. Child questions stay answerable
  inline through their canonical run id, and signed candidate probes tolerate
  macOS canonical temporary-path aliases without weakening the entry fence.
  Cursor Plan uses the native read-only Ask final-message channel so its
  model-authored WorkReport cannot be lost behind the native `createPlan`
  terminal tool.

- **v3.1.1** (2026-07-25) — patch release: engine honesty, per-model effort
  ladders, and control-plane fixes on top of v3.1.0. Engine: a DELIVERED plan
  now survives an unrecovered tool error — the planner no longer escalates a
  finished deliverable to a harness error before the finalizer runs, so one
  failing shell command cannot throw away a good plan; an empty thrown message
  no longer reads as "no error", so a harness that threw can never terminalize
  as a clean success; the grep-family exit-1 carve-out and secret-redaction
  mirroring keep tool-error accounting truthful; and the automatic
  economy-ranking pass reads ONE pinned clock instead of a fresh `Date.now()`
  per candidate, so ranking is stable within a pass. Effort: the ladder is per
  (harness, model) and follows the vendor-advertised order — the static rank
  table is gone, levels are discovered live from each CLI (Claude `--effort`
  help parsing reads the whole block and anchors on the enumerating
  parenthesis; Codex discovery is keyed by the resolved `CODEX_HOME`, bounded,
  refuses malformed model/list values, and settles its probe on close) with a
  version-matched snapshot fallback; the full official vocabularies are
  supported (+minimal/+ultra in the schema vocabulary, codex +max/+ultra,
  claude +xhigh); a level the run cannot honor is disclosed instead of
  silently clamped, a profile-scoped run is no longer held to the DEFAULT
  account's ladder, hint-less runs resolve against the default model's own
  ladder, and the macOS composer's effort menu narrows to the per-turn (or
  persisted default) model's actual surface. Control plane: exact retry on a
  run that never started answers with its typed refusal (a 403, not a 202
  handle), and CLI retry/run-again read the refusal's real problem message
  instead of an `error` field the daemon never serves. Review: both loop
  prompts pin the finding contract explicitly, and a reviewer effort the
  selected reviewer does not advertise is refused rather than silently
  remapped. Portable discovery and distribution (#75): project protected
  paths are back as canonical repo-relative globs in the versioned
  `.claudexor/config.yaml` — a mutating turn on a live project thread with
  configured protected paths first promotes the thread ONE-WAY to its
  persistent isolated worktree, so the run and patch complete without
  touching the project tree and only the typed thread Apply decision can
  deliver the change (`--allow-protected-path` cannot suppress project
  rules; direct one-shot `--in-place` agent runs refuse and name the
  isolation remedy); a portable GitHub Copilot plugin ships in-repo
  (`plugins/copilot`: one Agent Skill plus `.mcp.json` wiring over the
  preinstalled `claudexor` CLI) — Copilot owns its install/update lifecycle
  (it is NOT a fifth managed host), macOS/Linux with Node 20.19+ only (no
  Windows), the Skill starts doctor-backed and read-only, and MCP still
  never exposes patch application; official MCP Registry publication
  metadata lands (`server.json` bound to the executable npm package and its
  exact version, release-parity checked) with publication only via the
  separate manual tag-bound `publish-mcp.yml` OIDC workflow after the npm
  package and public stable GitHub Release exist; and ACP Terminal Auth is
  added as an EXPERIMENTAL surface — only when a client explicitly
  advertises the experimental terminal-auth capability does Claudexor offer
  Codex subscription login through the client's own terminal (the exact
  allowlisted `claudexor acp serve auth login codex` suffix routed to the
  existing durable device-code login, macOS/Linux); Claude and Cursor are
  not advertised yet, the surface is proactive-only (no `auth_required`
  emission or legacy authenticate request), and cancellation or an
  unsupported device flow exits non-zero without spawning a second
  Terminal. Maintenance: CI publishes the required `build-test` check context
  from the matrix job (PRs no longer sit BLOCKED waiting for a context that
  never arrives), the fast-uri floor is pinned at 3.1.4
  (GHSA-v2hh-gcrm-f6hx), major bumps stay out of the dependabot groups, and
  routine dependency/actions updates landed (knip 6.29.0, prettier 3.9.6,
  turbo 2.10.6, @agentclientprotocol/sdk 1.3.0, attest/pages/artifact
  actions).

- **v3.1.0** (2026-07-24) — a five-phase release: engine truth, machine
  contracts, the macOS app, platform (engine-runtime auto-install + Codex
  login), and release/meta. Engine: a shared typed attempt-finalizer replaces
  the three divergent deliverable predicates (D-16, QA-031) — a clean process
  whose model-authored, schema-validated WorkReport says `needs_input` or
  `incomplete` stays a completed lifecycle with a typed outcome VETO (never
  applyable, never a green "succeeded" banner; CLI exit follows the outcome),
  while a real context-window death is `interrupted/context_capacity_exhausted`
  and can never launder a partial diff into review, adoption, synthesis,
  convergence, plan delivery, or an applyable product. Typed context signals
  ride each adapter (Claude `terminal_reason`/`prompt_too_long` +
  `compact_boundary` + rate-limit events, also fixing QA-015; Codex
  `ContextWindowExceeded` only behind a recorded exec fixture; Cursor stays
  honestly generic), with one-shot automatic continuation for the proven
  Claude refill-exhaustion case (fresh session, count = 1, disclosed as a typed
  `run.continuation` event, denial disclosed too). Deep scan gains a real
  bounded synthesis reducer (a failed merge is honestly labelled a raw scout
  bundle with `synthesisStatus=failed`, #27); a typed transient-failure
  taxonomy at the adapter→orchestrator boundary feeds `transient_failures`,
  retry policy, and `requiredActions`, with auth guidance only on real typed
  auth failures (#31). Delivery is server truth end to end: replaying apply on
  an already-delivered run is a typed idempotent no-op with an `already_applied`
  receipt (#26), accept-risk on a final-verify-null blocked run actually
  unlocks the gate, cancel reaps the descendant process tree with
  kernel-identity proof before the terminal receipt (QA-027), and wall-clock
  deadline / `stuck_no_progress` reasons survive to terminal artifacts
  (QA-041). Routing and budget stop lying: subscription-entitlement billing
  evidence, one traced economy-ranking comparator, a shared budget-denial
  classifier across all modes (QA-050), deep-scan scout admission under
  estimate floors with denied scouts disclosed (QA-019), and
  quality-routing-without-tiers as a typed `config_error` at settings write AND
  preflight (#22 server half). Isolated runs' produced outputs read the run's
  own worktree, never the live project (QA-038); blocked Ask can no longer read
  green (QA-036); malformed `events.jsonl` lines surface a typed incompleteness
  marker (QA-074). AGENTS.md unification (D-14): Codex falls back to CLAUDE.md
  via a stateless config override, and run prep can create a thin
  Claudexor-owned CLAUDE.md importing `@AGENTS.md` (typed event, never
  overwriting a hand-written file — a new enumerated live-tree mutation path,
  CONCEPT-CHANGE INV-113); the generated bridge is excluded from `patch.diff`
  only on byte-equality AND a created-this-run fact, so a candidate editing
  CLAUDE.md is never dropped from the diff. Machine contracts: one central CLI
  result/error projector emits exactly one JSON envelope per command path in
  `--json` mode with a single category→exit-code table, typed codes surviving
  projection, and structured field errors (#28); dropped-on-the-wire
  projections are restored (plan hash + readiness audit, council roster +
  valuation, ignored settings, session profile binding, `nesting[]`,
  `problems[]`, `requiredActions` derived from real blocking findings, #29
  partial); `--harness X` on a singleton pool infers the primary (#34) while a
  multi-harness pool missing its configured primary returns a structured
  ambiguity error (#25); `GET /v2/runs` honors limit/state/cursor, run SSE
  re-checks the cursor before ending, titles truncate grapheme-safe, bodies
  decode strict UTF-8, malformed percent escapes are a typed 400, the operation
  catalog is honest (params, applicability, single-shot uploads,
  idempotency), sensitive dotfile-class artifacts are refused typed before
  bytes are read, and the semantic-text policy covers code/config/text
  extensions with redaction gate-pinned to the Swift set; ACP session load
  replays real history and no-project sessions get a loadable cwd (QA-020/068);
  minimal project remove ships (CLI + DELETE route, typed fences,
  archive-first partition handling); and a new `claudexor about` command (text
  + `--json`) carries author/license/links. macOS: a transcript scroll
  overhaul (D-13 A/B/C/E) removes the nested lazy stack — also closing the
  tool-receipt layout loop that could grow memory into the gigabytes (#23),
  with a bounded-memory regression guard, scoped text selection, and granular
  invalidation (owner-dogfooded PASS without a List migration); theme switching
  no longer jumps the toolbar (#21); GFM tables render as real tables via a
  typed lookahead parser and a bounded non-lazy grid (#24); zero-tier quality
  routing cannot be saved (macOS guard atop the daemon refusal, #22);
  bubbles use a calibrated translucent material with AA-verified contrast in
  both themes and a Reduce Transparency fallback (D-12); an About section +
  standard panel show author, MIT license, links, and real app + engine
  identity including the engine sha (D-11, QA-002); plus an honest-UI cluster
  (running runs never show a terminal "No changes", no duplicated Activity
  answer, per-harness Auto-pool model rows, real model-route queries, absent
  optional API keys are not red failures, draft/project-switch resets, honest
  gallery partial-failure disclosure with Retry, strict UTF-8 artifact
  decoding, path-named diff failures, disclosed offline/lost-engine states) and
  a tracked, hardened external-open handoff directory with a startup sweep
  (QA-062). Codex login (D-17): the primary flow is the app-server typed device
  code — a native AuthSheet shows the one-time code with Copy, Cancel, and
  "Open private sign-in" via an ephemeral browser session (honest wording:
  privacy is requested, not guaranteed by every browser), completion feeds the
  existing doctor/smoke proof, and "Add & log in" is one action; an opt-in
  browser-callback flow and a typed legacy Terminal fallback that the CLI
  actually offers round it out, both CLI entries ride the durable setup job
  with inline code display, and the code is never journaled or logged. Engine
  runtime auto-install (D-2): the app can download, verify, and install an
  engine-runtime update — sha256 + offline Ed25519 signed-manifest verification
  against a dedicated runtime-update key pinned in app + CLI (fail-closed on
  unsigned/unknown-key/tampered), full unpack + re-verify into
  `runtime/versions/<v>`, probe handshake, a busy-gate that refuses while any
  work is active, identity-proven daemon stop, atomic `current.json` swap,
  relaunch + handshake verify, rollback to last-known-good on any failure, and
  a lock-file around the critical section, with the bundled runtime as the
  final fallback; the release side promotes the exact candidate artifact bytes
  (gh attestation verify + byte identity, never a rebuild), binds the archive
  URL into the signed manifest, and stamps a deterministic build-sha for
  bundled and downloaded closures (QA-002's real gap). Review harness and
  release tooling: deterministic full-text reviewer coverage via packet-split
  sub-waves and a coverage checker that BLOCKS the seal unless every
  hand-written changed file's complete bytes reached a reviewer; attestation
  schema v4 (per-sub-wave full triad+scope panels, typed `--slot-record`
  sealing with verdicts re-derived from digest-bound raw report bytes, a
  sealer-verified packet manifest, and a signature-bound coverage receipt,
  CONCEPT-CHANGE INV-125); and machine-derived packet narratives that
  structurally close the stale-narrative failure class. Ships the merged
  community PRs: doctor diagnoses broken installs behind "not found on PATH"
  (#32, Andrei Gritsaev), declared JSON Schema dialects incl. draft 2020-12 in
  structured output (#33, Alex Basis, closes #30), singleton-pool primary
  inference (#34, Alex Basis), and truthful producer telemetry outcomes (#35,
  Alex Basis). Meta: README author links, a daily SHA-pinned repo-metrics
  workflow with honest "total downloads" (npm + an app DMG/ZIP asset allowlist)
  and star-history charts from our own CSV ledger (D-15, a shared collector
  reused by the CLI's release stats — no duplicate fetcher), a GitHub Pages
  landing site + npm discovery improvements (#36/#37), package.json author
  metadata, and `about --json` asserted in the npm install smoke. Deferred to
  `docs/BACKLOG.md`: the full RunFacts projection layer (#29 remainder), the
  visual quality-tier editor (#22 remainder), instruction-transcript hash
  binding (QA-030), real resumable uploads (QA-039 — catalog wording is now
  honestly single-shot), auto-continuation beyond the proven Claude case, the
  transcript List migration for pathologically long threads, and settings
  revision/etag (W-j).

- **v3.0.4** (2026-07-22) — fixes GitHub #20: saving Per-Harness Defaults from
  the macOS app reported "Could not save settings: DecodingError.keyNotFound
  ('path')" even though the daemon had already written the config. The Swift
  client still decoded the v0.x `{path}` receipt from POST /settings; the
  daemon has answered with the effective settings snapshot (GET's shape) since
  v2.1.2, and the mismatch was unmasked when v3.0.3 fixed the request-side
  400 (#18). The app now decodes the snapshot, applies it directly (no
  follow-up GET), and reports success honestly. The TS→Swift wire-fixture
  gate gains a maximal `ControlSettingsSnapshot` fixture so the POST
  /settings response contract is pinned the same way #18 pinned the request.
- **v3.0.3** (2026-07-21) — hardening from the 2026-07-21 "codex chats
  disappeared" incident forensics (local data was never touched; the trigger
  was an OpenAI server-side session invalidation from a shared-browser account
  switch) plus GitHub issue triage. Config: a schema-parse failure is now a
  typed `config_invalid` (422) with a path-specific inspect-or-restore remedy
  instead of a generic 500; the retired-key registry gained the pre-registry
  v1 removals that broke strict parse (`default_portfolio`,
  `routing.default_policy`, `budget.max_usd_per_run`, `harnesses.*.max_usd`);
  the startup sweep now rewrites the GLOBAL config only on this generation's
  own default root — never a foreign root reached via `CLAUDEXOR_CONFIG_DIR` —
  and writes a byte-identical backup before it mutates. Plugins: a version
  skew or an unmarked non-default frozen root is a hard `mcp serve` refusal
  (`plugin_artifact_skew`, remedy `claudexor plugin repair all`) rather than an
  ignorable stderr warning; default-root installs no longer freeze
  `CLAUDEXOR_CONFIG_DIR`, and an explicit override carries a
  `CLAUDEXOR_ROOT_MODE=explicit` provenance marker. Setup: an interactive login
  survives an ordinary daemon restart (a bounce no longer kills the operator's
  own pending login), reconciling only identity-proven live runners; codex
  login defaults to device-auth (safe for sibling OpenAI sessions when
  completed in an isolated browser window) with `--browser-redirect` as the
  explicit opt-in and a typed `not_supported` outcome on older codex CLIs;
  claude login drops the version-varying `--claudeai` flag (#17); a device-auth
  login that fails after starting carries the ChatGPT "Allow device code
  login" toggle remedy; the CLI discloses daemon/CLI engine-version skew from the
  control handshake. Quota: a
  logged-out codex home reports a typed `not_logged_in` absence WITHOUT
  booting `codex app-server` (ending the every-60s scoped-home spawn loop),
  absence-only refresh cycles back off exponentially, and a claude
  `oauth/usage` HTTP 200 with no parseable windows is a typed
  `refresh_failed` absence (BACKLOG Q-a); codex transcript readers no longer
  fall back to the operator's real `~/.codex`. macOS: the
  dead per-harness `maxUsd` field that 400'd Per-Harness Defaults is removed
  (#18), and the onboarding window scrolls (#15). Build: `build-app.sh` hard-
  fails on a non-self-contained (libnode-linked) Node instead of silently
  bundling a dead binary (#14); a new `retired-key-check` gate asserts every
  key removed from the persisted config schemas lands in the retired-key
  registry. Also ships the packaged-.app launch fix from #13 (thanks
  @robert-platov): the executable no longer traps on `Bundle.module` at
  startup. Docs: a new agent Install And Login guide in
  `docs/AGENT_ONBOARDING.md` and a reproducible GitHub social preview (#19).

- **v3.0.2** (2026-07-21) — Linux subscription-quota parity for Claude. The
  per-profile quota reader (`oauth/usage` source) read the access token only
  from the macOS keychain item, so on Linux `quota --refresh` returned a
  misleading `not_logged_in` absence for every logged-in claude account while
  runs and doctor were green. Off macOS the reader now uses the vendor's own
  store — `.credentials.json` (mode 0600) inside the profile's config dir —
  with the same transient-token discipline (one usage request, never
  persisted/logged/in errors). A missing file stays an honest
  `not_logged_in`; an unreadable or unparseable file is a typed
  `refresh_failed` naming only the error class. macOS behavior is unchanged;
  Codex quota was already file-store-portable. Also: README badges and an
  author section.

- **v3.0.1** (2026-07-20) — hotfix: every browser-downloaded 3.0.0 DMG crashed
  at launch (EXC_BREAKPOINT in `applicationDidFinishLaunching`). The SwiftPM
  `Bundle.module` accessor fatalErrors when the resource bundle fails to load,
  and a quarantined process refuses the plist-less bundle `swift build` emits.
  Fixed twice over: the Dock-icon override (essential for the bare dev
  executable, harmlessly re-applied by the packaged app) is now resolved by
  plain file path (no `Bundle.module`, cosmetic degrade instead of crash),
  and `build-app.sh` writes a minimal `Info.plist` into the resource bundle.
  If you downloaded 3.0.0: upgrade to this DMG — that is the fix. Only if
  you must stay on 3.0.0, first verify you have an intact app signed by the
  official Claudexor Developer ID:
  `spctl -a -vv /Applications/Claudexor.app` must report `Notarized
  Developer ID` AND `origin=Developer ID Application: Andrei Kaznacheev
  (N7RDVVZ7LA)` — a generic notarization line alone proves only that
  *some* notarized app sits at that path. (Signer identity proves an intact
  official build, not byte-identity with the published artifact; for that,
  check the downloaded DMG against `SHA256SUMS` on the release page.) Only
  then drop the quarantine flag:
  `xattr -d com.apple.quarantine /Applications/Claudexor.app`.

- **v3.0.0** (2026-07-20) — the chat-first control plane, rebuilt on honest
  server truth. This is a breaking major: a fresh `~/.claudexor/v3/` data root
  (the old `~/.claudexor/v2/` root is left untouched as the archive; no
  migration), wire protocol major 3, and a single chat-first macOS app.
  Modes collapse to Ask / Plan / Agent — Orchestrate is gone and delegation is
  `agent --delegate` with a scoped six-tool MCP belt (isolated sub-runs, depth
  1, count and budget caps enforced server-side). Plan absorbs Spec: native
  vendor plan modes, typed open questions, answer turns, freeze-on-implement
  with a hashed ExecutionBrief, and the Council strategy. Continuity is the
  flagship: durable per-lane native sessions keyed by (thread, harness,
  profile), lane checkpoints, bounded continuation packets with cached LLM
  summaries, and a visible typed disclosure when a lane switch carries thread
  context. Status is independent axes (lifecycle / checks / review / no-changes
  / typed reason) rendered as Working / Done / Done · not verified / Needs
  review / Failed / Cancelled / Interrupted, with a server-owned outcome banner
  that model prose can never outrank; unknown cost renders "—", never $0.
  Accounts are fully symmetric — every row has an Enabled toggle (participates
  in pickers and auto-rotation), the next-up account among the enabled ones is
  computed and shown, threads keep their account and access sticky with a
  per-thread pin/override, and native CLI login is just a row. The engine
  owns every fact; macOS, MCP, and ACP are thin clients that decode, not
  derive: a thread-scoped Changes / Artifacts / Evidence workspace with typed
  LoadState, a shared ChipMenu, global
  text selection, code-first route descriptors feeding the generated operation
  catalog, and TS↔Swift fixture round-trips. A runtime-closure update CHECK reads
  the release manifest (`{version, sha256, minAppVersion, notes}`; the signature
  field is reserved) and surfaces a newer engine as a bottom-left chip
  that links to the GitHub release for a manual download (one-click in-app
  auto-install of the engine runtime is deferred to 3.1); a zero-telemetry
  install counter reads public npm and GitHub stats.
  The immune system guards all of it: staged-field v3, the INV→verify link
  gate, the concept gate, reviewer liveness with a typed blocker contract, and
  a cumulative findings ledger. The review protocol is a single canonical
  cycle (internal critics + the exact triad plus scope reviewer, one
  adjudication, one batched fix, one confirmation wave). Upgrade note: v3 boots
  on its own data root, so the first launch starts clean; existing v2 state and
  run history remain readable only under the archived `~/.claudexor/v2/` path.

- **v2.1.3** (2026-07-18) — account and large-run reliability finish.
  Accounts now have one shared Manage surface with Back/Done navigation,
  manual thread pinning, auto-balance, and safe deletion. Claude native
  subscription auth works in scoped runs without mutating `~/.claude`.
  Large run details are single-flight and progressive: bounded primary output,
  metadata-only diagnostics, tab-demand diffs, bounded transcripts, and
  restart-safe Spec interviews. Best-of-N now uses file-backed synthesis,
  preserves winner screenshots, reports honest candidate/tool failures, and
  separates native subscription valuation from API-key cash (including mixed
  reviewer panels). Plan review is typed as plan review; exhausted account
  rotation, zero configured gates, and candidate errors are explicit evidence.
  Upgrade note: Claude's default native store moved from ordinary `~/.claude`
  to Claudexor-owned state, so existing users complete Login once in Accounts
  (or Settings → Harnesses → Claude → Manage); ordinary Claude Code remains
  untouched.

- **v2.1.2** (2026-07-18) — the credential-profiles release, published as
  2.1.2 after two npm-infrastructure burns: the v2.1.0 flight died on npm's
  post-publish indexing lag (the publisher's exposure window was too small),
  and the v2.1.1 flight on two more npm realities — the attestation endpoint
  lags like the version listing, and package builds are not byte-reproducible
  across CI runs, so retries demanding local byte-identity could never pass.
  Both partial version sets are orphaned on the registry (npm forbids
  re-publishing a version); nothing user-visible shipped as 2.1.0 or 2.1.1.
  The publisher now waits out both npm endpoints (bounded 10-minute polls)
  and anchors retry skips on npm's signed SLSA provenance (same repo/
  workflow/tag/candidate commit + published-bytes digest) instead of
  impossible byte-identity. On top of the 2.1.0 scope below, this release
  adds account deletion
  end-to-end (`DELETE /v2/credential-profiles/:harness/:id` with a
  delete-grade confinement fence and disclosed cleanup, `claudexor profiles
  remove`, delete on account rows) and ONE shared accounts surface
  (`AccountsSurface`) reused by the bottom-left popover and the Settings
  Harness Doctor's Manage sheet, plus the owner-review release protocol
  constitutionalized as INV-125.

  The 2.1.0 scope: credential profiles (INV-135) and the honest-UI
  finish of the 2.x cycle. Multiple subscriptions per harness: durable
  non-secret `credential_profiles` registry, isolated vendor config dirs
  (`claudexor profiles login`), namespaced secret slots, strict per-turn /
  thread-sticky selection, profile-isolated native-session resume, and
  per-profile doctor probes (`GET /v2/credential-profiles`). Subscription
  quota is now read proactively per profile from the vendor `oauth/usage`
  endpoint (token transient-only, never persisted or logged) with per-profile
  chips in the quota footer, plus the live-verified codex
  `rateLimitResetCredits` balance. One typed `profile_policy` per harness
  (`fail|ask|rotate`): preflight headroom breaches and typed vendor-limit
  rejections rotate with full provenance — never on plain network errors,
  never mid-spawn, each profile at most once per attempt. Also in 2.0.1/2.0.2
  (unpublished patch steps folded into this release): the honest-engine pass
  (shutdown state-machine with an uncancellable drain sweep, daemon-owned
  retention with tombstones, typed final-answer assembly, harness-stream
  reference + manifest-declared stream conformance) and the simple-UI pass
  (messenger chat cards, flat one-row-per-tool transcripts, RunFacts SSOT,
  daemon-normalized readiness rows, cause-driven single-CTA auth sheet,
  typed budget.cash disclosure; INV-134 presentation discipline). Claude
  api_retry error prose now classifies onto the documented retry categories.

- **v2.0.0** (2026-07-15; **unpublished** — superseded by v2.1.0 before any
  tag, GitHub Release, or npm publish; kept here as the contract baseline) —
  clean breaking reset. Claudexor now exposes one
  versioned `/v2` daemon authority over a checksummed durable journal, typed
  commands and scoped event streams; v1 project, trust, secret, run, and thread
  state is neither imported nor mutated. Delivery is preimage-bound and always
  runs the same fresh FinalVerifier before manual apply, thread apply, race
  adoption, or orchestration delivery. Capability truth is split into static
  manifest, live doctor, and request preflight; attachments are immutable
  streamed resources, Browser is a pinned offline-capable runtime with
  per-lane receipts, and Raw implement returns a scoped hash-bound Git patch.
  Outcome reduction no longer launders incomplete required work into success;
  budgets use explicit finite/unlimited semantics and one root ledger, while
  routing is reduced to `auto`, `quality`, and `economy` over durable
  multi-window quota evidence. The macOS app, CLI, MCP, and ACP are thin live
  projections of those contracts, with honest offline/review/retry/spec/setup
  states. Release publication is now fail-closed: exact-SHA review attestation,
  signed and separately notarized/stapled app + DMG, SBOM, checksums, GitHub
  provenance, collision refusal, and npm provenance are mandatory; published
  tags, releases, and assets are never edited by the workflow.

- **v1.0.1** (2026-07-09) — the macOS app is now SIGNED (Developer ID +
  hardened runtime), NOTARIZED, and stapled: no Gatekeeper bypass needed.
  Fixed the v1.0.0 app's self-contained daemon, which crashed at load in
  the single-file bundle (`createRequire(import.meta.url)` is undefined in
  CJS bundles; the generated-schema loads are now static JSON imports and
  the build runs a boot smoke on the freshly built bundle, so a load-crash
  can never ship again). The bundled Node runtime is signed with the JIT
  entitlements hardened runtime requires. Release automation: signing is
  data-driven off repository secrets (secret-less builds still produce
  honest `-unsigned` artifacts), re-packaging a published release no
  longer demotes it to draft, and npm publishing completes the package
  set. CLI: `spec --answers` now refuses grounding-only flags
  (`--harness/--n/--web/--effort/--max-usd/--reviewer-*`) instead of
  silently ignoring them, and the spec grounding run honors
  `--effort`/`--max-usd` cost controls.

- **v1.0.0** (2026-07-09) — the first public release. Three programs land
  on top of v0.15: PUBLICATION HYGIENE — provenance sweep of the whole tree
  (private paths, internal codenames, decision-register markers), sanitized
  recorded fixtures with enforced provenance, a community trust pack
  (SECURITY.md, issue/PR templates, Dependabot, no-telemetry Privacy and
  uninstall/data maps), and supply-chain pinning (pnpm `allowBuilds`, no
  dependency install scripts). AGENT CONTRACT — the CLI surface has ONE
  typed owner (`command-registry.ts`) that renders `claudexor help`, the
  machine-readable `help --json`, plugin instruction texts, and the
  docs/parity gates; a derived AgentCapabilityCatalog answers "what can
  this install do right now" identically over `claudexor capabilities
  --json`, `GET /agent-capabilities`, and the MCP `claudexor_capabilities`
  tool; MCP tools declare outputSchema + structuredContent + behavior
  annotations and gained read-only recovery tools (`claudexor_runs`,
  `claudexor_inspect`, `claudexor_apply_check`); every run result carries a
  derived `applyEligibility` verdict (one producer: the delivery gate);
  every Zod schema ships field-level `.describe()` docs and
  `docs/reference/endpoints.json` maps the control API with schema refs;
  `docs/AGENT_ONBOARDING.md` orients external agents. NAMING AND SAFETY —
  BREAKING: the `run` verb is now `agent` and `race` is `best-of`
  (old spellings hard-error with the new name; the MCP race tool is
  `claudexor_best_of`); secret-like values inside prompts are HARD-BLOCKED
  at every ingress (CLI, control API, thread turns, MCP, ACP, daemon
  socket, and the engine boundary itself) with a typed
  `inline_secret_rejected` error and no bypass; the feature-status ledger
  was emptied (26 fixes landed; deliberate boundaries moved to Design
  constraints in ARCHITECTURE/INTEGRATIONS); strictness upgrades:
  out-of-scope flags now hard-error per verb (e.g. `explore --swarm`,
  `spec --model`), `--access-default` requires a value, and unknown verbs
  return the `{ok:false}` JSON envelope under `--json`. npm packages are
  published from the tag with provenance (`claudexor` is the bin wrapper
  over `@claudexor/cli`).
- **v0.15.0** (2026-07-05) — the stabilization release: concept freeze
  (numbered-invariant Bible + concept gate), model governance
  (harness-scoped models, strict truth-source validation at settings-write
  and run preflight), run honesty (terminal events on every path, an
  inactivity watchdog, crash GC with live-owner proof, CRLF/binary diff
  fidelity, and a fresh-envelope FinalVerifier before apply/adopt),
  routing/output reality (typed quota -> headroom-aware routing, portfolio
  metrics with real producers, structured output on both real CLIs, live
  plan checklists, per-candidate evidence cards), a per-commit multi-model
  review gate with audited bypasses, and the MCP/ACP surface upgrade +
  integration suite below. Refused turns are honest end-to-end: a run
  refused before it starts persists a typed `enqueue_error` on its turn
  (INV-093), every surface renders it inline,
  `POST /threads/:id/turns/:turnId/retry` replays the same turn
  (non-retryable refusals 409), and the macOS trust refusal carries a
  one-click "Allow full access & Retry" backed by the narrow user-level
  GET/POST /trust surface (provenance-stamped, locked writes; Settings
  audit + revoke). UI performance without touching glass/transparency:
  per-run render granularity (one card repaints, not the app), adaptive
  SSE coalescing, bounded feeds with honest truncation markers, a lazy
  newest-first Timeline, and off-screen terminal-run eviction. Phase
  entries below preserve the detailed history.
- **v0.15 program, phase 5** — MCP/ACP surface
  upgrade: the MCP server rides the official TypeScript SDK v2
  (`@modelcontextprotocol/server` 2.0.0-beta.1) — concurrent dispatch
  (ping/tools/list answer during a long race; the hand-rolled loop was
  strictly sequential), protocol-era negotiation (2025-11-25 down to
  2024-10-07), SDK-validated arguments over the same JSON Schemas (semantic
  checks stay as handler preflight; argument failures are `isError` tool
  results per the SDK contract, not -32602). MCP MUTATING verbs
  (run/race/create) are DAEMON-TRACKED via the control API (auto-start):
  `GET /runs` lists MCP runs, cancel/decision work, and every result carries
  a runId/artifacts/status trailer (live-verified). Read-only verbs stay
  in-process (CLI doctrine). Engine questions bridge to MCP ELICITATION when
  the host declares the capability (pendingInteractions polling + typed
  answer endpoint); timeout-decline stays the fallback. `mcp serve` warns on
  stderr when `CLAUDEXOR_PLUGIN_VERSION` (installed artifacts) differs from
  the CLI (the env var's first reader). ACP: initialize carries
  `authMethods: []`, the protocol `_meta` envelope is tolerated (unknown
  Claudexor knobs still fail loudly), and permission requests announce their
  tool_call first (no orphan ids). Host plugins regenerated + repaired.
  Host CANCELLATION: MCP notifications/cancelled aborts the run — the SDK's
  per-request signal rides the runner hooks; on daemon-tracked runs it
  becomes the same typed cancel control as CLI Ctrl-C (posted once, on the
  poll tick, after the run is bound).
  Integration test suite: surface canaries in CI (MCP daemon-tracked run
  E2E over stdio, plugin lifecycle in a scratch HOME, ACP conformance
  smoke), the MCP<->CLI capability parity gate
  (`scripts/mcp-cli-parity-check.mjs`, CI — pins the stale-tool-schema
  class), `scripts/cursor-itest.mjs` (Cursor chain phases A/C/D + failure
  modes scripted; manual B/E in CHECKLISTS), and real-harness battery
  phases 10-12 (`mcp serve` / `acp serve` smokes + plugin lifecycle;
  `CLAUDEXOR_BATTERY_PHASES` filter) — live-run green on codex. Fixture
  provenance manifests (`packages/harness-*/fixtures/manifest.yaml`:
  synthetic vs recorded + the vendor CLI version a recording proves) with
  a CI coverage gate and a release-grade freshness check
  (`scripts/fixture-freshness-check.mjs --strict`); the mandatory
  pre-release IMMUNE SCAN (whole-tree audit against the Bible) is now a
  Release checklist step.
- **v0.15 program, phase 4** — routing/output reality: typed
  quota events (codex rollout rate-window -> used_percent observations ->
  headroom-aware pool ordering + `budget.quota_pressure` disclosure; claude
  fail-honest), portfolio metrics with real producers (per-harness EMA
  cost/latency under the config dir + operator `routing.quality_priors`),
  structured output live on both CLIs (codex `--output-schema`, claude
  `--json-schema`; strictified inline OrchestratePlan schema; structured-first
  plan parsing), live plan checklists (`plan.progress` from codex todo_list /
  claude TaskCreate+TaskUpdate) and per-candidate evidence cards projected on
  run detail (macOS Candidates/Plan tabs live), and the per-commit review
  gate (`claudexor review` + `scripts/commit-review.mjs` with audited
  bypasses; opt-in hooks).
- **v0.15 program, phase 3** — run honesty: every announced run
  now ends with a terminal event on every path (throw/cancel/daemon restart);
  a silent harness stream is killed by an inactivity watchdog
  (`runtime.harness_inactivity_timeout_ms`, default 20 min; waiting on a user
  question does not count as silence); diffs are captured byte-faithfully
  (CRLF/binary survive; payload-less binary stubs are typed refusals); race
  winners must additionally survive a FINAL VERIFY (fresh worktree at the
  winner's base + deterministic gates; failures AND verifier errors block the
  run fail-closed); apply/adopt ride a protected path (check-first, restore
  on failure). BREAKING surface changes: `POST /runs` rejects client-supplied
  `turnId` and `planRunId` (400); unknown CLI commands exit 2 (was: help with
  exit 0); thread apply 409s while the head run is blocked/failed without a
  typed operator decision (or its record was pruned); `--max-tool-calls` /
  `maxToolCalls` is refused outside orchestrate; orchestrate sub-runs share
  ONE aggregate budget (each sequential step gets the remaining headroom).
- **v0.15 program, phases 1-2** — BREAKING config strictness: YAML configs
  (`~/.claudexor/config.yaml`, project `.claudexor/config.yaml`, trust files)
  are now parsed against STRICT schemas — an unknown/typo'd key is a loud
  `ConfigParseError` naming it, never a silent no-op. Keys that OLDER
  Claudexor versions legitimately wrote (`secrets`, `budget.max_usd_per_day`,
  `routing.default_model`, `harnesses.*.auth_ref`, `harnesses.*.native_options`,
  project `project/delivery/review` blocks and retired context flags) are
  auto-stripped by a migration registry and disappear on the next config
  write; any OTHER unknown key must be removed by hand. Model choice is now
  harness-scoped end-to-end (`routing.default_model` is gone — use
  `harnesses.<id>.default_model`), and every explicit model must pass the
  harness's model truth source. The intents `compare`/`arbitrate` and the
  `scope.context: deep` tier were retired.
- **v0.14.1** (2026-07-01) — checkpoint hardening for explicit reviewer panels, mandatory
  review evidence preflight, scoped Cursor reviewer readiness, frozen SpecPack
  gate merging, protected-path approvals, and thin control/macOS projection
  parity.
- **v0.14.0** (2026-06-29) — battery-driven hardening: typed transient retry evidence,
  configurable reviewer timeouts with stronger route-proof capture,
  `stuck_no_progress` convergence diagnostics, deterministic protected-path
  tamper blocking, and a stricter real-harness battery with ENV quarantine.
- **v0.13.3** (2026-06-28) — harness-agnostic hardening: a contract-level attempt outcome
  model, unified runtime PATH handling, adapter-declared credential/isolation
  capabilities, uniform mandatory-context behavior across harnesses,
  sandbox-safe secrets, deterministic fakes, and an honest CLI surface.
- **v0.13.2** (2026-06-27) — Canvas + node_repl fix: the Canvas Artifacts panel now shows the
  PROJECT's produced outputs (the repo `artifacts/` dir, served via
  `GET /runs/:id/produced`, images inline, the Browser tab auto-renders the
  project `index.html`) — distinct from Run Detail's run-internal artifact tree;
  and Codex.app's inherited `node_repl` MCP, which can't run headless and failed
  otherwise-clean runs, is now disabled config-aware (only when it is actually
  defined in the config codex loads — never on a scoped home, which avoids an
  "invalid transport" config-load break).
- **v0.13.1** (2026-06-26) — attachment fix: user-attached images now reach the model
  (orchestrator forwards attachments in every run path; the codex adapter
  terminates the variadic `-i` with `--` so the prompt survives), an image-bearing
  run only routes to vision-capable harnesses (or fails loudly), and large
  agent-produced images render in the gallery.
- **v0.13.0** (2026-06-26) — interactive workbench: composer attachments + in-app screenshots,
  an artifacts gallery + mini-browser in a Canvas/Workbench, a deeper multi-tier
  spec interview, a multi-harness planning relay, and an agent-driven browser
  (Playwright MCP).
- **v0.12.1** (2026-06-18) — fix release after v0.12.0: embed the SwiftPM-generated resource
  bundle in the release macOS app so the packaged app works outside the build
  checkout.
- **v0.12.0** (2026-06-17) — restored the write/apply path (codex transcript route-proof,
  scoped homes) and honesty fixes.
- **v0.11.0** (2026-06-17) — host plugin lifecycle: `claudexor plugin` now manages
  user-global Claude Code, Codex, Cursor, and OpenCode integrations with
  generated skill/MCP artifacts plus command artifacts where the host supports
  them, ownership state, dry-run/status/doctor/repair/uninstall flows, Codex
  personal-marketplace registration, OpenCode skill/command/experimental
  JS-plugin/MCP wiring, and install-health checks that keep host integration
  readiness separate from harness doctor readiness.
- **v0.10.2** (2026-06-15) — real interactive spec quiz (multiple-choice interview) and the
  frosted-glass backdrop refinement.
- **v0.10.1** (2026-06-15) — macOS UX fixes and the first interactive spec flow.
- **v0.10.0** (2026-06-15) — chat-first macOS beta: one-screen thread list, conversation,
  and inspector; in-place thread turns; honest run outcomes; static
  behind-window glass replacing the old animated mesh.
- **v0.9.0** (2026-06-12) — chat/session-first + harness-agnostic truth: modes collapse 9→5
  (`ask`/`plan`/`audit`/`agent`/`orchestrate`; strategies are flags); threads
  with native session resume across read-only turns (codex `exec resume`,
  claude `--resume`; write turns run fresh envelopes with a typed
  `session.rebound` disclosure) plus a no-args CLI REPL; subscription auth pass-through into
  envelopes (native codex/claude sessions work with NO API key) with both auth
  routes and auto-fallback; typed operator decisions unblock NEEDS_HUMAN runs
  through the apply gate (patch-hash-bound, audited); the `orchestrate` brain
  intent (routed like reviewers, typed tool-belt plan); survival fixes (diff vs
  base_sha so committed harness work is never lost, untracked-inclusive
  snapshots, branch GC, process-group kills, mid-flight budget caps, reviewer
  timeout spend, codex cached-token cost, honest acceptance/tie evidence,
  expanded secret redaction); doctor probe TTL cache; MCP protocol bump with
  doctor-honest status + repo-path input; ACP editor-cwd + free-text answers;
  cursor/opencode resume + unified provider env scrub; OpenRouter raw-api
  instance; macOS ThreadsScreen (chat-first) with decision/apply actions on
  turns and a lifted dark card recipe.
- **v0.8.0** (2026-06-11) — live truth pass: event-sourced streaming with a monotonic
  per-run `seq` and snapshot-then-subscribe SSE (gap-free reconnects, byte-level
  parser in the macOS app), interactive runs (`waiting_on_user`) with Claude's
  bidirectional control protocol live-verified (`AskUserQuestion` answered from
  the app, CLI `claudexor follow`, ACP), automatic git initialization for
  write-mode runs on non-git folders (seeded `.gitignore` + announced baseline
  commit), orchestrator honesty fixes (no corpse review/synthesis spend,
  root-cause `failure.yaml`, `output.ready` before terminal events, no vacuous
  `tests=100%`), in-process setup doctor (exit-127 class removed), observed-model
  route proof, global `GET /events` multiplex, configurable interaction timeout,
  and the frosted floating-card design doctrine across both themes.
- **v0.7.0** (2026-06-10) — engine truth pass: typed `tool_call`/`tool_result` events with a
  shared adapter run loop, engine-owned `final/telemetry.yaml` evidence, web
  policy as a manifest capability with disclosed upgrades, parallel
  race/explore, user-level trust gating for full access, per-harness settings
  enforced engine-wide (enabled/model/effort/web in the macOS editor; budget,
  turn/round caps, and tool lists via config and the settings API), typed
  risk/protected-path review gates, honest control-api/daemon lifecycles,
  macOS live streams + diff tab + per-harness settings editor,
  knip/docs-truth/conformance CI gates,
  dead subsystem deletions (ExecutionEngine, legacy in-proc control server,
  `/runs/:id/input` stub).
- **v0.6.0** (2026-06-09) — first public beta: canonical modes, daemon + control API, macOS
  app, review/arbitration pipeline, secret store, release automation.

Tags before v0.6.0 (v0.1.0–v0.5.0) were internal pre-beta milestones and are
not documented here.
