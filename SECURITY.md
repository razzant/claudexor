# Security Policy

Claudexor is a local-first control plane: it runs on your machine, spawns
vendor coding CLIs with your credentials, serves a loopback-only control API,
and applies patches to your repositories. Security reports matter.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**, not in public issues:

- Open a private advisory via GitHub Security Advisories
  ("Report a vulnerability" on the repository's **Security** tab), or
- email the maintainer at the address on the GitHub profile that owns this
  repository.

Include what you observed, how to reproduce it, the affected version
(`claudexor --version` or the git SHA), and the impact you expect. A minimal
proof-of-concept helps.

Please do not run automated scanners against infrastructure you do not own on
Claudexor's behalf; the product is local, so a local reproduction is enough.

## Response expectations

This is a small project. Expect an initial acknowledgement within about a
week. Fixes ship in a normal release; if a fix is security-sensitive, the
release notes will say so once users have had a reasonable chance to update.

## Supported versions

Only the latest released version is supported. There are no backported
security fixes for older tags; upgrade to the current release.

## Scope and posture

What Claudexor already does, so you can calibrate reports:

- The control API binds `127.0.0.1` only, requires a bearer token
  (timing-safe comparison), and enforces a loopback host/origin guard;
  `/healthz` is the only unauthenticated route.
- Claudexor-managed secrets use the daemon-owned `0600` file store. Vendor-native
  credentials remain in each vendor's own store, which may use the OS Keychain.
  Claudexor never places these engine credentials into prompts, events or
  artifacts and keeps their stores outside every authorized root. A harness
  process can read the credential the engine hands it (for example the API key
  or OAuth token in its environment); whatever the harness prints is ordinary
  output, kept exactly in local run records as in the vendor's own transcript.
  The ACP adapter removes the managed token it injected, by value. Engine and
  vendor diagnostics (errors, stderr tails, probe output, vendor failure
  reports, retry notices and native warnings) are not working content: they
  mask credential-shaped text, including in the run, attempt and reviewer
  event journals, which every writer fills through one shared
  diagnostic-masking step, and may be retained only in masked form. Your own
  working content (model-authored or user-provided material) is not filtered:
  prompts, attachments, project files, answers, a failed completion's partial
  output, tool calls and tool output, patches and review evidence reach the
  selected harness and stay unmasked in local run records (answers, patches
  and files byte-exact; tool output as each adapter's bounded,
  whitespace-normalized summary), so a real key you place there or a tool
  prints is ordinary task material. Of an ACP agent's raw frames only the lines of its JSON-RPC
  error frames, which are diagnostics, are masked; its other frames stay
  exact. Publication is the one content check: before anything is
  pushed, `pr` delivery scans the outgoing commits (merges and messages
  included), the branch name and the PR title and body with the pinned
  Betterleaks scanner and refuses on a finding, an unavailable scanner or a
  failed scan, including a Git history read that Git's own trace does not
  prove complete. Betterleaks skips some binary, archive and lockfile content.
- No telemetry, analytics or crash reports (README Privacy). Configured model/
  harness routes send outbound traffic; Web/Search follows run policy (`auto`),
  Browser needs opt-in, and enabled SSH streams may reconnect automatically.
  Existing demand/pacing polls vendor status/quota, including Anthropic
  `oauth/usage` and Cursor's internal dashboard `usage-summary`. Cursor sends
  only the named file store's bound token as a `WorkosCursorSessionToken` cookie
  to cursor.com: no OAuth refresh/credential write. Dashboard money is display-only,
  never execution quota/admission. Public GitHub/npm name/update/statistics reads
  are user-invoked except foreground app update checks (no update timer).
  Local `telemetry` files are on-device evidence, never transmitted analytics.
- Harness processes run as the signed-in OS user under each vendor CLI's
  native access mode. Claudexor does not add an outer Seatbelt, container, or
  other OS filesystem boundary. Scoped `HOME` and named profile directories
  select the intended account and separate vendor-written state; they do not
  stop the process from reaching other same-user host paths. In particular,
  trusted `full` can read or mutate out-of-project state, and those effects are
  outside Claudexor's patch capture, review, revert, and rollback custody.
- `execution.auxiliaryWritableRoots` is a caller grant, not a confinement claim:
  under `workspace_write` a capable adapter may write those exact directories,
  and the same custody gap applies to what it writes there. Admission refuses
  roots that would reach HOME itself, Claudexor state, the project, the execution
  tree or their Git metadata, but cannot judge whether a granted directory is
  safe to share; sharing one mutable environment between concurrent runs, or
  granting a vendor's own configuration directory under HOME, is the caller's
  decision.
- Repository trust gates authorization for an operator at a surface to request
  native `full`; it is not a containment claim. `workspace_write` and `readonly`
  mean the selected adapter's native policy, whose exact enforcement differs by
  vendor. A run marked `execution.delegated` carries the external orchestrator's
  own authority instead and needs no trust record. Two surfaces can set that
  marker — on a one-shot run, or once on a thread created with
  `workspace: "delegated"` and a `workspaceRoot`, whose every later turn then
  inherits it — and what the exemption costs differs between them, so both are
  stated separately. A control-API client holds the daemon token and can already grant
  itself the allow through `POST /v2/trust`, so requiring a second ceremony
  there bought nothing. An MCP tool caller is the host's model: it holds no
  token and has no trust-writing tool, so for it the marker is a real widening.
  One call with `execution.delegated: true` and `access: "full"` now runs
  unsandboxed native `full` on any `repoPath` without the grant, where before it
  received the typed refusal, and the only remaining control is the host's own
  MCP tool-approval policy. `claudexor_thread_create` with
  `workspace: "delegated"` is the persistent form of the same widening: one
  approved creation call makes every later `claudexor_thread_turn` on that thread
  run with delegated authority in the named `workspaceRoot`, including `full`
  access without a grant, with no further approval beyond each turn call's own. The marker is caller-asserted and is not
  authenticated proof that an external orchestrator is really driving the run.
  It is recorded for an auditor in the run's job params, the recorded run start
  request that Exact Retry replays, and the per-attempt confinement disclosure
  on mutating delegated attempts; the immutable contract records the resulting
  `full` effective profile but not which authority admitted it.
- The macOS app cannot originate the marker: its `RunExecution` carries only
  `isolation` and an optional `auxiliaryWritableRoots` list that no app control
  sets. It can re-issue a run that already recorded one, because Retry
  Exact replays the recorded request and the Run Again draft keeps
  `execution`, so both carry `delegated` forward into a new `full` run without a
  grant; `claudexor retry` and `claudexor run-again` behave the same way.
  Delegation-belt sub-runs cannot set it, and a thread turn cannot set it per
  turn either, because its strict execution schema does not accept the field;
  only a thread's creation-time `workspace: "delegated"` binding makes its turns
  carry it, and that binding cannot be changed afterwards. The app cannot create
  such a thread. Either way the harness runs as the signed-in OS user with no
  outer boundary, as described above: a delegated thread's durable scoped `HOME`
  per (thread, harness, account) separates vendor state, but it is not
  containment, and its `workspaceRoot` is not a confinement root. For an externally orchestrated mutating run, the registered/trusted
  project stays `scope.root` while the harness executes in the caller-supplied
  `execution.workspaceRoot`; neither path relationship nor a second trust
  store is implied.

In scope: the CLI, daemon, control API, MCP/ACP servers, the macOS app, and
the host-integration plugin writers. Out of scope: vulnerabilities in the
third-party vendor CLIs (Codex, Claude Code, Cursor, OpenCode) themselves —
report those to their vendors.
