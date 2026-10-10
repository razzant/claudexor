# @claudexor/core

## 4.0.0

### Patch Changes

- Updated dependencies [2fbf7c9]
  - @claudexor/schema@4.0.0
  - @claudexor/util@4.0.0

## 3.25.1

### Patch Changes

- @claudexor/schema@3.25.1
- @claudexor/util@3.25.1

## 3.25.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.25.0
  - @claudexor/util@3.25.0

## 3.24.0

### Minor Changes

- Add shared vendor CLI inspection and maintenance with durable update, cancellation and previous-version evidence. Preserve newer managed installations and support native Cursor and Antigravity updates. Permit explicit Codex models absent from a successful catalog without misreporting account availability as exhausted quota.

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.24.0
  - @claudexor/util@3.24.0

## 3.23.2

### Patch Changes

- @claudexor/schema@3.23.2
- @claudexor/util@3.23.2

## 3.23.1

### Patch Changes

- @claudexor/schema@3.23.1
- @claudexor/util@3.23.1

## 3.23.0

### Patch Changes

- @claudexor/schema@3.23.0
- @claudexor/util@3.23.0

## 3.22.1

### Patch Changes

- Updated dependencies [902532e]
  - @claudexor/schema@3.22.1
  - @claudexor/util@3.22.1

## 3.22.0

### Minor Changes

- 785bba7: Automatic continuation inside one attempt ("auto-rotation inside the work"). After a try that acted, a typed vendor limit hops the attempt to the next eligible account and the next process continues the same work: the claude/codex session file is moved into the target account's store and resumed there (`native_moved`), or — when it cannot be moved — a fresh session is re-grounded by a mechanical evidence index (`packet`); a transport death resumes the same session on the same account (`native`), bounded by `transient_retry.max_retries` per account. A partially acted attempt never replays its original prompt; the continued process receives one constant notice instead. Pinned accounts, `fail`/`ask` policies and a spent pool end typed. Every continued try settles with a `run.continuity` receipt (carrier, cause, accounts, memory, this try's attested model, identity check, input delivery) and every terminal whose work is unfinished carries `resumable` (cause, reset, carriers, native session, workspace) on the terminal event and in `final/resumable.yaml`. Adapters gain an optional `continuity` capability (`locate` / `move` / `rejectsCarriedState`); codex compares the recovered thread id before `turn/start`. The engine compares a resumed session's id with the requested one only on adapters with that capability (Claude Code and Codex keep the id on resume); other harnesses record a new id after a resume as before. A process that dies after it acted without ever reporting a session id continues on the same account with a packet re-brief, bounded by `transient_retry.max_retries`. Schema: `SessionCapsule`, `RunResumable`, `RunContinuityReceipt`; `RunEventType` gains `run.continuity`.

### Patch Changes

- Updated dependencies [51578d4]
- Updated dependencies [785bba7]
  - @claudexor/schema@3.22.0
  - @claudexor/util@3.22.0

## 3.21.0

### Minor Changes

- 7c541ba: One effort word now works on Cursor and Antigravity too, where the level is a token of the compound model id. Given an effort preference, the adapter's preparation selects the listed level variant of the requested model's family from the inventory of the account that will run (`grok-4.7-high` + `max` runs the listed `grok-4.7-xhigh`; `gemini-3.8-flash-low` + `max` runs `gemini-3.8-flash-high`): the family is the id with exactly one shared-order level token removed, `fast` and `thinking` stay in the family key so the choice never crosses fast/standard or thinking/no-thinking, a family exists only when the account lists two or more levels, and the level is placed by the shared preference order alone. One preparation yields the final id (the processing receipt's `submittedNative`, which is the `--model` argument) and the effort receipt (`parameter: --model`, `submitted` = level token), recorded once per spawn and per reviewer dispatch; the requested id stays in the model hint and in `attempts[].requested_model`. Nothing new refuses: an unknown word, an ambiguous id, a family-less id or an empty account list keep the id unchanged with an `omitted` receipt and a note. Antigravity rewrites only from the pinned account's live `agy models` list; the static hint list never authorizes a rewrite. Settings writes accept the preference for these routes, the existing fast-pair and paid policy run after the level choice, and the final telemetry `model_mismatch` compares the observation with the id actually sent.

### Patch Changes

- f0ab916: Make one effort word work on every route. The vendor's own order still ranks every level it lists; the shared preference order (`none < minimal < low < medium < high < xhigh < max < ultra`) now places a word a route's ladder does not list, so `ultra` on a Claude binary that stops at `max` resolves downward to `max` and `none`/`minimal` resolve to the known minimum instead of refusing the run. The receipt names that placement and claims neither vendor support nor equal quality across vendors. One resolution result feeds the native flag, the typed receipt and the disclosure on Claude, Codex (sessions and raw model calls) and the ACP client, which now resolves `--effort` through the same resolver and records a receipt. A reviewer whose harness declares no effort controls keeps the preference as omitted with disclosure instead of failing the explicit panel or erasing the automatic panel's request. A word neither order knows is still refused before generation on routes that have a native effort knob.
- Updated dependencies [7c541ba]
- Updated dependencies [f0ab916]
- Updated dependencies [83bc0da]
- Updated dependencies [9ccd45d]
- Updated dependencies [a4ff572]
  - @claudexor/schema@3.21.0
  - @claudexor/util@3.21.0

## 3.20.1

### Patch Changes

- eb506c1: Keep account refusal and recovery evidence consistent across execution, account selection and Accounts, with managed credential generations protecting newer state from late results. Preserve independently measured Claude Code and Codex quota windows from running sessions without treating partial observations as a complete refresh. Retain safe native refusal and refresh diagnostics.
- dc30eda: Complete managed CLI and remote sign-in flows, preserve actionable Claude CLI version failures, and resolve native and standard npm Node entrypoints consistently across launch, probes and login.
- 705c2c1: Preserve received assistant text and cancelled Git effects without changing completion authority or starting another generation. Show retained Markdown beneath the real failure or cancellation cause, recover interrupted output from its existing event log, and bind manual Revert to the captured execution tree.
- Updated dependencies [eb506c1]
- Updated dependencies [dc30eda]
  - @claudexor/schema@3.20.1
  - @claudexor/util@3.20.1

## 3.20.0

### Minor Changes

- c12828c: Add a generic ACP v1 client harness with GitHub Copilot CLI as its first vendor.
  Use managed tokens and scoped homes, bounded typed streams, process-tree
  cancellation, a free session doctor and explicit paid write conformance.
  Model inventory is advisory; missing cost remains unknown. Copilot ACP is in
  preview: workspace writes are unfenced when permission callbacks are absent.
  Live input, native login and MCP injection are not included in this stage.

  Port permission, environment, launch, translation and lifecycle semantics from
  Róger Valderrama (@germago119), razzant/ouroboros#769, with the Q00 MIT notice
  retained in the new package.

### Patch Changes

- Updated dependencies [c12828c]
  - @claudexor/util@3.20.0
  - @claudexor/schema@3.20.0

## 3.19.0

### Patch Changes

- Claudexor ships as portable Claude Code and Cursor packages (`plugins/claude`, `plugins/cursor`) that carry the canonical Skill and the MCP server registration (no runtime, credentials, hooks or status-line collector; those stay with the managed `claudexor plugin install` integration), and the canonical Skill plus the managed-integration text describe `claudexor_accounts` truthfully (the plain call returns the cached listing; `fresh: true` is the expensive atomic snapshot). Production dependencies move to @agentclientprotocol/sdk 1.5.1, @modelcontextprotocol/server 2.2.0, @playwright/mcp 0.0.83, zod 4.6.5 and yaml 2.9.1; the release SBOM test reads the packaged Browser MCP version from packages/core instead of a literal.
- Updated dependencies
  - @claudexor/schema@3.19.0
  - @claudexor/util@3.19.0

## 3.18.0

### Patch Changes

- b00408e: Request a hidden Windows console when the shared spawn helpers start background child processes (harness runs, capability and version probes, git capture). Interactive sign-in and `setup attach` keep their visible terminal.
  - @claudexor/schema@3.18.0
  - @claudexor/util@3.18.0

## 3.17.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.17.2
  - @claudexor/util@3.17.2

## 3.17.1

### Patch Changes

- 72825b9: Resolve effort preferences at the final native route using the strongest supported level at or below a known request, with an explicitly recorded minimum or vendor-default omission when applicable. Preserve advertised future values, original preferences and model identities. Add shared typed effort evidence to model results and final attempt telemetry; keep adaptation disclosures in logs.

  Preserve strict legacy model results unless creation opts into `captureEffortEvidence=true`, binding that choice to idempotency while keeping exact stored bytes and digest acknowledgement. Keep effort verification metadata in negotiated account catalogs only. Refuse unplaceable effort without retrying another route, clean temporary Codex authorization on preparation exit, and describe prepared controls without claiming dispatch.

- Updated dependencies [72825b9]
  - @claudexor/schema@3.17.1
  - @claudexor/util@3.17.1

## 3.17.0

### Minor Changes

- 092ec2b: Claude Code runs accept live messages: `POST /v2/runs/:id/messages` now reaches a running Claude Code attempt through the adapter's native stdin queue fold (`capability_profile.live_input = "next_tool_boundary"`).

  A message is written to the live stream-json stdin as a user frame carrying the message id as its `uuid`. Claude Code queues it at once (`command_lifecycle queued`, the `accepted` receipt) and consumes it inside the same turn right after the current tool batch; the `--replay-user-messages` echo (or the `started` lifecycle frame) is the consumption receipt (`delivered` when it settles a still-open request, otherwise the adapter's status event with code `live_input_delivered` keyed by `message_id`). A message that arrives while the model composes its final text runs as the next native turn of the same process: the run loop's new `session.onIo` seam and a `closeStdinOn` that returns false while a message is `queued|started` or a run-owned background task is open keep stdin open, the parser folds the second `system/init` into one `started` (a typed `native_turn_started` status marks the turn) and emits each result's cost as the delta of the cumulative `total_cost_usd`, and the last result's final text is the run's answer. No `queued` frame within 2 s answers `delivery_unknown`/`response_timeout`; a lost stdin answers `delivery_unknown`/`transport_lost`; a `cancelled|discarded|refused` lifecycle state is typed `live_input_refused` and never fails the run. Both flows were recorded on Claude Code 2.1.283 through the real adapter path (`packages/harness-claude/fixtures/stream-json/recorded-live-fold-2.1.283.jsonl`, `recorded-live-final-text-2.1.283.jsonl`) and are replayed 1:1 by the conformance tests. Cursor, Antigravity, OpenCode and raw-api keep `none`.

### Patch Changes

- Updated dependencies [951489f]
  - @claudexor/schema@3.17.0
  - @claudexor/util@3.17.0

## 3.16.0

### Patch Changes

- Updated dependencies [788ddca]
  - @claudexor/schema@3.16.0
  - @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- @claudexor/schema@3.15.1
- @claudexor/util@3.15.1

## 3.15.0

### Minor Changes

- 3bc8af4: `claudexor harness install codex --target local` works on Windows, and doctor, login and runs resolve the image it installs.

  On Windows an npm global prefix holds only `.cmd`/sh/ps1 shims and no executable image, and Claudexor never spawns a harness through a shell (issue #191). The local target is therefore supported exactly where the pinned package yields a verified package-native image: `@openai/codex` resolves its `@openai/codex-win32-<arch>` platform package and executes `vendor/<triple>/bin/codex.exe`. Core's `runtime-env.ts` becomes the one owner of that layout (`npmGlobalPackagesDir`, `embeddedNpmCli`, `windowsNativeImageDir`, `managedWindowsNativeImageDirs`): the installer runs the embedded `node_modules/npm/bin/npm-cli.js` beside `node.exe`, forwards the Windows process-environment keys, anchors the managed root on the same `HOME` the harness PATH producer reads, and proves the image inside the prefix; the normalized harness PATH carries that image dir on win32 so every local surface resolves the same `codex.exe` by bare name. The receipt fields are unchanged. Claude, OpenCode, Cursor and Antigravity keep a typed `unsupported_platform` refusal on the Windows local target, now naming the exact reason; an unsupported architecture refuses the same way. The Windows CI lane installs the real pinned package on the exact embedded Node with no ambient node/npm and an isolated profile, then checks the receipt, direct and by-name `--version`, the idempotent recheck and `doctor --json` (`scripts/windows-local-install-smoke.mjs`). Linux and macOS behaviour is unchanged.

  Invariants: INV-067 (the same scoped env that spawns a run resolves the binary), INV-121/INV-122 (one layout owner reused by proof and PATH), INV-044 (typed refusals, no silent shim). No Bible change.

### Patch Changes

- @claudexor/schema@3.15.0
- @claudexor/util@3.15.0

## 3.14.0

### Minor Changes

- fb42a94: Model admission is the harness's own declaration, honoured on every list it owns.

  `model_inventory_absence` used to govern only a live `models()` answer; every manifest hint list stayed strict by construction, so a settings write, the doctor's configured-model check and the explicit reviewer panel refused any id the shipped list lacked (and `claudexor models` could show nothing beyond that list), so a new vendor model needed a Claudexor release to become usable through them (#338, #340). `validateModel` now takes the list, its source and the declaration with no defaults; the manifest branches of the run gate and the reviewer panel read the declaration; one registry gate (`checkHarnessModel`) replaces the four hand-built copies in the settings write, doctor readiness and the capability catalog.

  Claude, Codex and Cursor declare `advisory` (cursor gains the declaration here; claude's producer lands beside it): their lists prove presence, never absence, so an unlisted explicit model is persisted or forwarded byte-identical and the vendor decides. Each admitting consumer says so once: the settings read-back carries server-owned `notes` (the CLI prints them), the readiness row carries the note in its detail (the text `doctor` prints it too), the per-spawn gate keeps its status event; the agent capability catalog's `configuredModelValid` stays a boolean that reports such an admission as valid without the note (its description says so). raw-api, agy and opencode stay authoritative; the automatic reviewer panel keeps skipping an unlisted family at zero cost; HTTP model operations stay strict against the account catalog read at a named client version. Refusals state observations (which account supplied which list, how many models) instead of guessing a cause such as re-authentication.

  Invariants: INV-104 amended with the owner's approval of 2026-09-24 (CONCEPT-CHANGE): absence is a per-harness declaration honoured on live and manifest lists alike; the settings-write-strict canary moves to agy and `[INV-104:settings-write-advisory]` pins the codex path. INV-105 unchanged (the per-spawn disclosure stays). INV-020/INV-022 hold: `notes` has a producer (the settings write) and readers (the CLI, the canary).

### Patch Changes

- 2c024ac: Claude models are discovered from the installed binary instead of a shipped list (#338, #340).

  The claude adapter gains a live `models()`: the prompt-free `initialize` handshake of the installed `claude` binary (one stdin frame, exit on EOF, never `--model`, `--setting-sources ""`, `--strict-mcp-config`, model-override env scrubbed) answers the picker's selectors with their vendor-reported resolutions; the rows travel as `origin: live` with `resolved_model`, followed by the frozen `CLAUDE_KNOWN_MODELS` ids as `origin: hint` so presence never shrinks below the manifest. A `config_dir_login` profile is probed under its own config dir and keychain bridge, an `api_key`/`oauth_token` profile with its own credential in the env var its runs use under a scratch HOME (the account's own rows in `?view=accounts`, cache keyed by profile id, never by a secret); the unscoped listing is a credential-free binary probe under a scratch HOME with non-essential traffic off. The answer is total: a missing or failing binary yields the hint rows and the registry reports `source: manifest` with the frozen `verifiedAgainst` stamp rather than a live claim. One cached single-flight capture per (scope, binary identity) lives an hour (a minute for failures); `harnessBinaryIdentity` in core keys it and the `--help` effort memo by realpath, inode, size and mtime, so an in-place CLI update is re-read without a daemon restart; a run whose env patch carries a PATH has its effort ladder, readonly flag set and `--version` read from the binary that PATH selects. The manifest declares `model_inventory_absence: "advisory"` and freezes `known_models_verified_against` at the literal 2.1.261. `HarnessModel` gains optional `origin` and `resolved_model` (absent = live; producers that predate the field need no change); `claudexor models` prints resolutions and hint marks.

  Invariants: INV-104 governs the declaration (amended in the sibling commit); INV-020/INV-022 hold (both new fields have a producer and readers).

- Updated dependencies [2c024ac]
- Updated dependencies [7e615b6]
- Updated dependencies [fb42a94]
  - @claudexor/schema@3.14.0
  - @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/schema@3.13.0
- @claudexor/util@3.13.0

## 3.12.10

### Patch Changes

- A run's failure record carries the vendor's own failure code beside its words.

  When a Codex turn fails, `codex exec --json` delivers only the vendor's sentence, while Codex's own rollout record of the same thread keeps a machine-readable code (a capacity refusal is `server_overloaded`). Claudexor labelled such a run a process crash, advised that the harness process crashed, and reported the configured retry ceiling as if two retries had run.

  `RunFailure` gains one optional, nullable object, `vendorFailure: { code, message, source }`: the vendor's code and words, read fail-soft from the rollout after the process exited, bound to the current turn, `null` on any doubt and for every harness without such a channel. The code is opaque evidence: nothing in Claudexor branches on its value, and it is not a member of `RunFailureCode`.

  The shared run loop records a typed terminal fact, `harness_reported_error`, only when the harness's own stdout frames produced an error event. A harness that voiced its own error and then exited non-zero is classified `unknown_harness_error` with an explicit `retryable: false` instead of `process_crash`; a signal kill, a spawn failure and a silent non-zero exit keep their labels. Retry, rotation, cooldown and credential condemnation read exactly the inputs they read before. `route.transient.exhausted` reports the observed retries beside the configured maximum.

  Invariants: none amended. INV-013, INV-046 and INV-049 hold (typed adapter evidence, no prose governance); INV-104's disclosed residual stays literally true, and the new field is additive evidence beside it. INV-020 and INV-022 hold: the schema field ships with its producer (the Codex adapter and the terminal writers) and its consumers (the failure record and the CLI inspect line). The app compatibility floor is unchanged.

- Updated dependencies
  - @claudexor/schema@3.12.10
  - @claudexor/util@3.12.10

## 3.12.9

### Patch Changes

- 125aea9: A Codex model list that omits a model no longer refuses a run that asks for it.

  The vendor CLI fetches its model list remotely and falls back to a bundled default list when that fetch times out, and nothing on the wire says which list answered. Claudexor treated the answer as account truth, so an explicit model the list lacked was refused before dispatch, in under a second, as an untyped failure. Observed live: `gpt-6-astra` was refused 32 times over two days on thirteen accounts that ran it successfully 262 times in the same window, and an empty answer refused the same way.

  A harness now declares what its live inventory proves. The new optional manifest capability `model_inventory_absence` defaults to `authoritative`, which is today's strict behaviour for every harness; Codex declares `advisory`, because its list can prove a model is present but never that one is absent. On an advisory source a missing (or empty) list stops being a refusal: the explicit model is forwarded to the vendor exactly as asked, the vendor accepts or refuses it, and the per-spawn gate discloses once, in the run's events, that the model was not listed. The same decision now serves the explicit reviewer panel, so an owner-chosen reviewer model is no longer refused by a stale list either.

  Nothing else moved. Manifest truth stays strict and is never substituted to admit a model, settings writes and the doctor's configured-model check still read the manifest and still refuse, automatic reviewer selection still skips an unlisted family at zero cost, authenticated account catalog operations still return a typed `model_unavailable`, pinned accounts still never rotate, and the probe cache and its TTL are unchanged.

  Three consequences are worth stating plainly. The explicit reviewer panel forwards an unlisted model without the run-event disclosure, because a reviewer spawn does not pass through the per-spawn gate. A vendor CLI that refuses a forwarded model reports it as an ordinary error carrying the vendor's own text, not as a typed model failure (only the HTTP model operations are typed, and those stay strict). And a mistyped model name on such a harness now costs one spawn at the vendor instead of failing for free at the gate.

  Invariants: INV-104 is amended with the owner's explicit approval of 2026-09-21 — strict wherever the truth source can prove absence, forward and disclose where it cannot, and never substitute one list for another. INV-105 follows from it: an explicit model can now reach a route its truth source could not vouch for, and the run discloses that instead of staying silent. INV-020 (schema first, regenerate, then consumers) and INV-022 (a field ships with its producer and consumer) hold: the capability is declared by the Codex manifest and read by the model gate and the reviewer panel in this change. The app compatibility floor is unchanged.

- Updated dependencies [125aea9]
  - @claudexor/schema@3.12.9
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- @claudexor/schema@3.12.8
- @claudexor/util@3.12.8

## 3.12.7

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.7
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- @claudexor/schema@3.12.6
- @claudexor/util@3.12.6

## 3.12.5

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.5
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- @claudexor/schema@3.12.4
- @claudexor/util@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/schema@3.12.3
- @claudexor/util@3.12.3

## 3.12.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.2
  - @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.1
  - @claudexor/util@3.12.1

## 3.12.0

### Patch Changes

- Updated dependencies [217d53f]
  - @claudexor/schema@3.12.0
  - @claudexor/util@3.12.0

## 3.11.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.11.0
  - @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- @claudexor/schema@3.10.5
- @claudexor/util@3.10.5

## 3.10.4

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.4
  - @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- @claudexor/schema@3.10.3
- @claudexor/util@3.10.3

## 3.10.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.2
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- Bind Windows interactive-login child standard handles to ConPTY instead of inherited parent pipes, with console-input and exact submitted-input checks.
- Updated dependencies
  - @claudexor/schema@3.10.1
  - @claudexor/util@3.10.1

## 3.10.0

### Minor Changes

- Add caller-owned Codex model operations through managed accounts shared with Agents, with exact model payloads, durable single-generation identity, result acknowledgement and typed outcome/cost evidence. Keep system prompts, conversation history and tool execution with the caller. Preserve unconfirmed setup termination during runtime replacement; a pre-permit failure without recorded process evidence remains unreconcilable and is disclosed rather than introducing a new journal format. Simplify contributor release review while retaining signed runtime manifests and exact candidate promotion.

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.0
  - @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.8
  - @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/schema@3.9.7
- @claudexor/util@3.9.7

## 3.9.6

### Patch Changes

- @claudexor/schema@3.9.6
- @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- @claudexor/schema@3.9.5
- @claudexor/util@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/schema@3.9.4
- @claudexor/util@3.9.4

## 3.9.3

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.3
  - @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- @claudexor/schema@3.9.2
- @claudexor/util@3.9.2

## 3.9.1

### Patch Changes

- @claudexor/schema@3.9.1
- @claudexor/util@3.9.1

## 3.9.0

### Patch Changes

- Updated dependencies [d9cccac]
- Updated dependencies [69500f8]
- Updated dependencies [e39c57b]
- Updated dependencies [fd623ff]
- Updated dependencies [278e436]
  - @claudexor/schema@3.9.0
  - @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- @claudexor/schema@3.8.4
- @claudexor/util@3.8.4

## 3.8.3

### Patch Changes

- @claudexor/schema@3.8.3
- @claudexor/util@3.8.3

## 3.8.2

### Patch Changes

- @claudexor/schema@3.8.2
- @claudexor/util@3.8.2

## 3.8.1

### Patch Changes

- ce6dba1: Prepare an isolated macOS keychain inside each Antigravity credential profile before vendor probes, quota reads, logins, and runs. The vendor's existing file fallback and profile separation remain unchanged.
- 2794ec7: Remove the engine-owned outer Seatbelt wrapper and restore each harness's
  native access policy. Delegated mutating runs now keep stable project identity
  separate from their disposable execution workspace, active requests use
  `readonly`, `workspace_write`, or explicitly trusted `full`, and historical
  outer-confinement artifacts remain readable without enabling new retired-mode
  runs.
- Updated dependencies [ce6dba1]
- Updated dependencies [2794ec7]
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1

## 3.8.0

### Patch Changes

- 6054b7d: Make credential-profile custody and managed setup login platform-aware, with an exact Windows Antigravity one-binding policy, vendor-proven doctor/quota results, durable ambiguity handling, and host-resolved terminal capability projection.
- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

- @claudexor/schema@3.7.0
- @claudexor/util@3.7.0

## 3.6.0

### Patch Changes

- Updated dependencies [895967f]
  - @claudexor/schema@3.6.0
  - @claudexor/util@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0
  - @claudexor/schema@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/schema@3.4.2
- @claudexor/util@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/schema@3.4.1
- @claudexor/util@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/schema@3.4.0
- @claudexor/util@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/schema@3.3.16
- @claudexor/util@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/schema@3.3.15
- @claudexor/util@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/schema@3.3.14
- @claudexor/util@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/schema@3.3.13
- @claudexor/util@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/schema@3.3.12
- @claudexor/util@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/schema@3.3.0
- @claudexor/util@3.3.0

## 3.2.1

### Patch Changes

- @claudexor/schema@3.2.1
- @claudexor/util@3.2.1

## 3.2.0

### Patch Changes

- Reset inactivity only for useful agent progress, normalize retry metadata, and harden process spawning without weakening cancellation ownership.
- The remote-runtime vendor PATH prefix (`~/.claudexor/remote/vendor/bin`) is probed only when the remote runtime marker is set; local runtimes never see it.
- @claudexor/schema@3.2.0
- @claudexor/util@3.2.0

## 3.1.2

### Patch Changes

- Restore Delegate in packaged installs through the exact daemon self-entry; enforce required MCP startup, bounded shared parent/child budget and cancellation authority, typed lineage and degradation receipts, and durable CLI/macOS projections across reload and reconnect.
- Updated dependencies
  - @claudexor/schema@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Engine honesty fixes: a delivered plan now survives an unrecovered tool error
  instead of being escalated to a harness error before finalization, an empty
  thrown message can no longer terminalize a failed harness run as a clean
  success, and the automatic economy-ranking pass reads one pinned clock for all
  candidates instead of a fresh timestamp per comparison.
- Updated dependencies
  - @claudexor/schema@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Patch Changes

- 6e36993: Doctor and discover now explain WHY the codex CLI failed to resolve when the filesystem still holds evidence of an install: a dangling Homebrew symlink, a stripped exec bit, a directory shadowing the name, or a Caskroom/Cellar registration whose payload vanished — each with the exact `brew reinstall [--cask]` remediation. Diagnostic only: never gates a run, never executes a package manager. The codex doctor probes and diagnoses in the same scoped environment.
- Updated dependencies [c3b7ece]
  - @claudexor/schema@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/schema@3.0.3
- @claudexor/util@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/schema@3.0.0
- @claudexor/util@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/schema@2.1.3
- @claudexor/util@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/schema@2.1.2
- @claudexor/util@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/schema@2.1.1
- @claudexor/util@2.1.1

## 2.1.0

### Minor Changes

- Claudexor 2.1.0: credential profiles (INV-135). Multiple subscriptions per
  harness with isolated vendor config dirs and namespaced secret slots; strict
  per-turn / thread-sticky selection with profile-isolated native-session
  resume; per-profile doctor probes and proactive per-profile subscription
  quota from the vendor oauth/usage endpoint; one typed profile policy per
  harness with provenance-recorded rotation on typed vendor-limit evidence
  only. Includes the unpublished 2.0.1 honest-engine and 2.0.2 simple-UI
  passes.

### Patch Changes

- 0fc050b: Credential profiles (INV-135): durable non-secret `credential_profiles`
  registry in the global config; the orchestrator resolves an explicit per-run
  profile id ONCE and stamps the typed profile on every HarnessRunSpec; adapters
  consume exactly the profile's transport (claude config-dir login / non-bare
  token / key; codex scoped CODEX_HOME / scoped auth.json; cursor, opencode,
  raw-api secret-ref keys) or refuse typed — never a fallback to default
  credentials. Namespaced secret slots (`claude_oauth:<profile>`), per-profile
  doctor probes (`GET /credential-profiles`, `claudexor profiles`), interactive
  `claudexor profiles login`, profile-stamped route evidence, and
  profile-isolated native-session resume.
- Updated dependencies
- Updated dependencies [0fc050b]
  - @claudexor/schema@2.1.0
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/schema@2.0.2
- @claudexor/util@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/schema@2.0.1
- @claudexor/util@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/schema@2.0.0
- @claudexor/util@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Stabilize the checkpoint release with explicit reviewer-panel hardening, mandatory
  review evidence preflight, scoped Cursor reviewer readiness, frozen SpecPack gate
  merging, protected-path approvals, and thin control/macOS projection parity.
- Updated dependencies
  - @claudexor/schema@0.14.1

## 0.14.0

### Patch Changes

- @claudexor/schema@0.14.0

## 0.13.3

### Patch Changes

- @claudexor/schema@0.13.3

## 0.12.1

### Patch Changes

- @claudexor/schema@0.12.1
