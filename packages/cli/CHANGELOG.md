# @claudexor/cli

## 3.17.0

### Patch Changes

- Updated dependencies [092ec2b]
- Updated dependencies [951489f]
  - @claudexor/core@3.17.0
  - @claudexor/harness-claude@3.17.0
  - @claudexor/control-api@3.17.0
  - @claudexor/daemon@3.17.0
  - @claudexor/schema@3.17.0
  - @claudexor/delivery@3.17.0
  - @claudexor/gateway@3.17.0
  - @claudexor/harness-agy@3.17.0
  - @claudexor/harness-codex@3.17.0
  - @claudexor/harness-cursor@3.17.0
  - @claudexor/harness-fake@3.17.0
  - @claudexor/harness-opencode@3.17.0
  - @claudexor/harness-raw-api@3.17.0
  - @claudexor/orchestrator@3.17.0
  - @claudexor/review@3.17.0
  - @claudexor/workspace@3.17.0
  - @claudexor/acp-server@3.17.0
  - @claudexor/config@3.17.0
  - @claudexor/mcp-server@3.17.0
  - @claudexor/artifact-store@3.17.0
  - @claudexor/journal@3.17.0
  - @claudexor/secrets@3.17.0
  - @claudexor/util@3.17.0

## 3.16.0

### Minor Changes

- 788ddca: Add `POST /v2/runs/:id/messages`: a live message into a running run's active attempt with journal-first admission, typed outcomes (delivered, accepted, rejected, not_active, unsupported, delivery_unknown) plus reasons, and a key-required idempotent receipt. Each harness declares its live-input channel as `capability_profile.live_input`, projected as `liveInput` in the agent-capability catalog.

### Patch Changes

- Updated dependencies [de234bd]
- Updated dependencies [788ddca]
  - @claudexor/harness-codex@3.16.0
  - @claudexor/schema@3.16.0
  - @claudexor/control-api@3.16.0
  - @claudexor/daemon@3.16.0
  - @claudexor/orchestrator@3.16.0
  - @claudexor/acp-server@3.16.0
  - @claudexor/config@3.16.0
  - @claudexor/core@3.16.0
  - @claudexor/delivery@3.16.0
  - @claudexor/gateway@3.16.0
  - @claudexor/harness-agy@3.16.0
  - @claudexor/harness-claude@3.16.0
  - @claudexor/harness-cursor@3.16.0
  - @claudexor/harness-fake@3.16.0
  - @claudexor/harness-opencode@3.16.0
  - @claudexor/harness-raw-api@3.16.0
  - @claudexor/mcp-server@3.16.0
  - @claudexor/review@3.16.0
  - @claudexor/workspace@3.16.0
  - @claudexor/artifact-store@3.16.0
  - @claudexor/journal@3.16.0
  - @claudexor/secrets@3.16.0
  - @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- On Windows the CLI exits with the status its command returned instead of aborting natively after printing valid output, and the Windows install smoke no longer trusts `claudexor doctor --json` output without checking its exit.

  The shared CLI exit path (`exitAfterOutputFlush` in `cli-io.ts`) still waits for stdout and stderr to drain, so large JSON projections are not truncated. On Windows it then sets `process.exitCode` and lets Node exit naturally: a forced `process.exit()` after `doctor`'s `fetch()` raced isolate teardown on Node 24.16, and libuv aborted with `UV_HANDLE_CLOSING` (0xC0000409, nodejs/node#56645; upstream fix nodejs/node#61999) after the JSON was already written. An unref'd one-second backstop still forces the exit when a stray handle keeps the loop alive. Linux and macOS keep the immediate exit. `scripts/windows-local-install-smoke.mjs` now fails when `doctor --json` exits non-zero or by signal before it reads the JSON, and the Windows CI lane runs the exit-path regression (`packages/cli/src/cli-io.test.ts`).
  - @claudexor/acp-server@3.15.1
  - @claudexor/artifact-store@3.15.1
  - @claudexor/config@3.15.1
  - @claudexor/control-api@3.15.1
  - @claudexor/core@3.15.1
  - @claudexor/daemon@3.15.1
  - @claudexor/delivery@3.15.1
  - @claudexor/gateway@3.15.1
  - @claudexor/harness-agy@3.15.1
  - @claudexor/harness-claude@3.15.1
  - @claudexor/harness-codex@3.15.1
  - @claudexor/harness-cursor@3.15.1
  - @claudexor/harness-fake@3.15.1
  - @claudexor/harness-opencode@3.15.1
  - @claudexor/harness-raw-api@3.15.1
  - @claudexor/journal@3.15.1
  - @claudexor/mcp-server@3.15.1
  - @claudexor/orchestrator@3.15.1
  - @claudexor/review@3.15.1
  - @claudexor/schema@3.15.1
  - @claudexor/secrets@3.15.1
  - @claudexor/util@3.15.1
  - @claudexor/workspace@3.15.1

## 3.15.0

### Minor Changes

- 3bc8af4: `claudexor harness install codex --target local` works on Windows, and doctor, login and runs resolve the image it installs.

  On Windows an npm global prefix holds only `.cmd`/sh/ps1 shims and no executable image, and Claudexor never spawns a harness through a shell (issue #191). The local target is therefore supported exactly where the pinned package yields a verified package-native image: `@openai/codex` resolves its `@openai/codex-win32-<arch>` platform package and executes `vendor/<triple>/bin/codex.exe`. Core's `runtime-env.ts` becomes the one owner of that layout (`npmGlobalPackagesDir`, `embeddedNpmCli`, `windowsNativeImageDir`, `managedWindowsNativeImageDirs`): the installer runs the embedded `node_modules/npm/bin/npm-cli.js` beside `node.exe`, forwards the Windows process-environment keys, anchors the managed root on the same `HOME` the harness PATH producer reads, and proves the image inside the prefix; the normalized harness PATH carries that image dir on win32 so every local surface resolves the same `codex.exe` by bare name. The receipt fields are unchanged. Claude, OpenCode, Cursor and Antigravity keep a typed `unsupported_platform` refusal on the Windows local target, now naming the exact reason; an unsupported architecture refuses the same way. The Windows CI lane installs the real pinned package on the exact embedded Node with no ambient node/npm and an isolated profile, then checks the receipt, direct and by-name `--version`, the idempotent recheck and `doctor --json` (`scripts/windows-local-install-smoke.mjs`). Linux and macOS behaviour is unchanged.

  Invariants: INV-067 (the same scoped env that spawns a run resolves the binary), INV-121/INV-122 (one layout owner reused by proof and PATH), INV-044 (typed refusals, no silent shim). No Bible change.

### Patch Changes

- Updated dependencies [3bc8af4]
  - @claudexor/core@3.15.0
  - @claudexor/daemon@3.15.0
  - @claudexor/delivery@3.15.0
  - @claudexor/gateway@3.15.0
  - @claudexor/harness-agy@3.15.0
  - @claudexor/harness-claude@3.15.0
  - @claudexor/harness-codex@3.15.0
  - @claudexor/harness-cursor@3.15.0
  - @claudexor/harness-fake@3.15.0
  - @claudexor/harness-opencode@3.15.0
  - @claudexor/harness-raw-api@3.15.0
  - @claudexor/orchestrator@3.15.0
  - @claudexor/review@3.15.0
  - @claudexor/workspace@3.15.0
  - @claudexor/control-api@3.15.0
  - @claudexor/acp-server@3.15.0
  - @claudexor/artifact-store@3.15.0
  - @claudexor/config@3.15.0
  - @claudexor/journal@3.15.0
  - @claudexor/mcp-server@3.15.0
  - @claudexor/schema@3.15.0
  - @claudexor/secrets@3.15.0
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

- 7e615b6: The Codex HTTP model transport declares its own verified client version when it reads an account's model catalog, instead of the managed-installer pin.

  The Codex backend filters `GET /backend-api/codex/models` by the `client_version` the caller declares: a model is listed only for clients at or above that model's minimum version. Claudexor's raw model transport sent the installer pin (`CODEX_VENDOR_CLI_VERSION`, 0.153.3), so a newly floored model such as `gpt-6-sol` was absent from the catalog and refused as `model_unavailable`, while the same account and the same request shape generated with it (issue #339). A release that only moved the installer therefore decided which models an account could see through this route.

  `CODEX_HTTP_CLIENT_VERSION` (0.156.1) is the version this release's catalog parser and Responses projection were verified against; it is raised to the installed Codex CLI's version when that is newer, never lowered, and an unparseable version falls back to the constant because the parameter is required. The value is memoised per binary identity, so an in-place CLI upgrade is seen on the next catalog read. The negotiated account view (`?view=accounts`) carries `clientVersion` and `clientVersionSource` per catalog (`verified_transport` or `installed_cli`; null for catalogs from an older engine) while the legacy `GET /model-sources/:id/models` keeps its pre-existing shape, and both membership refusals — account selection and invocation — name the declared version so a miss is not read as an account or login problem. The catalog stays strict: its rows are the request contract (efforts, service tiers, windows). A recorded fixture pair (`fixtures/models-http-0.153.3.json`, `models-http-0.156.1.json`) pins that every row present at both versions is identical and only `gpt-6-sol`/`gpt-6-luna` were added, with the default unchanged; bumping the constant re-records the pair.

  Invariants: INV-104 is unchanged (HTTP model operations stay strict against the account catalog, now read at a named client version). INV-020/INV-022 hold: the two schema fields are produced by the transport, read by both membership refusals (`describeCodexClientVersion`) and returned on the account-view wire. The managed installer pin keeps its two other meanings (install target, fixture/effort-snapshot stamp).

- Updated dependencies [2c024ac]
- Updated dependencies [7e615b6]
- Updated dependencies [fb42a94]
- Updated dependencies [7ab3c95]
  - @claudexor/harness-claude@3.14.0
  - @claudexor/core@3.14.0
  - @claudexor/schema@3.14.0
  - @claudexor/harness-codex@3.14.0
  - @claudexor/gateway@3.14.0
  - @claudexor/orchestrator@3.14.0
  - @claudexor/harness-cursor@3.14.0
  - @claudexor/daemon@3.14.0
  - @claudexor/delivery@3.14.0
  - @claudexor/harness-agy@3.14.0
  - @claudexor/harness-fake@3.14.0
  - @claudexor/harness-opencode@3.14.0
  - @claudexor/harness-raw-api@3.14.0
  - @claudexor/review@3.14.0
  - @claudexor/workspace@3.14.0
  - @claudexor/acp-server@3.14.0
  - @claudexor/config@3.14.0
  - @claudexor/control-api@3.14.0
  - @claudexor/mcp-server@3.14.0
  - @claudexor/artifact-store@3.14.0
  - @claudexor/journal@3.14.0
  - @claudexor/secrets@3.14.0
  - @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/acp-server@3.13.0
- @claudexor/artifact-store@3.13.0
- @claudexor/config@3.13.0
- @claudexor/control-api@3.13.0
- @claudexor/core@3.13.0
- @claudexor/daemon@3.13.0
- @claudexor/delivery@3.13.0
- @claudexor/gateway@3.13.0
- @claudexor/harness-agy@3.13.0
- @claudexor/harness-claude@3.13.0
- @claudexor/harness-codex@3.13.0
- @claudexor/harness-cursor@3.13.0
- @claudexor/harness-fake@3.13.0
- @claudexor/harness-opencode@3.13.0
- @claudexor/harness-raw-api@3.13.0
- @claudexor/journal@3.13.0
- @claudexor/mcp-server@3.13.0
- @claudexor/orchestrator@3.13.0
- @claudexor/review@3.13.0
- @claudexor/schema@3.13.0
- @claudexor/secrets@3.13.0
- @claudexor/util@3.13.0
- @claudexor/workspace@3.13.0

## 3.12.10

### Patch Changes

- A run's failure record carries the vendor's own failure code beside its words.

  When a Codex turn fails, `codex exec --json` delivers only the vendor's sentence, while Codex's own rollout record of the same thread keeps a machine-readable code (a capacity refusal is `server_overloaded`). Claudexor labelled such a run a process crash, advised that the harness process crashed, and reported the configured retry ceiling as if two retries had run.

  `RunFailure` gains one optional, nullable object, `vendorFailure: { code, message, source }`: the vendor's code and words, read fail-soft from the rollout after the process exited, bound to the current turn, `null` on any doubt and for every harness without such a channel. The code is opaque evidence: nothing in Claudexor branches on its value, and it is not a member of `RunFailureCode`.

  The shared run loop records a typed terminal fact, `harness_reported_error`, only when the harness's own stdout frames produced an error event. A harness that voiced its own error and then exited non-zero is classified `unknown_harness_error` with an explicit `retryable: false` instead of `process_crash`; a signal kill, a spawn failure and a silent non-zero exit keep their labels. Retry, rotation, cooldown and credential condemnation read exactly the inputs they read before. `route.transient.exhausted` reports the observed retries beside the configured maximum.

  Invariants: none amended. INV-013, INV-046 and INV-049 hold (typed adapter evidence, no prose governance); INV-104's disclosed residual stays literally true, and the new field is additive evidence beside it. INV-020 and INV-022 hold: the schema field ships with its producer (the Codex adapter and the terminal writers) and its consumers (the failure record and the CLI inspect line). The app compatibility floor is unchanged.

- Updated dependencies
  - @claudexor/schema@3.12.10
  - @claudexor/core@3.12.10
  - @claudexor/orchestrator@3.12.10
  - @claudexor/harness-codex@3.12.10
  - @claudexor/acp-server@3.12.10
  - @claudexor/config@3.12.10
  - @claudexor/control-api@3.12.10
  - @claudexor/daemon@3.12.10
  - @claudexor/delivery@3.12.10
  - @claudexor/gateway@3.12.10
  - @claudexor/harness-agy@3.12.10
  - @claudexor/harness-claude@3.12.10
  - @claudexor/harness-cursor@3.12.10
  - @claudexor/harness-fake@3.12.10
  - @claudexor/harness-opencode@3.12.10
  - @claudexor/harness-raw-api@3.12.10
  - @claudexor/mcp-server@3.12.10
  - @claudexor/review@3.12.10
  - @claudexor/workspace@3.12.10
  - @claudexor/artifact-store@3.12.10
  - @claudexor/journal@3.12.10
  - @claudexor/secrets@3.12.10
  - @claudexor/util@3.12.10

## 3.12.9

### Patch Changes

- Updated dependencies [125aea9]
  - @claudexor/schema@3.12.9
  - @claudexor/core@3.12.9
  - @claudexor/orchestrator@3.12.9
  - @claudexor/harness-codex@3.12.9
  - @claudexor/acp-server@3.12.9
  - @claudexor/config@3.12.9
  - @claudexor/control-api@3.12.9
  - @claudexor/daemon@3.12.9
  - @claudexor/delivery@3.12.9
  - @claudexor/gateway@3.12.9
  - @claudexor/harness-agy@3.12.9
  - @claudexor/harness-claude@3.12.9
  - @claudexor/harness-cursor@3.12.9
  - @claudexor/harness-fake@3.12.9
  - @claudexor/harness-opencode@3.12.9
  - @claudexor/harness-raw-api@3.12.9
  - @claudexor/mcp-server@3.12.9
  - @claudexor/review@3.12.9
  - @claudexor/workspace@3.12.9
  - @claudexor/artifact-store@3.12.9
  - @claudexor/journal@3.12.9
  - @claudexor/secrets@3.12.9
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- Updated dependencies
  - @claudexor/harness-codex@3.12.8
  - @claudexor/acp-server@3.12.8
  - @claudexor/artifact-store@3.12.8
  - @claudexor/config@3.12.8
  - @claudexor/control-api@3.12.8
  - @claudexor/core@3.12.8
  - @claudexor/daemon@3.12.8
  - @claudexor/delivery@3.12.8
  - @claudexor/gateway@3.12.8
  - @claudexor/harness-agy@3.12.8
  - @claudexor/harness-claude@3.12.8
  - @claudexor/harness-cursor@3.12.8
  - @claudexor/harness-fake@3.12.8
  - @claudexor/harness-opencode@3.12.8
  - @claudexor/harness-raw-api@3.12.8
  - @claudexor/journal@3.12.8
  - @claudexor/mcp-server@3.12.8
  - @claudexor/orchestrator@3.12.8
  - @claudexor/review@3.12.8
  - @claudexor/schema@3.12.8
  - @claudexor/secrets@3.12.8
  - @claudexor/util@3.12.8
  - @claudexor/workspace@3.12.8

## 3.12.7

### Patch Changes

- Restore adapter-created nulls for optional review fields before original-schema validation, preserving the caller contract and substantive findings. Codex Responses failure evidence now records monotonic chunk timing and deterministic interrupted-stream diagnostics without adding automatic retries.
- Updated dependencies
  - @claudexor/harness-codex@3.12.7
  - @claudexor/orchestrator@3.12.7
  - @claudexor/schema@3.12.7
  - @claudexor/acp-server@3.12.7
  - @claudexor/config@3.12.7
  - @claudexor/control-api@3.12.7
  - @claudexor/core@3.12.7
  - @claudexor/daemon@3.12.7
  - @claudexor/delivery@3.12.7
  - @claudexor/gateway@3.12.7
  - @claudexor/harness-agy@3.12.7
  - @claudexor/harness-claude@3.12.7
  - @claudexor/harness-cursor@3.12.7
  - @claudexor/harness-fake@3.12.7
  - @claudexor/harness-opencode@3.12.7
  - @claudexor/harness-raw-api@3.12.7
  - @claudexor/mcp-server@3.12.7
  - @claudexor/review@3.12.7
  - @claudexor/workspace@3.12.7
  - @claudexor/artifact-store@3.12.7
  - @claudexor/journal@3.12.7
  - @claudexor/secrets@3.12.7
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- Updated dependencies
  - @claudexor/harness-codex@3.12.6
  - @claudexor/acp-server@3.12.6
  - @claudexor/artifact-store@3.12.6
  - @claudexor/config@3.12.6
  - @claudexor/control-api@3.12.6
  - @claudexor/core@3.12.6
  - @claudexor/daemon@3.12.6
  - @claudexor/delivery@3.12.6
  - @claudexor/gateway@3.12.6
  - @claudexor/harness-agy@3.12.6
  - @claudexor/harness-claude@3.12.6
  - @claudexor/harness-cursor@3.12.6
  - @claudexor/harness-fake@3.12.6
  - @claudexor/harness-opencode@3.12.6
  - @claudexor/harness-raw-api@3.12.6
  - @claudexor/journal@3.12.6
  - @claudexor/mcp-server@3.12.6
  - @claudexor/orchestrator@3.12.6
  - @claudexor/review@3.12.6
  - @claudexor/schema@3.12.6
  - @claudexor/secrets@3.12.6
  - @claudexor/util@3.12.6
  - @claudexor/workspace@3.12.6

## 3.12.5

### Patch Changes

- State a served-model mismatch on a model operation as the typed `modelMismatch` result fact without changing its outcome, rank an account that recently answered a model's request with a different model after the other selectable accounts for later Auto selections (a 30-minute in-memory observation that never excludes an account, a pin or a preferred account), and send a turn the same account served with another model through its canonical content and tool calls instead of refusing the next request with `invalid_continuation`.
- Updated dependencies
  - @claudexor/schema@3.12.5
  - @claudexor/harness-codex@3.12.5
  - @claudexor/daemon@3.12.5
  - @claudexor/orchestrator@3.12.5
  - @claudexor/acp-server@3.12.5
  - @claudexor/config@3.12.5
  - @claudexor/control-api@3.12.5
  - @claudexor/core@3.12.5
  - @claudexor/delivery@3.12.5
  - @claudexor/gateway@3.12.5
  - @claudexor/harness-agy@3.12.5
  - @claudexor/harness-claude@3.12.5
  - @claudexor/harness-cursor@3.12.5
  - @claudexor/harness-fake@3.12.5
  - @claudexor/harness-opencode@3.12.5
  - @claudexor/harness-raw-api@3.12.5
  - @claudexor/mcp-server@3.12.5
  - @claudexor/review@3.12.5
  - @claudexor/workspace@3.12.5
  - @claudexor/artifact-store@3.12.5
  - @claudexor/journal@3.12.5
  - @claudexor/secrets@3.12.5
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- 67c7a71: Use the shared harness environment for Codex model discovery and quota probes so GUI-launched installs can find the same CLI and Node runtime as sign-in and agent execution.
- Updated dependencies [67c7a71]
  - @claudexor/harness-codex@3.12.4
  - @claudexor/acp-server@3.12.4
  - @claudexor/artifact-store@3.12.4
  - @claudexor/config@3.12.4
  - @claudexor/control-api@3.12.4
  - @claudexor/core@3.12.4
  - @claudexor/daemon@3.12.4
  - @claudexor/delivery@3.12.4
  - @claudexor/gateway@3.12.4
  - @claudexor/harness-agy@3.12.4
  - @claudexor/harness-claude@3.12.4
  - @claudexor/harness-cursor@3.12.4
  - @claudexor/harness-fake@3.12.4
  - @claudexor/harness-opencode@3.12.4
  - @claudexor/harness-raw-api@3.12.4
  - @claudexor/journal@3.12.4
  - @claudexor/mcp-server@3.12.4
  - @claudexor/orchestrator@3.12.4
  - @claudexor/review@3.12.4
  - @claudexor/schema@3.12.4
  - @claudexor/secrets@3.12.4
  - @claudexor/util@3.12.4
  - @claudexor/workspace@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/acp-server@3.12.3
- @claudexor/artifact-store@3.12.3
- @claudexor/config@3.12.3
- @claudexor/control-api@3.12.3
- @claudexor/core@3.12.3
- @claudexor/daemon@3.12.3
- @claudexor/delivery@3.12.3
- @claudexor/gateway@3.12.3
- @claudexor/harness-agy@3.12.3
- @claudexor/harness-claude@3.12.3
- @claudexor/harness-codex@3.12.3
- @claudexor/harness-cursor@3.12.3
- @claudexor/harness-fake@3.12.3
- @claudexor/harness-opencode@3.12.3
- @claudexor/harness-raw-api@3.12.3
- @claudexor/journal@3.12.3
- @claudexor/mcp-server@3.12.3
- @claudexor/orchestrator@3.12.3
- @claudexor/review@3.12.3
- @claudexor/schema@3.12.3
- @claudexor/secrets@3.12.3
- @claudexor/util@3.12.3
- @claudexor/workspace@3.12.3

## 3.12.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.2
  - @claudexor/acp-server@3.12.2
  - @claudexor/config@3.12.2
  - @claudexor/control-api@3.12.2
  - @claudexor/core@3.12.2
  - @claudexor/daemon@3.12.2
  - @claudexor/delivery@3.12.2
  - @claudexor/gateway@3.12.2
  - @claudexor/harness-agy@3.12.2
  - @claudexor/harness-claude@3.12.2
  - @claudexor/harness-codex@3.12.2
  - @claudexor/harness-cursor@3.12.2
  - @claudexor/harness-fake@3.12.2
  - @claudexor/harness-opencode@3.12.2
  - @claudexor/harness-raw-api@3.12.2
  - @claudexor/mcp-server@3.12.2
  - @claudexor/orchestrator@3.12.2
  - @claudexor/review@3.12.2
  - @claudexor/workspace@3.12.2
  - @claudexor/artifact-store@3.12.2
  - @claudexor/journal@3.12.2
  - @claudexor/secrets@3.12.2
  - @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- Updated dependencies
  - @claudexor/daemon@3.12.1
  - @claudexor/control-api@3.12.1
  - @claudexor/schema@3.12.1
  - @claudexor/acp-server@3.12.1
  - @claudexor/config@3.12.1
  - @claudexor/core@3.12.1
  - @claudexor/delivery@3.12.1
  - @claudexor/gateway@3.12.1
  - @claudexor/harness-agy@3.12.1
  - @claudexor/harness-claude@3.12.1
  - @claudexor/harness-codex@3.12.1
  - @claudexor/harness-cursor@3.12.1
  - @claudexor/harness-fake@3.12.1
  - @claudexor/harness-opencode@3.12.1
  - @claudexor/harness-raw-api@3.12.1
  - @claudexor/mcp-server@3.12.1
  - @claudexor/orchestrator@3.12.1
  - @claudexor/review@3.12.1
  - @claudexor/workspace@3.12.1
  - @claudexor/artifact-store@3.12.1
  - @claudexor/journal@3.12.1
  - @claudexor/secrets@3.12.1
  - @claudexor/util@3.12.1

## 3.12.0

### Minor Changes

- 217d53f: The daemon stops writing dead history into its journal and forgets it on replay. Per-token harness deltas no longer reach the journal (the per-run event log and the live stream keep them), the journaled `run.created` carries the prompt's digest instead of its text, `command.updated` frames omit the immutable params, quota snapshots are journaled only when their evidence changes and the projection marker carries a digest, and the retained params of terminal commands are capped by a code constant. Every partition replays and compacts through the daemon's fold policy, so startup memory follows the retained state rather than the file (a resolved question and its request are forgotten together, so answering an already-resolved question after a restart reports `not_found` rather than `already_resolved` — both non-delivery statuses; within one process life `already_resolved` is unchanged); crash-GC reads project roots from the already prepared command projection instead of replaying the journal a second time, journaled run events are validated once per generation, and journal maintenance re-requests itself when the file crosses the threshold again while logging typed declines and `journal.records_retired` receipts. An engine from before this change refuses a served root loudly. A restart on an already-compacted partition no longer rewrites it to reclaim nothing, and the daemon reports its own memory (rss, heap, external) on the normal-admission line and on every maintenance receipt. Legacy `command.pruned` tombstones carry no run ids, so terminals of runs pruned before this release stay retained (none on the acceptance root); runs that never received a journaled terminal keep their pre-release progress frames until their command is pruned (then the tombstone's run_ids retire them — bounded by the 500 / 30-day / 256 MiB rule); two such runs hold about 3.1k `harness.event` frames on the acceptance root.

### Patch Changes

- Updated dependencies [217d53f]
- Updated dependencies [1b1476c]
  - @claudexor/daemon@3.12.0
  - @claudexor/schema@3.12.0
  - @claudexor/journal@3.12.0
  - @claudexor/acp-server@3.12.0
  - @claudexor/config@3.12.0
  - @claudexor/control-api@3.12.0
  - @claudexor/core@3.12.0
  - @claudexor/delivery@3.12.0
  - @claudexor/gateway@3.12.0
  - @claudexor/harness-agy@3.12.0
  - @claudexor/harness-claude@3.12.0
  - @claudexor/harness-codex@3.12.0
  - @claudexor/harness-cursor@3.12.0
  - @claudexor/harness-fake@3.12.0
  - @claudexor/harness-opencode@3.12.0
  - @claudexor/harness-raw-api@3.12.0
  - @claudexor/mcp-server@3.12.0
  - @claudexor/orchestrator@3.12.0
  - @claudexor/review@3.12.0
  - @claudexor/workspace@3.12.0
  - @claudexor/artifact-store@3.12.0
  - @claudexor/secrets@3.12.0
  - @claudexor/util@3.12.0

## 3.11.0

### Minor Changes

- Add advisory Standard, Fast and Economy processing with exact native precedence, account-scoped catalogs and honest observed service and cost evidence. Support ordinary folders through direct work or complete selected copies, retained binary file results, conflict-aware application and explicit discard.

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.11.0
  - @claudexor/acp-server@3.11.0
  - @claudexor/config@3.11.0
  - @claudexor/control-api@3.11.0
  - @claudexor/core@3.11.0
  - @claudexor/daemon@3.11.0
  - @claudexor/delivery@3.11.0
  - @claudexor/gateway@3.11.0
  - @claudexor/harness-agy@3.11.0
  - @claudexor/harness-claude@3.11.0
  - @claudexor/harness-codex@3.11.0
  - @claudexor/harness-cursor@3.11.0
  - @claudexor/harness-fake@3.11.0
  - @claudexor/harness-opencode@3.11.0
  - @claudexor/harness-raw-api@3.11.0
  - @claudexor/mcp-server@3.11.0
  - @claudexor/orchestrator@3.11.0
  - @claudexor/review@3.11.0
  - @claudexor/workspace@3.11.0
  - @claudexor/artifact-store@3.11.0
  - @claudexor/journal@3.11.0
  - @claudexor/secrets@3.11.0
  - @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- Model account selection now moves on to the next available account after any typed refusal from an account's model catalog, instead of ending the whole attempt unless the refusal was one of two named ones; an explicitly pinned account still refuses instead of rotating, and each account is tried at most once per attempt. When no account can serve the request, the reported reason is the one the accounts actually gave, so a request that failed because the catalogs were unreachable no longer says every account is out of subscription quota, and it reports no reset time. An account is recorded as busy until a given time only when the vendor itself named that reset time or retry delay.
  - @claudexor/acp-server@3.10.5
  - @claudexor/artifact-store@3.10.5
  - @claudexor/config@3.10.5
  - @claudexor/control-api@3.10.5
  - @claudexor/core@3.10.5
  - @claudexor/daemon@3.10.5
  - @claudexor/delivery@3.10.5
  - @claudexor/gateway@3.10.5
  - @claudexor/harness-agy@3.10.5
  - @claudexor/harness-claude@3.10.5
  - @claudexor/harness-codex@3.10.5
  - @claudexor/harness-cursor@3.10.5
  - @claudexor/harness-fake@3.10.5
  - @claudexor/harness-opencode@3.10.5
  - @claudexor/harness-raw-api@3.10.5
  - @claudexor/journal@3.10.5
  - @claudexor/mcp-server@3.10.5
  - @claudexor/orchestrator@3.10.5
  - @claudexor/review@3.10.5
  - @claudexor/schema@3.10.5
  - @claudexor/secrets@3.10.5
  - @claudexor/util@3.10.5
  - @claudexor/workspace@3.10.5

## 3.10.4

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.4
  - @claudexor/harness-codex@3.10.4
  - @claudexor/harness-claude@3.10.4
  - @claudexor/harness-cursor@3.10.4
  - @claudexor/orchestrator@3.10.4
  - @claudexor/control-api@3.10.4
  - @claudexor/acp-server@3.10.4
  - @claudexor/config@3.10.4
  - @claudexor/core@3.10.4
  - @claudexor/daemon@3.10.4
  - @claudexor/delivery@3.10.4
  - @claudexor/gateway@3.10.4
  - @claudexor/harness-agy@3.10.4
  - @claudexor/harness-fake@3.10.4
  - @claudexor/harness-opencode@3.10.4
  - @claudexor/harness-raw-api@3.10.4
  - @claudexor/mcp-server@3.10.4
  - @claudexor/review@3.10.4
  - @claudexor/workspace@3.10.4
  - @claudexor/artifact-store@3.10.4
  - @claudexor/journal@3.10.4
  - @claudexor/secrets@3.10.4
  - @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- Updated dependencies
  - @claudexor/harness-codex@3.10.3
  - @claudexor/acp-server@3.10.3
  - @claudexor/artifact-store@3.10.3
  - @claudexor/config@3.10.3
  - @claudexor/control-api@3.10.3
  - @claudexor/core@3.10.3
  - @claudexor/daemon@3.10.3
  - @claudexor/delivery@3.10.3
  - @claudexor/gateway@3.10.3
  - @claudexor/harness-agy@3.10.3
  - @claudexor/harness-claude@3.10.3
  - @claudexor/harness-cursor@3.10.3
  - @claudexor/harness-fake@3.10.3
  - @claudexor/harness-opencode@3.10.3
  - @claudexor/harness-raw-api@3.10.3
  - @claudexor/journal@3.10.3
  - @claudexor/mcp-server@3.10.3
  - @claudexor/orchestrator@3.10.3
  - @claudexor/review@3.10.3
  - @claudexor/schema@3.10.3
  - @claudexor/secrets@3.10.3
  - @claudexor/util@3.10.3
  - @claudexor/workspace@3.10.3

## 3.10.2

### Patch Changes

- Preserve useful contradictory Council drafts as explicitly unverified merger inputs and move journal maintenance after admission, including Windows pending-tail recovery and native coverage.
- Updated dependencies
  - @claudexor/journal@3.10.2
  - @claudexor/daemon@3.10.2
  - @claudexor/orchestrator@3.10.2
  - @claudexor/control-api@3.10.2
  - @claudexor/schema@3.10.2
  - @claudexor/acp-server@3.10.2
  - @claudexor/config@3.10.2
  - @claudexor/core@3.10.2
  - @claudexor/delivery@3.10.2
  - @claudexor/gateway@3.10.2
  - @claudexor/harness-agy@3.10.2
  - @claudexor/harness-claude@3.10.2
  - @claudexor/harness-codex@3.10.2
  - @claudexor/harness-cursor@3.10.2
  - @claudexor/harness-fake@3.10.2
  - @claudexor/harness-opencode@3.10.2
  - @claudexor/harness-raw-api@3.10.2
  - @claudexor/mcp-server@3.10.2
  - @claudexor/review@3.10.2
  - @claudexor/workspace@3.10.2
  - @claudexor/artifact-store@3.10.2
  - @claudexor/secrets@3.10.2
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- Keep Antigravity model and quota checks non-interactive by closing piped input instead of using a null device. Preserve ambiguous authentication timeouts as probe failures and expose failed refreshes alongside stale quota data.
- Updated dependencies
  - @claudexor/harness-agy@3.10.1
  - @claudexor/schema@3.10.1
  - @claudexor/acp-server@3.10.1
  - @claudexor/config@3.10.1
  - @claudexor/control-api@3.10.1
  - @claudexor/core@3.10.1
  - @claudexor/daemon@3.10.1
  - @claudexor/delivery@3.10.1
  - @claudexor/gateway@3.10.1
  - @claudexor/harness-claude@3.10.1
  - @claudexor/harness-codex@3.10.1
  - @claudexor/harness-cursor@3.10.1
  - @claudexor/harness-fake@3.10.1
  - @claudexor/harness-opencode@3.10.1
  - @claudexor/harness-raw-api@3.10.1
  - @claudexor/mcp-server@3.10.1
  - @claudexor/orchestrator@3.10.1
  - @claudexor/review@3.10.1
  - @claudexor/workspace@3.10.1
  - @claudexor/artifact-store@3.10.1
  - @claudexor/journal@3.10.1
  - @claudexor/secrets@3.10.1
  - @claudexor/util@3.10.1

## 3.10.0

### Minor Changes

- Add caller-owned Codex model operations through managed accounts shared with Agents, with exact model payloads, durable single-generation identity, result acknowledgement and typed outcome/cost evidence. Keep system prompts, conversation history and tool execution with the caller. Preserve unconfirmed setup termination during runtime replacement; a pre-permit failure without recorded process evidence remains unreconcilable and is disclosed rather than introducing a new journal format. Simplify contributor release review while retaining signed runtime manifests and exact candidate promotion.

### Patch Changes

- Updated dependencies
- Updated dependencies [dd518f0]
  - @claudexor/control-api@3.10.0
  - @claudexor/core@3.10.0
  - @claudexor/daemon@3.10.0
  - @claudexor/harness-codex@3.10.0
  - @claudexor/schema@3.10.0
  - @claudexor/journal@3.10.0
  - @claudexor/delivery@3.10.0
  - @claudexor/gateway@3.10.0
  - @claudexor/harness-agy@3.10.0
  - @claudexor/harness-claude@3.10.0
  - @claudexor/harness-cursor@3.10.0
  - @claudexor/harness-fake@3.10.0
  - @claudexor/harness-opencode@3.10.0
  - @claudexor/harness-raw-api@3.10.0
  - @claudexor/orchestrator@3.10.0
  - @claudexor/review@3.10.0
  - @claudexor/workspace@3.10.0
  - @claudexor/acp-server@3.10.0
  - @claudexor/config@3.10.0
  - @claudexor/mcp-server@3.10.0
  - @claudexor/artifact-store@3.10.0
  - @claudexor/secrets@3.10.0
  - @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Make internal model review opt-in for ordinary Agent work, independently of executor selection. Preserve explicit panels, Best-of, and requested review cycles; persist intent separately from results and retain historical behavior on replay. Deliberately unreviewed changes remain normally applicable with honest Not reviewed status while required checks and patch integrity remain enforced. Expose the same choice through API, CLI, MCP, ACP, and the native composer.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies [069c6e3]
  - @claudexor/schema@3.9.8
  - @claudexor/orchestrator@3.9.8
  - @claudexor/delivery@3.9.8
  - @claudexor/mcp-server@3.9.8
  - @claudexor/acp-server@3.9.8
  - @claudexor/harness-codex@3.9.8
  - @claudexor/harness-claude@3.9.8
  - @claudexor/config@3.9.8
  - @claudexor/control-api@3.9.8
  - @claudexor/core@3.9.8
  - @claudexor/daemon@3.9.8
  - @claudexor/gateway@3.9.8
  - @claudexor/harness-agy@3.9.8
  - @claudexor/harness-cursor@3.9.8
  - @claudexor/harness-fake@3.9.8
  - @claudexor/harness-opencode@3.9.8
  - @claudexor/harness-raw-api@3.9.8
  - @claudexor/review@3.9.8
  - @claudexor/workspace@3.9.8
  - @claudexor/artifact-store@3.9.8
  - @claudexor/journal@3.9.8
  - @claudexor/secrets@3.9.8
  - @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/acp-server@3.9.7
- @claudexor/artifact-store@3.9.7
- @claudexor/config@3.9.7
- @claudexor/control-api@3.9.7
- @claudexor/core@3.9.7
- @claudexor/daemon@3.9.7
- @claudexor/delivery@3.9.7
- @claudexor/gateway@3.9.7
- @claudexor/harness-agy@3.9.7
- @claudexor/harness-claude@3.9.7
- @claudexor/harness-codex@3.9.7
- @claudexor/harness-cursor@3.9.7
- @claudexor/harness-fake@3.9.7
- @claudexor/harness-opencode@3.9.7
- @claudexor/harness-raw-api@3.9.7
- @claudexor/journal@3.9.7
- @claudexor/mcp-server@3.9.7
- @claudexor/orchestrator@3.9.7
- @claudexor/review@3.9.7
- @claudexor/schema@3.9.7
- @claudexor/secrets@3.9.7
- @claudexor/util@3.9.7
- @claudexor/workspace@3.9.7

## 3.9.6

### Patch Changes

- 7e1269c: Background quota polling no longer lets one revoked, never-logged-in, or failing profile pin its vendor's healthy profiles to the 15-minute retry ceiling: a lane whose fresh evidence is about to expire renews on schedule even mid-ladder. The Claude OAuth source also remembers a proven vendor rejection per presented token and stops re-presenting it on background cycles — until the token changes, a login or profile change, an explicit refresh, or six hours, after which one remembered token is re-verified per cycle — so a rejected token reaches the vendor at most once per six hours instead of every cycle, removing the 401 storm behind the one-hour vendor 429 that blacked out every healthy sibling.
- Updated dependencies [dd02e0a]
- Updated dependencies [7e1269c]
  - @claudexor/workspace@3.9.6
  - @claudexor/daemon@3.9.6
  - @claudexor/delivery@3.9.6
  - @claudexor/orchestrator@3.9.6
  - @claudexor/review@3.9.6
  - @claudexor/control-api@3.9.6
  - @claudexor/acp-server@3.9.6
  - @claudexor/artifact-store@3.9.6
  - @claudexor/config@3.9.6
  - @claudexor/core@3.9.6
  - @claudexor/gateway@3.9.6
  - @claudexor/harness-agy@3.9.6
  - @claudexor/harness-claude@3.9.6
  - @claudexor/harness-codex@3.9.6
  - @claudexor/harness-cursor@3.9.6
  - @claudexor/harness-fake@3.9.6
  - @claudexor/harness-opencode@3.9.6
  - @claudexor/harness-raw-api@3.9.6
  - @claudexor/journal@3.9.6
  - @claudexor/mcp-server@3.9.6
  - @claudexor/schema@3.9.6
  - @claudexor/secrets@3.9.6
  - @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- 6e54444: Request background quota renewal on the last existing poll tick before primary evidence would become stale, while preserving current-time freshness and existing vendor pacing.
- Updated dependencies [6e54444]
  - @claudexor/daemon@3.9.5
  - @claudexor/acp-server@3.9.5
  - @claudexor/artifact-store@3.9.5
  - @claudexor/config@3.9.5
  - @claudexor/control-api@3.9.5
  - @claudexor/core@3.9.5
  - @claudexor/delivery@3.9.5
  - @claudexor/gateway@3.9.5
  - @claudexor/harness-agy@3.9.5
  - @claudexor/harness-claude@3.9.5
  - @claudexor/harness-codex@3.9.5
  - @claudexor/harness-cursor@3.9.5
  - @claudexor/harness-fake@3.9.5
  - @claudexor/harness-opencode@3.9.5
  - @claudexor/harness-raw-api@3.9.5
  - @claudexor/journal@3.9.5
  - @claudexor/mcp-server@3.9.5
  - @claudexor/orchestrator@3.9.5
  - @claudexor/review@3.9.5
  - @claudexor/schema@3.9.5
  - @claudexor/secrets@3.9.5
  - @claudexor/util@3.9.5
  - @claudexor/workspace@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/acp-server@3.9.4
- @claudexor/artifact-store@3.9.4
- @claudexor/config@3.9.4
- @claudexor/control-api@3.9.4
- @claudexor/core@3.9.4
- @claudexor/daemon@3.9.4
- @claudexor/delivery@3.9.4
- @claudexor/gateway@3.9.4
- @claudexor/harness-agy@3.9.4
- @claudexor/harness-claude@3.9.4
- @claudexor/harness-codex@3.9.4
- @claudexor/harness-cursor@3.9.4
- @claudexor/harness-fake@3.9.4
- @claudexor/harness-opencode@3.9.4
- @claudexor/harness-raw-api@3.9.4
- @claudexor/journal@3.9.4
- @claudexor/mcp-server@3.9.4
- @claudexor/orchestrator@3.9.4
- @claudexor/review@3.9.4
- @claudexor/schema@3.9.4
- @claudexor/secrets@3.9.4
- @claudexor/util@3.9.4
- @claudexor/workspace@3.9.4

## 3.9.3

### Patch Changes

- Preserve typed text-fragment metadata in delegated run timelines so hosts can join streamed words and whitespace without inserting event separators. Keep complete messages, tool events, final answers, and omission disclosures distinct.

  Allow release review by any two distinct approved model families on any harness, recording the actual model and harness while retaining exact-candidate evidence, independent reports, and signed attestation checks.

- Updated dependencies
  - @claudexor/schema@3.9.3
  - @claudexor/control-api@3.9.3
  - @claudexor/harness-cursor@3.9.3
  - @claudexor/acp-server@3.9.3
  - @claudexor/config@3.9.3
  - @claudexor/core@3.9.3
  - @claudexor/daemon@3.9.3
  - @claudexor/delivery@3.9.3
  - @claudexor/gateway@3.9.3
  - @claudexor/harness-agy@3.9.3
  - @claudexor/harness-claude@3.9.3
  - @claudexor/harness-codex@3.9.3
  - @claudexor/harness-fake@3.9.3
  - @claudexor/harness-opencode@3.9.3
  - @claudexor/harness-raw-api@3.9.3
  - @claudexor/mcp-server@3.9.3
  - @claudexor/orchestrator@3.9.3
  - @claudexor/review@3.9.3
  - @claudexor/workspace@3.9.3
  - @claudexor/artifact-store@3.9.3
  - @claudexor/journal@3.9.3
  - @claudexor/secrets@3.9.3
  - @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- 14e1dd3: Refresh expired Claude subscription credentials through Claude Code before reading quota, without sending a model prompt or taking custody of refresh tokens.
- Updated dependencies [14e1dd3]
  - @claudexor/harness-claude@3.9.2
  - @claudexor/acp-server@3.9.2
  - @claudexor/artifact-store@3.9.2
  - @claudexor/config@3.9.2
  - @claudexor/control-api@3.9.2
  - @claudexor/core@3.9.2
  - @claudexor/daemon@3.9.2
  - @claudexor/delivery@3.9.2
  - @claudexor/gateway@3.9.2
  - @claudexor/harness-agy@3.9.2
  - @claudexor/harness-codex@3.9.2
  - @claudexor/harness-cursor@3.9.2
  - @claudexor/harness-fake@3.9.2
  - @claudexor/harness-opencode@3.9.2
  - @claudexor/harness-raw-api@3.9.2
  - @claudexor/journal@3.9.2
  - @claudexor/mcp-server@3.9.2
  - @claudexor/orchestrator@3.9.2
  - @claudexor/review@3.9.2
  - @claudexor/schema@3.9.2
  - @claudexor/secrets@3.9.2
  - @claudexor/util@3.9.2
  - @claudexor/workspace@3.9.2

## 3.9.1

### Patch Changes

- 574711f: Keep refreshable Claude Code profiles signed in when an idle quota probe cannot prove their vendor-owned access token was fresh.
  - @claudexor/acp-server@3.9.1
  - @claudexor/artifact-store@3.9.1
  - @claudexor/config@3.9.1
  - @claudexor/control-api@3.9.1
  - @claudexor/core@3.9.1
  - @claudexor/daemon@3.9.1
  - @claudexor/delivery@3.9.1
  - @claudexor/gateway@3.9.1
  - @claudexor/harness-agy@3.9.1
  - @claudexor/harness-claude@3.9.1
  - @claudexor/harness-codex@3.9.1
  - @claudexor/harness-cursor@3.9.1
  - @claudexor/harness-fake@3.9.1
  - @claudexor/harness-opencode@3.9.1
  - @claudexor/harness-raw-api@3.9.1
  - @claudexor/journal@3.9.1
  - @claudexor/mcp-server@3.9.1
  - @claudexor/orchestrator@3.9.1
  - @claudexor/review@3.9.1
  - @claudexor/schema@3.9.1
  - @claudexor/secrets@3.9.1
  - @claudexor/util@3.9.1
  - @claudexor/workspace@3.9.1

## 3.9.0

### Minor Changes

- 69500f8: Foreground quota refreshes (POST /v2/quota and the atomic Accounts snapshot) now honor each vendor's poll rate-limit cooldown: a vendor that recently answered 429 is served from last-known registry data instead of a fresh fan-out, disclosed additively as `refresh_skipped` rows on the quota response.
- 11a785c: The `claudexor_accounts` MCP tool defaults to the server's cached credential-profiles listing instead of hardcoding the atomic snapshot; `fresh: true` opts into the expensive snapshot form (which itself now honors per-vendor rate-limit cooldowns). The tool description states the cost honestly and the output schema is the union of both forms.
- fd623ff: Parse Retry-After on oauth/usage 429 into a typed `rate_limited` quota absence carrying `retry_after_ms`, so poll pacing can honor the vendor floor instead of recording an undiagnosed refresh failure.
- 48ae659: Quota poll pacing is now per vendor lane: each vendor's refreshers own an independent completion-anchored backoff, a typed rate_limited absence arms a persisted vendor Retry-After floor in daemon-private pacer state (never the quota journal), and a daemon restart or credential change no longer resets the vendor cooldown into a 429 amplifier.
- 278e436: The claude oauth-usage candidate loop short-circuits after the first 429 (unprobed siblings get the honest distinct `probe_skipped_rate_limited` absence, never a fabricated `rate_limited`), and the agy profile fan-out is bounded to 3 concurrent vendor probes; the same short-circuit seam is in place for agy and arms once its vendor classifier learns to type 429s (today the live agy win is the concurrency bound).

### Patch Changes

- Updated dependencies [d9cccac]
- Updated dependencies [69500f8]
- Updated dependencies [e39c57b]
- Updated dependencies [11a785c]
- Updated dependencies [fd623ff]
- Updated dependencies [48ae659]
- Updated dependencies [278e436]
  - @claudexor/harness-cursor@3.9.0
  - @claudexor/schema@3.9.0
  - @claudexor/daemon@3.9.0
  - @claudexor/mcp-server@3.9.0
  - @claudexor/acp-server@3.9.0
  - @claudexor/config@3.9.0
  - @claudexor/control-api@3.9.0
  - @claudexor/core@3.9.0
  - @claudexor/delivery@3.9.0
  - @claudexor/gateway@3.9.0
  - @claudexor/harness-agy@3.9.0
  - @claudexor/harness-claude@3.9.0
  - @claudexor/harness-codex@3.9.0
  - @claudexor/harness-fake@3.9.0
  - @claudexor/harness-opencode@3.9.0
  - @claudexor/harness-raw-api@3.9.0
  - @claudexor/orchestrator@3.9.0
  - @claudexor/review@3.9.0
  - @claudexor/workspace@3.9.0
  - @claudexor/artifact-store@3.9.0
  - @claudexor/journal@3.9.0
  - @claudexor/secrets@3.9.0
  - @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- Updated dependencies
  - @claudexor/orchestrator@3.8.4
  - @claudexor/acp-server@3.8.4
  - @claudexor/artifact-store@3.8.4
  - @claudexor/config@3.8.4
  - @claudexor/control-api@3.8.4
  - @claudexor/core@3.8.4
  - @claudexor/daemon@3.8.4
  - @claudexor/delivery@3.8.4
  - @claudexor/gateway@3.8.4
  - @claudexor/harness-agy@3.8.4
  - @claudexor/harness-claude@3.8.4
  - @claudexor/harness-codex@3.8.4
  - @claudexor/harness-cursor@3.8.4
  - @claudexor/harness-fake@3.8.4
  - @claudexor/harness-opencode@3.8.4
  - @claudexor/harness-raw-api@3.8.4
  - @claudexor/journal@3.8.4
  - @claudexor/mcp-server@3.8.4
  - @claudexor/review@3.8.4
  - @claudexor/schema@3.8.4
  - @claudexor/secrets@3.8.4
  - @claudexor/util@3.8.4
  - @claudexor/workspace@3.8.4

## 3.8.3

### Patch Changes

- Updated dependencies [16f0c27]
  - @claudexor/journal@3.8.3
  - @claudexor/daemon@3.8.3
  - @claudexor/acp-server@3.8.3
  - @claudexor/artifact-store@3.8.3
  - @claudexor/config@3.8.3
  - @claudexor/control-api@3.8.3
  - @claudexor/core@3.8.3
  - @claudexor/delivery@3.8.3
  - @claudexor/gateway@3.8.3
  - @claudexor/harness-agy@3.8.3
  - @claudexor/harness-claude@3.8.3
  - @claudexor/harness-codex@3.8.3
  - @claudexor/harness-cursor@3.8.3
  - @claudexor/harness-fake@3.8.3
  - @claudexor/harness-opencode@3.8.3
  - @claudexor/harness-raw-api@3.8.3
  - @claudexor/mcp-server@3.8.3
  - @claudexor/orchestrator@3.8.3
  - @claudexor/review@3.8.3
  - @claudexor/schema@3.8.3
  - @claudexor/secrets@3.8.3
  - @claudexor/util@3.8.3
  - @claudexor/workspace@3.8.3

## 3.8.2

### Patch Changes

- fc15ea8: Keep transient Claude native auth-status transport failures typed as unknown,
  with bounded retry and last-known-good disclosure instead of a false logout.
- Updated dependencies [fc15ea8]
  - @claudexor/harness-claude@3.8.2
  - @claudexor/acp-server@3.8.2
  - @claudexor/artifact-store@3.8.2
  - @claudexor/config@3.8.2
  - @claudexor/control-api@3.8.2
  - @claudexor/core@3.8.2
  - @claudexor/daemon@3.8.2
  - @claudexor/delivery@3.8.2
  - @claudexor/gateway@3.8.2
  - @claudexor/harness-agy@3.8.2
  - @claudexor/harness-codex@3.8.2
  - @claudexor/harness-cursor@3.8.2
  - @claudexor/harness-fake@3.8.2
  - @claudexor/harness-opencode@3.8.2
  - @claudexor/harness-raw-api@3.8.2
  - @claudexor/journal@3.8.2
  - @claudexor/mcp-server@3.8.2
  - @claudexor/orchestrator@3.8.2
  - @claudexor/review@3.8.2
  - @claudexor/schema@3.8.2
  - @claudexor/secrets@3.8.2
  - @claudexor/util@3.8.2
  - @claudexor/workspace@3.8.2

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
- Updated dependencies [39dae8d]
- Updated dependencies [2794ec7]
  - @claudexor/harness-agy@3.8.1
  - @claudexor/core@3.8.1
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1
  - @claudexor/daemon@3.8.1
  - @claudexor/orchestrator@3.8.1
  - @claudexor/control-api@3.8.1
  - @claudexor/workspace@3.8.1
  - @claudexor/mcp-server@3.8.1
  - @claudexor/harness-claude@3.8.1
  - @claudexor/harness-codex@3.8.1
  - @claudexor/harness-cursor@3.8.1
  - @claudexor/harness-opencode@3.8.1
  - @claudexor/delivery@3.8.1
  - @claudexor/gateway@3.8.1
  - @claudexor/harness-fake@3.8.1
  - @claudexor/harness-raw-api@3.8.1
  - @claudexor/review@3.8.1
  - @claudexor/acp-server@3.8.1
  - @claudexor/config@3.8.1
  - @claudexor/artifact-store@3.8.1
  - @claudexor/journal@3.8.1
  - @claudexor/secrets@3.8.1

## 3.8.0

### Patch Changes

- 6054b7d: Make credential-profile custody and managed setup login platform-aware, with an exact Windows Antigravity one-binding policy, vendor-proven doctor/quota results, durable ambiguity handling, and host-resolved terminal capability projection.
- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/core@3.8.0
  - @claudexor/daemon@3.8.0
  - @claudexor/orchestrator@3.8.0
  - @claudexor/harness-agy@3.8.0
  - @claudexor/harness-claude@3.8.0
  - @claudexor/harness-codex@3.8.0
  - @claudexor/harness-cursor@3.8.0
  - @claudexor/acp-server@3.8.0
  - @claudexor/config@3.8.0
  - @claudexor/control-api@3.8.0
  - @claudexor/delivery@3.8.0
  - @claudexor/gateway@3.8.0
  - @claudexor/harness-fake@3.8.0
  - @claudexor/harness-opencode@3.8.0
  - @claudexor/harness-raw-api@3.8.0
  - @claudexor/mcp-server@3.8.0
  - @claudexor/review@3.8.0
  - @claudexor/workspace@3.8.0
  - @claudexor/artifact-store@3.8.0
  - @claudexor/journal@3.8.0
  - @claudexor/secrets@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Minor Changes

- `claudexor harness install` gains an explicit `--target local`: the vendor CLI
  is installed into the managed toolchain root that local binary resolution and
  confinement already read, serialized by a cross-process install lease, and
  proved afterwards by resolving the launcher and executing its `--version`. The
  watched remote flow is unchanged. The signed runtime closure now also carries
  `claudexor.bundle.cjs`, so an embedding host can invoke that exact reviewed CLI.

### Patch Changes

- @claudexor/acp-server@3.7.0
- @claudexor/artifact-store@3.7.0
- @claudexor/config@3.7.0
- @claudexor/control-api@3.7.0
- @claudexor/core@3.7.0
- @claudexor/daemon@3.7.0
- @claudexor/delivery@3.7.0
- @claudexor/gateway@3.7.0
- @claudexor/harness-agy@3.7.0
- @claudexor/harness-claude@3.7.0
- @claudexor/harness-codex@3.7.0
- @claudexor/harness-cursor@3.7.0
- @claudexor/harness-fake@3.7.0
- @claudexor/harness-opencode@3.7.0
- @claudexor/harness-raw-api@3.7.0
- @claudexor/journal@3.7.0
- @claudexor/mcp-server@3.7.0
- @claudexor/orchestrator@3.7.0
- @claudexor/review@3.7.0
- @claudexor/schema@3.7.0
- @claudexor/secrets@3.7.0
- @claudexor/util@3.7.0
- @claudexor/workspace@3.7.0

## 3.6.0

### Minor Changes

- 895967f: Unified account model (INV-135 rewrite, owner-approved). Every account is a
  named registry row — the separate "default"/"CLI login" account type is gone.
  A detected legacy claude/codex default-store login auto-registers at daemon
  start as the ordinary `<harness>-default` row through a crash-recoverable
  migration (typed per-harness run refusal while incomplete; rollback command
  as the supported downgrade path). Unpinned runs route through a quota-aware
  pool of enabled+ready rows with sticky, disclosed thread bindings; explicit
  pins are strict (typed `subscription_window_exhausted` refusal, no silent
  rotation); pool exhaustion is a typed `credential_pool_exhausted` terminal
  carrying the pool's earliest known reset, and the paid API-key route serves
  it only under the explicit `api_key` preference — never silently under
  `auto` (owner Q3=A). New wire: additive `accountPools` pool
  authority plus `GET /v2/account-pools` (the feature marker) and
  `POST /v2/accounts-migration/rollback`; `harnessAccounts` stays on the wire
  as `[]` for legacy strict clients. Cursor host-Keychain logins are retired:
  every cursor account lives in an isolated vendor file-store row, and
  `auth login` becomes bootstrap sugar into the `<harness>-default` row.
  Deleting a row is provable (typed retryable error on partial cleanup) and
  retires migrated legacy aliases in the same operation.

### Patch Changes

- Updated dependencies [895967f]
  - @claudexor/schema@3.6.0
  - @claudexor/orchestrator@3.6.0
  - @claudexor/daemon@3.6.0
  - @claudexor/control-api@3.6.0
  - @claudexor/workspace@3.6.0
  - @claudexor/harness-claude@3.6.0
  - @claudexor/harness-codex@3.6.0
  - @claudexor/harness-cursor@3.6.0
  - @claudexor/acp-server@3.6.0
  - @claudexor/config@3.6.0
  - @claudexor/core@3.6.0
  - @claudexor/delivery@3.6.0
  - @claudexor/gateway@3.6.0
  - @claudexor/harness-agy@3.6.0
  - @claudexor/harness-fake@3.6.0
  - @claudexor/harness-opencode@3.6.0
  - @claudexor/harness-raw-api@3.6.0
  - @claudexor/mcp-server@3.6.0
  - @claudexor/review@3.6.0
  - @claudexor/artifact-store@3.6.0
  - @claudexor/journal@3.6.0
  - @claudexor/secrets@3.6.0
  - @claudexor/util@3.6.0

## 3.5.0

### Minor Changes

- 2316ef8: Add the Antigravity CLI (`agy`) as a harness, so a Google AI Pro/Ultra
  subscription runs through Claudexor like the other vendor CLIs.

  Named Google identities are Claudexor-owned profile HOMEs (`config_dir_login`),
  so several subscriptions stay signed in side by side without touching the
  operator's real home or login keychain. `claudexor quota` reads each profile's
  own `/quota` windows, and the windows are model-scoped: exhausting the Gemini
  budget does not block the account's Claude/GPT slugs. `claudexor harness
install agy` downloads Google's official installer in full, prints its size and
  sha256, and runs the file you were shown — it is never piped into a shell.

  The vendor exposes no config-dir environment variable, so the profile HOME also
  holds its conversation and cache state, and it publishes no machine-readable
  account identity — both are disclosed rather than papered over. Windows support
  is best effort in this release.

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/harness-agy@3.5.0
  - @claudexor/util@3.5.0
  - @claudexor/acp-server@3.5.0
  - @claudexor/artifact-store@3.5.0
  - @claudexor/config@3.5.0
  - @claudexor/control-api@3.5.0
  - @claudexor/core@3.5.0
  - @claudexor/daemon@3.5.0
  - @claudexor/delivery@3.5.0
  - @claudexor/harness-claude@3.5.0
  - @claudexor/harness-codex@3.5.0
  - @claudexor/harness-cursor@3.5.0
  - @claudexor/harness-fake@3.5.0
  - @claudexor/harness-opencode@3.5.0
  - @claudexor/harness-raw-api@3.5.0
  - @claudexor/journal@3.5.0
  - @claudexor/mcp-server@3.5.0
  - @claudexor/orchestrator@3.5.0
  - @claudexor/review@3.5.0
  - @claudexor/schema@3.5.0
  - @claudexor/secrets@3.5.0
  - @claudexor/workspace@3.5.0
  - @claudexor/gateway@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/acp-server@3.4.2
- @claudexor/artifact-store@3.4.2
- @claudexor/config@3.4.2
- @claudexor/control-api@3.4.2
- @claudexor/core@3.4.2
- @claudexor/daemon@3.4.2
- @claudexor/delivery@3.4.2
- @claudexor/gateway@3.4.2
- @claudexor/harness-claude@3.4.2
- @claudexor/harness-codex@3.4.2
- @claudexor/harness-cursor@3.4.2
- @claudexor/harness-fake@3.4.2
- @claudexor/harness-opencode@3.4.2
- @claudexor/harness-raw-api@3.4.2
- @claudexor/journal@3.4.2
- @claudexor/mcp-server@3.4.2
- @claudexor/orchestrator@3.4.2
- @claudexor/review@3.4.2
- @claudexor/schema@3.4.2
- @claudexor/secrets@3.4.2
- @claudexor/util@3.4.2
- @claudexor/workspace@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/acp-server@3.4.1
- @claudexor/artifact-store@3.4.1
- @claudexor/config@3.4.1
- @claudexor/control-api@3.4.1
- @claudexor/core@3.4.1
- @claudexor/daemon@3.4.1
- @claudexor/delivery@3.4.1
- @claudexor/gateway@3.4.1
- @claudexor/harness-claude@3.4.1
- @claudexor/harness-codex@3.4.1
- @claudexor/harness-cursor@3.4.1
- @claudexor/harness-fake@3.4.1
- @claudexor/harness-opencode@3.4.1
- @claudexor/harness-raw-api@3.4.1
- @claudexor/journal@3.4.1
- @claudexor/mcp-server@3.4.1
- @claudexor/orchestrator@3.4.1
- @claudexor/review@3.4.1
- @claudexor/schema@3.4.1
- @claudexor/secrets@3.4.1
- @claudexor/util@3.4.1
- @claudexor/workspace@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/acp-server@3.4.0
- @claudexor/artifact-store@3.4.0
- @claudexor/config@3.4.0
- @claudexor/control-api@3.4.0
- @claudexor/core@3.4.0
- @claudexor/daemon@3.4.0
- @claudexor/delivery@3.4.0
- @claudexor/gateway@3.4.0
- @claudexor/harness-claude@3.4.0
- @claudexor/harness-codex@3.4.0
- @claudexor/harness-cursor@3.4.0
- @claudexor/harness-fake@3.4.0
- @claudexor/harness-opencode@3.4.0
- @claudexor/harness-raw-api@3.4.0
- @claudexor/journal@3.4.0
- @claudexor/mcp-server@3.4.0
- @claudexor/orchestrator@3.4.0
- @claudexor/review@3.4.0
- @claudexor/schema@3.4.0
- @claudexor/secrets@3.4.0
- @claudexor/util@3.4.0
- @claudexor/workspace@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/acp-server@3.3.16
- @claudexor/artifact-store@3.3.16
- @claudexor/config@3.3.16
- @claudexor/control-api@3.3.16
- @claudexor/core@3.3.16
- @claudexor/daemon@3.3.16
- @claudexor/delivery@3.3.16
- @claudexor/gateway@3.3.16
- @claudexor/harness-claude@3.3.16
- @claudexor/harness-codex@3.3.16
- @claudexor/harness-cursor@3.3.16
- @claudexor/harness-fake@3.3.16
- @claudexor/harness-opencode@3.3.16
- @claudexor/harness-raw-api@3.3.16
- @claudexor/journal@3.3.16
- @claudexor/mcp-server@3.3.16
- @claudexor/orchestrator@3.3.16
- @claudexor/review@3.3.16
- @claudexor/schema@3.3.16
- @claudexor/secrets@3.3.16
- @claudexor/util@3.3.16
- @claudexor/workspace@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/acp-server@3.3.15
- @claudexor/artifact-store@3.3.15
- @claudexor/config@3.3.15
- @claudexor/control-api@3.3.15
- @claudexor/core@3.3.15
- @claudexor/daemon@3.3.15
- @claudexor/delivery@3.3.15
- @claudexor/gateway@3.3.15
- @claudexor/harness-claude@3.3.15
- @claudexor/harness-codex@3.3.15
- @claudexor/harness-cursor@3.3.15
- @claudexor/harness-fake@3.3.15
- @claudexor/harness-opencode@3.3.15
- @claudexor/harness-raw-api@3.3.15
- @claudexor/journal@3.3.15
- @claudexor/mcp-server@3.3.15
- @claudexor/orchestrator@3.3.15
- @claudexor/review@3.3.15
- @claudexor/schema@3.3.15
- @claudexor/secrets@3.3.15
- @claudexor/util@3.3.15
- @claudexor/workspace@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/acp-server@3.3.14
- @claudexor/artifact-store@3.3.14
- @claudexor/config@3.3.14
- @claudexor/control-api@3.3.14
- @claudexor/core@3.3.14
- @claudexor/daemon@3.3.14
- @claudexor/delivery@3.3.14
- @claudexor/gateway@3.3.14
- @claudexor/harness-claude@3.3.14
- @claudexor/harness-codex@3.3.14
- @claudexor/harness-cursor@3.3.14
- @claudexor/harness-fake@3.3.14
- @claudexor/harness-opencode@3.3.14
- @claudexor/harness-raw-api@3.3.14
- @claudexor/journal@3.3.14
- @claudexor/mcp-server@3.3.14
- @claudexor/orchestrator@3.3.14
- @claudexor/review@3.3.14
- @claudexor/schema@3.3.14
- @claudexor/secrets@3.3.14
- @claudexor/util@3.3.14
- @claudexor/workspace@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/acp-server@3.3.13
- @claudexor/artifact-store@3.3.13
- @claudexor/config@3.3.13
- @claudexor/control-api@3.3.13
- @claudexor/core@3.3.13
- @claudexor/daemon@3.3.13
- @claudexor/delivery@3.3.13
- @claudexor/gateway@3.3.13
- @claudexor/harness-claude@3.3.13
- @claudexor/harness-codex@3.3.13
- @claudexor/harness-cursor@3.3.13
- @claudexor/harness-fake@3.3.13
- @claudexor/harness-opencode@3.3.13
- @claudexor/harness-raw-api@3.3.13
- @claudexor/journal@3.3.13
- @claudexor/mcp-server@3.3.13
- @claudexor/orchestrator@3.3.13
- @claudexor/review@3.3.13
- @claudexor/schema@3.3.13
- @claudexor/secrets@3.3.13
- @claudexor/util@3.3.13
- @claudexor/workspace@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/acp-server@3.3.12
- @claudexor/artifact-store@3.3.12
- @claudexor/config@3.3.12
- @claudexor/control-api@3.3.12
- @claudexor/core@3.3.12
- @claudexor/daemon@3.3.12
- @claudexor/delivery@3.3.12
- @claudexor/gateway@3.3.12
- @claudexor/harness-claude@3.3.12
- @claudexor/harness-codex@3.3.12
- @claudexor/harness-cursor@3.3.12
- @claudexor/harness-fake@3.3.12
- @claudexor/harness-opencode@3.3.12
- @claudexor/harness-raw-api@3.3.12
- @claudexor/journal@3.3.12
- @claudexor/mcp-server@3.3.12
- @claudexor/orchestrator@3.3.12
- @claudexor/review@3.3.12
- @claudexor/schema@3.3.12
- @claudexor/secrets@3.3.12
- @claudexor/util@3.3.12
- @claudexor/workspace@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/acp-server@3.3.0
- @claudexor/artifact-store@3.3.0
- @claudexor/config@3.3.0
- @claudexor/control-api@3.3.0
- @claudexor/core@3.3.0
- @claudexor/daemon@3.3.0
- @claudexor/delivery@3.3.0
- @claudexor/gateway@3.3.0
- @claudexor/harness-claude@3.3.0
- @claudexor/harness-codex@3.3.0
- @claudexor/harness-cursor@3.3.0
- @claudexor/harness-fake@3.3.0
- @claudexor/harness-opencode@3.3.0
- @claudexor/harness-raw-api@3.3.0
- @claudexor/journal@3.3.0
- @claudexor/mcp-server@3.3.0
- @claudexor/orchestrator@3.3.0
- @claudexor/review@3.3.0
- @claudexor/schema@3.3.0
- @claudexor/secrets@3.3.0
- @claudexor/util@3.3.0
- @claudexor/workspace@3.3.0

## 3.2.1

### Patch Changes

- Preserve known Claude OAuth model scope in quota snapshots, keep unknown scope account-wide, and project native-default account routing without treating one scoped model limit as global.
- @claudexor/acp-server@3.2.1
- @claudexor/artifact-store@3.2.1
- @claudexor/config@3.2.1
- @claudexor/control-api@3.2.1
- @claudexor/core@3.2.1
- @claudexor/daemon@3.2.1
- @claudexor/delivery@3.2.1
- @claudexor/gateway@3.2.1
- @claudexor/harness-claude@3.2.1
- @claudexor/harness-codex@3.2.1
- @claudexor/harness-cursor@3.2.1
- @claudexor/harness-fake@3.2.1
- @claudexor/harness-opencode@3.2.1
- @claudexor/harness-raw-api@3.2.1
- @claudexor/journal@3.2.1
- @claudexor/mcp-server@3.2.1
- @claudexor/orchestrator@3.2.1
- @claudexor/review@3.2.1
- @claudexor/schema@3.2.1
- @claudexor/secrets@3.2.1
- @claudexor/util@3.2.1
- @claudexor/workspace@3.2.1

## 3.2.0

### Patch Changes

- Make local and remote runtime activation and rollback use daemon-owned atomic
  run/setup admission fencing while preserving explicit operator shutdown
  semantics.
- Keep an extended remote client-PTY login attachable after its original
  deadline without rewriting its sealed authorization; the daemon-owned job
  deadline remains the permit authority.
- Align Plan attachments, per-command flag ownership, location-scoped settings and accounts, durable refused-turn retry, Git applicability, canonical terminal output, and Settings validation envelopes with the control-plane contracts.
- Parse TTY Plan and interaction choices with one exact numeric grammar, keeping
  numeric-prefixed prose and invalid multi-picks as the user's full text.
- Validate successful run-detail responses, redact degraded MCP/ACP diagnostics,
  scrub vendor-installer child environments, and keep the machine-actionable
  Codex login fallback bound to the server-owned credential profile.
- @claudexor/acp-server@3.2.0
- @claudexor/artifact-store@3.2.0
- @claudexor/config@3.2.0
- @claudexor/control-api@3.2.0
- @claudexor/core@3.2.0
- @claudexor/daemon@3.2.0
- @claudexor/delivery@3.2.0
- @claudexor/gateway@3.2.0
- @claudexor/harness-claude@3.2.0
- @claudexor/harness-codex@3.2.0
- @claudexor/harness-cursor@3.2.0
- @claudexor/harness-fake@3.2.0
- @claudexor/harness-opencode@3.2.0
- @claudexor/harness-raw-api@3.2.0
- @claudexor/journal@3.2.0
- @claudexor/mcp-server@3.2.0
- @claudexor/orchestrator@3.2.0
- @claudexor/review@3.2.0
- @claudexor/schema@3.2.0
- @claudexor/secrets@3.2.0
- @claudexor/util@3.2.0
- @claudexor/workspace@3.2.0

## 3.1.2

### Patch Changes

- Restore Delegate in packaged installs through the exact daemon self-entry; enforce required MCP startup, bounded shared parent/child budget and cancellation authority, typed lineage and degradation receipts, and durable CLI/macOS projections across reload and reconnect.
- Make delegated child questions answerable in the macOS conversation, show the exact requested/effective/used/reason receipt and lineage in run details, and keep the packaged daemon entry executable through canonical macOS temporary-path aliases used by candidate verification.
- Updated dependencies
  - @claudexor/control-api@3.1.2
  - @claudexor/core@3.1.2
  - @claudexor/daemon@3.1.2
  - @claudexor/harness-claude@3.1.2
  - @claudexor/harness-codex@3.1.2
  - @claudexor/mcp-server@3.1.2
  - @claudexor/orchestrator@3.1.2
  - @claudexor/schema@3.1.2
  - @claudexor/delivery@3.1.2
  - @claudexor/gateway@3.1.2
  - @claudexor/harness-cursor@3.1.2
  - @claudexor/harness-fake@3.1.2
  - @claudexor/harness-opencode@3.1.2
  - @claudexor/harness-raw-api@3.1.2
  - @claudexor/review@3.1.2
  - @claudexor/workspace@3.1.2
  - @claudexor/acp-server@3.1.2
  - @claudexor/config@3.1.2
  - @claudexor/artifact-store@3.1.2
  - @claudexor/journal@3.1.2
  - @claudexor/secrets@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Exact retry on a pre-start terminal run answers with its typed refusal (a 403,
  not a 202 handle), and the CLI retry and run-again paths read the refusal's
  actual problem message instead of an `error` field the daemon never serves.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @claudexor/core@3.1.1
  - @claudexor/orchestrator@3.1.1
  - @claudexor/review@3.1.1
  - @claudexor/control-api@3.1.1
  - @claudexor/harness-claude@3.1.1
  - @claudexor/harness-codex@3.1.1
  - @claudexor/schema@3.1.1
  - @claudexor/mcp-server@3.1.1
  - @claudexor/daemon@3.1.1
  - @claudexor/delivery@3.1.1
  - @claudexor/gateway@3.1.1
  - @claudexor/harness-cursor@3.1.1
  - @claudexor/harness-fake@3.1.1
  - @claudexor/harness-opencode@3.1.1
  - @claudexor/harness-raw-api@3.1.1
  - @claudexor/workspace@3.1.1
  - @claudexor/acp-server@3.1.1
  - @claudexor/config@3.1.1
  - @claudexor/artifact-store@3.1.1
  - @claudexor/journal@3.1.1
  - @claudexor/secrets@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Minor Changes

- c3b7ece: Support declared JSON Schema draft-07 and draft 2020-12 output contracts, publish the supported dialect catalog, and record the selected dialect plus stable schema hash in structured-output receipts. Local JSON Pointer references are inlined only for native provider transport while the original schema remains the validation authority.

### Patch Changes

- Updated dependencies [c3b7ece]
- Updated dependencies [6e36993]
  - @claudexor/schema@3.1.0
  - @claudexor/orchestrator@3.1.0
  - @claudexor/control-api@3.1.0
  - @claudexor/core@3.1.0
  - @claudexor/harness-codex@3.1.0
  - @claudexor/acp-server@3.1.0
  - @claudexor/config@3.1.0
  - @claudexor/daemon@3.1.0
  - @claudexor/delivery@3.1.0
  - @claudexor/gateway@3.1.0
  - @claudexor/harness-claude@3.1.0
  - @claudexor/harness-cursor@3.1.0
  - @claudexor/harness-fake@3.1.0
  - @claudexor/harness-opencode@3.1.0
  - @claudexor/harness-raw-api@3.1.0
  - @claudexor/mcp-server@3.1.0
  - @claudexor/review@3.1.0
  - @claudexor/workspace@3.1.0
  - @claudexor/artifact-store@3.1.0
  - @claudexor/journal@3.1.0
  - @claudexor/secrets@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/acp-server@3.0.3
- @claudexor/artifact-store@3.0.3
- @claudexor/config@3.0.3
- @claudexor/control-api@3.0.3
- @claudexor/core@3.0.3
- @claudexor/daemon@3.0.3
- @claudexor/delivery@3.0.3
- @claudexor/gateway@3.0.3
- @claudexor/harness-claude@3.0.3
- @claudexor/harness-codex@3.0.3
- @claudexor/harness-cursor@3.0.3
- @claudexor/harness-fake@3.0.3
- @claudexor/harness-opencode@3.0.3
- @claudexor/harness-raw-api@3.0.3
- @claudexor/journal@3.0.3
- @claudexor/mcp-server@3.0.3
- @claudexor/orchestrator@3.0.3
- @claudexor/review@3.0.3
- @claudexor/schema@3.0.3
- @claudexor/secrets@3.0.3
- @claudexor/util@3.0.3
- @claudexor/workspace@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/acp-server@3.0.0
- @claudexor/artifact-store@3.0.0
- @claudexor/config@3.0.0
- @claudexor/control-api@3.0.0
- @claudexor/core@3.0.0
- @claudexor/daemon@3.0.0
- @claudexor/delivery@3.0.0
- @claudexor/gateway@3.0.0
- @claudexor/harness-claude@3.0.0
- @claudexor/harness-codex@3.0.0
- @claudexor/harness-cursor@3.0.0
- @claudexor/harness-fake@3.0.0
- @claudexor/harness-opencode@3.0.0
- @claudexor/harness-raw-api@3.0.0
- @claudexor/journal@3.0.0
- @claudexor/mcp-server@3.0.0
- @claudexor/orchestrator@3.0.0
- @claudexor/review@3.0.0
- @claudexor/schema@3.0.0
- @claudexor/secrets@3.0.0
- @claudexor/util@3.0.0
- @claudexor/workspace@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/acp-server@2.1.3
- @claudexor/artifact-store@2.1.3
- @claudexor/config@2.1.3
- @claudexor/control-api@2.1.3
- @claudexor/core@2.1.3
- @claudexor/daemon@2.1.3
- @claudexor/delivery@2.1.3
- @claudexor/gateway@2.1.3
- @claudexor/harness-claude@2.1.3
- @claudexor/harness-codex@2.1.3
- @claudexor/harness-cursor@2.1.3
- @claudexor/harness-fake@2.1.3
- @claudexor/harness-opencode@2.1.3
- @claudexor/harness-raw-api@2.1.3
- @claudexor/interview@2.1.3
- @claudexor/journal@2.1.3
- @claudexor/mcp-server@2.1.3
- @claudexor/orchestrator@2.1.3
- @claudexor/review@2.1.3
- @claudexor/schema@2.1.3
- @claudexor/secrets@2.1.3
- @claudexor/util@2.1.3
- @claudexor/workspace@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/acp-server@2.1.2
- @claudexor/artifact-store@2.1.2
- @claudexor/config@2.1.2
- @claudexor/control-api@2.1.2
- @claudexor/core@2.1.2
- @claudexor/daemon@2.1.2
- @claudexor/delivery@2.1.2
- @claudexor/gateway@2.1.2
- @claudexor/harness-claude@2.1.2
- @claudexor/harness-codex@2.1.2
- @claudexor/harness-cursor@2.1.2
- @claudexor/harness-fake@2.1.2
- @claudexor/harness-opencode@2.1.2
- @claudexor/harness-raw-api@2.1.2
- @claudexor/interview@2.1.2
- @claudexor/journal@2.1.2
- @claudexor/mcp-server@2.1.2
- @claudexor/orchestrator@2.1.2
- @claudexor/review@2.1.2
- @claudexor/schema@2.1.2
- @claudexor/secrets@2.1.2
- @claudexor/util@2.1.2
- @claudexor/workspace@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/acp-server@2.1.1
- @claudexor/artifact-store@2.1.1
- @claudexor/config@2.1.1
- @claudexor/control-api@2.1.1
- @claudexor/core@2.1.1
- @claudexor/daemon@2.1.1
- @claudexor/delivery@2.1.1
- @claudexor/gateway@2.1.1
- @claudexor/harness-claude@2.1.1
- @claudexor/harness-codex@2.1.1
- @claudexor/harness-cursor@2.1.1
- @claudexor/harness-fake@2.1.1
- @claudexor/harness-opencode@2.1.1
- @claudexor/harness-raw-api@2.1.1
- @claudexor/interview@2.1.1
- @claudexor/journal@2.1.1
- @claudexor/mcp-server@2.1.1
- @claudexor/orchestrator@2.1.1
- @claudexor/review@2.1.1
- @claudexor/schema@2.1.1
- @claudexor/secrets@2.1.1
- @claudexor/util@2.1.1
- @claudexor/workspace@2.1.1

## 2.1.0

### Patch Changes

- Updated dependencies
- Updated dependencies [0fc050b]
  - @claudexor/schema@2.1.0
  - @claudexor/core@2.1.0
  - @claudexor/config@2.1.0
  - @claudexor/secrets@2.1.0
  - @claudexor/orchestrator@2.1.0
  - @claudexor/daemon@2.1.0
  - @claudexor/control-api@2.1.0
  - @claudexor/gateway@2.1.0
  - @claudexor/harness-claude@2.1.0
  - @claudexor/harness-codex@2.1.0
  - @claudexor/harness-cursor@2.1.0
  - @claudexor/harness-opencode@2.1.0
  - @claudexor/harness-raw-api@2.1.0
  - @claudexor/acp-server@2.1.0
  - @claudexor/delivery@2.1.0
  - @claudexor/harness-fake@2.1.0
  - @claudexor/interview@2.1.0
  - @claudexor/mcp-server@2.1.0
  - @claudexor/review@2.1.0
  - @claudexor/workspace@2.1.0
  - @claudexor/artifact-store@2.1.0
  - @claudexor/journal@2.1.0
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/acp-server@2.0.2
- @claudexor/artifact-store@2.0.2
- @claudexor/config@2.0.2
- @claudexor/control-api@2.0.2
- @claudexor/core@2.0.2
- @claudexor/daemon@2.0.2
- @claudexor/delivery@2.0.2
- @claudexor/gateway@2.0.2
- @claudexor/harness-claude@2.0.2
- @claudexor/harness-codex@2.0.2
- @claudexor/harness-cursor@2.0.2
- @claudexor/harness-fake@2.0.2
- @claudexor/harness-opencode@2.0.2
- @claudexor/harness-raw-api@2.0.2
- @claudexor/interview@2.0.2
- @claudexor/journal@2.0.2
- @claudexor/mcp-server@2.0.2
- @claudexor/orchestrator@2.0.2
- @claudexor/review@2.0.2
- @claudexor/schema@2.0.2
- @claudexor/secrets@2.0.2
- @claudexor/util@2.0.2
- @claudexor/workspace@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/acp-server@2.0.1
- @claudexor/artifact-store@2.0.1
- @claudexor/config@2.0.1
- @claudexor/control-api@2.0.1
- @claudexor/core@2.0.1
- @claudexor/daemon@2.0.1
- @claudexor/delivery@2.0.1
- @claudexor/gateway@2.0.1
- @claudexor/harness-claude@2.0.1
- @claudexor/harness-codex@2.0.1
- @claudexor/harness-cursor@2.0.1
- @claudexor/harness-fake@2.0.1
- @claudexor/harness-opencode@2.0.1
- @claudexor/harness-raw-api@2.0.1
- @claudexor/interview@2.0.1
- @claudexor/journal@2.0.1
- @claudexor/mcp-server@2.0.1
- @claudexor/orchestrator@2.0.1
- @claudexor/review@2.0.1
- @claudexor/schema@2.0.1
- @claudexor/secrets@2.0.1
- @claudexor/util@2.0.1
- @claudexor/workspace@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/acp-server@2.0.0
- @claudexor/artifact-store@2.0.0
- @claudexor/config@2.0.0
- @claudexor/control-api@2.0.0
- @claudexor/core@2.0.0
- @claudexor/daemon@2.0.0
- @claudexor/delivery@2.0.0
- @claudexor/gateway@2.0.0
- @claudexor/harness-claude@2.0.0
- @claudexor/harness-codex@2.0.0
- @claudexor/harness-cursor@2.0.0
- @claudexor/harness-fake@2.0.0
- @claudexor/harness-opencode@2.0.0
- @claudexor/harness-raw-api@2.0.0
- @claudexor/interview@2.0.0
- @claudexor/journal@2.0.0
- @claudexor/mcp-server@2.0.0
- @claudexor/orchestrator@2.0.0
- @claudexor/review@2.0.0
- @claudexor/schema@2.0.0
- @claudexor/secrets@2.0.0
- @claudexor/util@2.0.0
- @claudexor/workspace@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Stabilize the checkpoint release with explicit reviewer-panel hardening, mandatory
  review evidence preflight, scoped Cursor reviewer readiness, frozen SpecPack gate
  merging, protected-path approvals, and thin control/macOS projection parity.
- Preserve repeated/comma-separated `--harness`, `--attach`, and `--image` values
  on run commands, and keep MCP/ACP runner passthrough aligned for reviewer panel,
  gate, budget, and access fields.
- Updated dependencies
  - @claudexor/control-api@0.14.1
  - @claudexor/core@0.14.1
  - @claudexor/harness-cursor@0.14.1
  - @claudexor/interview@0.14.1
  - @claudexor/orchestrator@0.14.1
  - @claudexor/schema@0.14.1
  - @claudexor/delivery@0.14.1
  - @claudexor/gateway@0.14.1
  - @claudexor/harness-claude@0.14.1
  - @claudexor/harness-codex@0.14.1
  - @claudexor/harness-fake@0.14.1
  - @claudexor/harness-opencode@0.14.1
  - @claudexor/harness-raw-api@0.14.1
  - @claudexor/workspace@0.14.1
  - @claudexor/config@0.14.1
  - @claudexor/daemon@0.14.1
  - @claudexor/acp-server@0.14.1
  - @claudexor/artifact-store@0.14.1
  - @claudexor/mcp-server@0.14.1
  - @claudexor/secrets@0.14.1
  - @claudexor/util@0.14.1

## 0.14.0

### Minor Changes

- Ship battery-driven harness hardening: typed transient retry signals, configurable reviewer timeouts with stronger route-proof capture, convergence no-progress diagnostics, deterministic protected-path tamper blocking, and a stricter real-harness battery.

### Patch Changes

- @claudexor/acp-server@0.14.0
- @claudexor/artifact-store@0.14.0
- @claudexor/config@0.14.0
- @claudexor/control-api@0.14.0
- @claudexor/core@0.14.0
- @claudexor/daemon@0.14.0
- @claudexor/delivery@0.14.0
- @claudexor/gateway@0.14.0
- @claudexor/harness-claude@0.14.0
- @claudexor/harness-codex@0.14.0
- @claudexor/harness-cursor@0.14.0
- @claudexor/harness-fake@0.14.0
- @claudexor/harness-opencode@0.14.0
- @claudexor/harness-raw-api@0.14.0
- @claudexor/interview@0.14.0
- @claudexor/mcp-server@0.14.0
- @claudexor/orchestrator@0.14.0
- @claudexor/schema@0.14.0
- @claudexor/secrets@0.14.0
- @claudexor/util@0.14.0
- @claudexor/workspace@0.14.0

## 0.13.3

### Patch Changes

- Harness-agnostic CLI flow hardening: uniform mandatory-context preflight across
  all modes and sandbox-safe secret storage,
  deterministic `fake-implement` fixture (offline create/apply/orchestrate coverage),
  one honest CLI machine surface (JSON failure reason on both run paths; `--json` on
  inspect/apply error+gate paths), read-only run lookups that never auto-start the
  daemon, daemon-start readiness wait, scoped doctor/auth probes, `models --all`, and
  fail-loud validation for unknown harnesses / reviewer-model / secrets backend.
  - @claudexor/acp-server@0.13.3
  - @claudexor/artifact-store@0.13.3
  - @claudexor/config@0.13.3
  - @claudexor/control-api@0.13.3
  - @claudexor/core@0.13.3
  - @claudexor/daemon@0.13.3
  - @claudexor/delivery@0.13.3
  - @claudexor/gateway@0.13.3
  - @claudexor/harness-claude@0.13.3
  - @claudexor/harness-codex@0.13.3
  - @claudexor/harness-cursor@0.13.3
  - @claudexor/harness-fake@0.13.3
  - @claudexor/harness-opencode@0.13.3
  - @claudexor/harness-raw-api@0.13.3
  - @claudexor/interview@0.13.3
  - @claudexor/mcp-server@0.13.3
  - @claudexor/orchestrator@0.13.3
  - @claudexor/schema@0.13.3
  - @claudexor/secrets@0.13.3
  - @claudexor/util@0.13.3
  - @claudexor/workspace@0.13.3

## 0.12.1

### Patch Changes

- Fix macOS release packaging so the app embeds the SwiftPM resource bundle required by `Bundle.module`, and make the release workflow verify the packaged ZIP contains it.
  - @claudexor/acp-server@0.12.1
  - @claudexor/artifact-store@0.12.1
  - @claudexor/config@0.12.1
  - @claudexor/control-api@0.12.1
  - @claudexor/core@0.12.1
  - @claudexor/daemon@0.12.1
  - @claudexor/delivery@0.12.1
  - @claudexor/gateway@0.12.1
  - @claudexor/harness-claude@0.12.1
  - @claudexor/harness-codex@0.12.1
  - @claudexor/harness-cursor@0.12.1
  - @claudexor/harness-fake@0.12.1
  - @claudexor/harness-opencode@0.12.1
  - @claudexor/harness-raw-api@0.12.1
  - @claudexor/interview@0.12.1
  - @claudexor/mcp-server@0.12.1
  - @claudexor/orchestrator@0.12.1
  - @claudexor/schema@0.12.1
  - @claudexor/secrets@0.12.1
  - @claudexor/util@0.12.1
  - @claudexor/workspace@0.12.1
