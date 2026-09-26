# @claudexor/orchestrator

## 3.17.0

### Patch Changes

- Updated dependencies [092ec2b]
- Updated dependencies [951489f]
  - @claudexor/core@3.17.0
  - @claudexor/schema@3.17.0
  - @claudexor/context@3.17.0
  - @claudexor/delivery@3.17.0
  - @claudexor/gateway@3.17.0
  - @claudexor/review@3.17.0
  - @claudexor/workspace@3.17.0
  - @claudexor/arbitration@3.17.0
  - @claudexor/budget@3.17.0
  - @claudexor/config@3.17.0
  - @claudexor/event-log@3.17.0
  - @claudexor/policy@3.17.0
  - @claudexor/synthesis@3.17.0
  - @claudexor/artifact-store@3.17.0
  - @claudexor/util@3.17.0

## 3.16.0

### Minor Changes

- 788ddca: Add `POST /v2/runs/:id/messages`: a live message into a running run's active attempt with journal-first admission, typed outcomes (delivered, accepted, rejected, not_active, unsupported, delivery_unknown) plus reasons, and a key-required idempotent receipt. Each harness declares its live-input channel as `capability_profile.live_input`, projected as `liveInput` in the agent-capability catalog.

### Patch Changes

- Updated dependencies [788ddca]
  - @claudexor/schema@3.16.0
  - @claudexor/arbitration@3.16.0
  - @claudexor/budget@3.16.0
  - @claudexor/config@3.16.0
  - @claudexor/context@3.16.0
  - @claudexor/core@3.16.0
  - @claudexor/delivery@3.16.0
  - @claudexor/event-log@3.16.0
  - @claudexor/gateway@3.16.0
  - @claudexor/policy@3.16.0
  - @claudexor/review@3.16.0
  - @claudexor/workspace@3.16.0
  - @claudexor/synthesis@3.16.0
  - @claudexor/artifact-store@3.16.0
  - @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- @claudexor/arbitration@3.15.1
- @claudexor/artifact-store@3.15.1
- @claudexor/budget@3.15.1
- @claudexor/config@3.15.1
- @claudexor/context@3.15.1
- @claudexor/core@3.15.1
- @claudexor/delivery@3.15.1
- @claudexor/event-log@3.15.1
- @claudexor/gateway@3.15.1
- @claudexor/policy@3.15.1
- @claudexor/review@3.15.1
- @claudexor/schema@3.15.1
- @claudexor/synthesis@3.15.1
- @claudexor/util@3.15.1
- @claudexor/workspace@3.15.1

## 3.15.0

### Patch Changes

- Updated dependencies [3bc8af4]
  - @claudexor/core@3.15.0
  - @claudexor/context@3.15.0
  - @claudexor/delivery@3.15.0
  - @claudexor/gateway@3.15.0
  - @claudexor/review@3.15.0
  - @claudexor/workspace@3.15.0
  - @claudexor/policy@3.15.0
  - @claudexor/arbitration@3.15.0
  - @claudexor/artifact-store@3.15.0
  - @claudexor/budget@3.15.0
  - @claudexor/config@3.15.0
  - @claudexor/event-log@3.15.0
  - @claudexor/schema@3.15.0
  - @claudexor/synthesis@3.15.0
  - @claudexor/util@3.15.0

## 3.14.0

### Minor Changes

- fb42a94: Model admission is the harness's own declaration, honoured on every list it owns.

  `model_inventory_absence` used to govern only a live `models()` answer; every manifest hint list stayed strict by construction, so a settings write, the doctor's configured-model check and the explicit reviewer panel refused any id the shipped list lacked (and `claudexor models` could show nothing beyond that list), so a new vendor model needed a Claudexor release to become usable through them (#338, #340). `validateModel` now takes the list, its source and the declaration with no defaults; the manifest branches of the run gate and the reviewer panel read the declaration; one registry gate (`checkHarnessModel`) replaces the four hand-built copies in the settings write, doctor readiness and the capability catalog.

  Claude, Codex and Cursor declare `advisory` (cursor gains the declaration here; claude's producer lands beside it): their lists prove presence, never absence, so an unlisted explicit model is persisted or forwarded byte-identical and the vendor decides. Each admitting consumer says so once: the settings read-back carries server-owned `notes` (the CLI prints them), the readiness row carries the note in its detail (the text `doctor` prints it too), the per-spawn gate keeps its status event; the agent capability catalog's `configuredModelValid` stays a boolean that reports such an admission as valid without the note (its description says so). raw-api, agy and opencode stay authoritative; the automatic reviewer panel keeps skipping an unlisted family at zero cost; HTTP model operations stay strict against the account catalog read at a named client version. Refusals state observations (which account supplied which list, how many models) instead of guessing a cause such as re-authentication.

  Invariants: INV-104 amended with the owner's approval of 2026-09-24 (CONCEPT-CHANGE): absence is a per-harness declaration honoured on live and manifest lists alike; the settings-write-strict canary moves to agy and `[INV-104:settings-write-advisory]` pins the codex path. INV-105 unchanged (the per-spawn disclosure stays). INV-020/INV-022 hold: `notes` has a producer (the settings write) and readers (the CLI, the canary).

### Patch Changes

- Updated dependencies [2c024ac]
- Updated dependencies [7e615b6]
- Updated dependencies [fb42a94]
  - @claudexor/core@3.14.0
  - @claudexor/schema@3.14.0
  - @claudexor/gateway@3.14.0
  - @claudexor/context@3.14.0
  - @claudexor/delivery@3.14.0
  - @claudexor/review@3.14.0
  - @claudexor/workspace@3.14.0
  - @claudexor/arbitration@3.14.0
  - @claudexor/budget@3.14.0
  - @claudexor/config@3.14.0
  - @claudexor/event-log@3.14.0
  - @claudexor/policy@3.14.0
  - @claudexor/synthesis@3.14.0
  - @claudexor/artifact-store@3.14.0
  - @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/arbitration@3.13.0
- @claudexor/artifact-store@3.13.0
- @claudexor/budget@3.13.0
- @claudexor/config@3.13.0
- @claudexor/context@3.13.0
- @claudexor/core@3.13.0
- @claudexor/delivery@3.13.0
- @claudexor/event-log@3.13.0
- @claudexor/gateway@3.13.0
- @claudexor/policy@3.13.0
- @claudexor/review@3.13.0
- @claudexor/schema@3.13.0
- @claudexor/synthesis@3.13.0
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
  - @claudexor/arbitration@3.12.10
  - @claudexor/budget@3.12.10
  - @claudexor/config@3.12.10
  - @claudexor/context@3.12.10
  - @claudexor/delivery@3.12.10
  - @claudexor/event-log@3.12.10
  - @claudexor/gateway@3.12.10
  - @claudexor/policy@3.12.10
  - @claudexor/review@3.12.10
  - @claudexor/workspace@3.12.10
  - @claudexor/synthesis@3.12.10
  - @claudexor/artifact-store@3.12.10
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
  - @claudexor/core@3.12.9
  - @claudexor/arbitration@3.12.9
  - @claudexor/budget@3.12.9
  - @claudexor/config@3.12.9
  - @claudexor/context@3.12.9
  - @claudexor/delivery@3.12.9
  - @claudexor/event-log@3.12.9
  - @claudexor/gateway@3.12.9
  - @claudexor/policy@3.12.9
  - @claudexor/review@3.12.9
  - @claudexor/workspace@3.12.9
  - @claudexor/synthesis@3.12.9
  - @claudexor/artifact-store@3.12.9
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- @claudexor/arbitration@3.12.8
- @claudexor/artifact-store@3.12.8
- @claudexor/budget@3.12.8
- @claudexor/config@3.12.8
- @claudexor/context@3.12.8
- @claudexor/core@3.12.8
- @claudexor/delivery@3.12.8
- @claudexor/event-log@3.12.8
- @claudexor/gateway@3.12.8
- @claudexor/policy@3.12.8
- @claudexor/review@3.12.8
- @claudexor/schema@3.12.8
- @claudexor/synthesis@3.12.8
- @claudexor/util@3.12.8
- @claudexor/workspace@3.12.8

## 3.12.7

### Patch Changes

- Restore adapter-created nulls for optional review fields before original-schema validation, preserving the caller contract and substantive findings. Codex Responses failure evidence now records monotonic chunk timing and deterministic interrupted-stream diagnostics without adding automatic retries.
- Updated dependencies
  - @claudexor/schema@3.12.7
  - @claudexor/arbitration@3.12.7
  - @claudexor/budget@3.12.7
  - @claudexor/config@3.12.7
  - @claudexor/context@3.12.7
  - @claudexor/core@3.12.7
  - @claudexor/delivery@3.12.7
  - @claudexor/event-log@3.12.7
  - @claudexor/gateway@3.12.7
  - @claudexor/policy@3.12.7
  - @claudexor/review@3.12.7
  - @claudexor/workspace@3.12.7
  - @claudexor/synthesis@3.12.7
  - @claudexor/artifact-store@3.12.7
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- @claudexor/arbitration@3.12.6
- @claudexor/artifact-store@3.12.6
- @claudexor/budget@3.12.6
- @claudexor/config@3.12.6
- @claudexor/context@3.12.6
- @claudexor/core@3.12.6
- @claudexor/delivery@3.12.6
- @claudexor/event-log@3.12.6
- @claudexor/gateway@3.12.6
- @claudexor/policy@3.12.6
- @claudexor/review@3.12.6
- @claudexor/schema@3.12.6
- @claudexor/synthesis@3.12.6
- @claudexor/util@3.12.6
- @claudexor/workspace@3.12.6

## 3.12.5

### Patch Changes

- State a served-model mismatch on a model operation as the typed `modelMismatch` result fact without changing its outcome, rank an account that recently answered a model's request with a different model after the other selectable accounts for later Auto selections (a 30-minute in-memory observation that never excludes an account, a pin or a preferred account), and send a turn the same account served with another model through its canonical content and tool calls instead of refusing the next request with `invalid_continuation`.
- Updated dependencies
  - @claudexor/schema@3.12.5
  - @claudexor/arbitration@3.12.5
  - @claudexor/budget@3.12.5
  - @claudexor/config@3.12.5
  - @claudexor/context@3.12.5
  - @claudexor/core@3.12.5
  - @claudexor/delivery@3.12.5
  - @claudexor/event-log@3.12.5
  - @claudexor/gateway@3.12.5
  - @claudexor/policy@3.12.5
  - @claudexor/review@3.12.5
  - @claudexor/workspace@3.12.5
  - @claudexor/synthesis@3.12.5
  - @claudexor/artifact-store@3.12.5
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- @claudexor/arbitration@3.12.4
- @claudexor/artifact-store@3.12.4
- @claudexor/budget@3.12.4
- @claudexor/config@3.12.4
- @claudexor/context@3.12.4
- @claudexor/core@3.12.4
- @claudexor/delivery@3.12.4
- @claudexor/event-log@3.12.4
- @claudexor/gateway@3.12.4
- @claudexor/policy@3.12.4
- @claudexor/review@3.12.4
- @claudexor/schema@3.12.4
- @claudexor/synthesis@3.12.4
- @claudexor/util@3.12.4
- @claudexor/workspace@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/arbitration@3.12.3
- @claudexor/artifact-store@3.12.3
- @claudexor/budget@3.12.3
- @claudexor/config@3.12.3
- @claudexor/context@3.12.3
- @claudexor/core@3.12.3
- @claudexor/delivery@3.12.3
- @claudexor/event-log@3.12.3
- @claudexor/gateway@3.12.3
- @claudexor/policy@3.12.3
- @claudexor/review@3.12.3
- @claudexor/schema@3.12.3
- @claudexor/synthesis@3.12.3
- @claudexor/util@3.12.3
- @claudexor/workspace@3.12.3

## 3.12.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.2
  - @claudexor/arbitration@3.12.2
  - @claudexor/budget@3.12.2
  - @claudexor/config@3.12.2
  - @claudexor/context@3.12.2
  - @claudexor/core@3.12.2
  - @claudexor/delivery@3.12.2
  - @claudexor/event-log@3.12.2
  - @claudexor/gateway@3.12.2
  - @claudexor/policy@3.12.2
  - @claudexor/review@3.12.2
  - @claudexor/workspace@3.12.2
  - @claudexor/synthesis@3.12.2
  - @claudexor/artifact-store@3.12.2
  - @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.1
  - @claudexor/arbitration@3.12.1
  - @claudexor/budget@3.12.1
  - @claudexor/config@3.12.1
  - @claudexor/context@3.12.1
  - @claudexor/core@3.12.1
  - @claudexor/delivery@3.12.1
  - @claudexor/event-log@3.12.1
  - @claudexor/gateway@3.12.1
  - @claudexor/policy@3.12.1
  - @claudexor/review@3.12.1
  - @claudexor/workspace@3.12.1
  - @claudexor/synthesis@3.12.1
  - @claudexor/artifact-store@3.12.1
  - @claudexor/util@3.12.1

## 3.12.0

### Patch Changes

- Updated dependencies [217d53f]
  - @claudexor/schema@3.12.0
  - @claudexor/arbitration@3.12.0
  - @claudexor/budget@3.12.0
  - @claudexor/config@3.12.0
  - @claudexor/context@3.12.0
  - @claudexor/core@3.12.0
  - @claudexor/delivery@3.12.0
  - @claudexor/event-log@3.12.0
  - @claudexor/gateway@3.12.0
  - @claudexor/policy@3.12.0
  - @claudexor/review@3.12.0
  - @claudexor/workspace@3.12.0
  - @claudexor/synthesis@3.12.0
  - @claudexor/artifact-store@3.12.0
  - @claudexor/util@3.12.0

## 3.11.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.11.0
  - @claudexor/arbitration@3.11.0
  - @claudexor/budget@3.11.0
  - @claudexor/config@3.11.0
  - @claudexor/context@3.11.0
  - @claudexor/core@3.11.0
  - @claudexor/delivery@3.11.0
  - @claudexor/event-log@3.11.0
  - @claudexor/gateway@3.11.0
  - @claudexor/policy@3.11.0
  - @claudexor/review@3.11.0
  - @claudexor/workspace@3.11.0
  - @claudexor/synthesis@3.11.0
  - @claudexor/artifact-store@3.11.0
  - @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- @claudexor/arbitration@3.10.5
- @claudexor/artifact-store@3.10.5
- @claudexor/budget@3.10.5
- @claudexor/config@3.10.5
- @claudexor/context@3.10.5
- @claudexor/core@3.10.5
- @claudexor/delivery@3.10.5
- @claudexor/event-log@3.10.5
- @claudexor/gateway@3.10.5
- @claudexor/policy@3.10.5
- @claudexor/review@3.10.5
- @claudexor/schema@3.10.5
- @claudexor/synthesis@3.10.5
- @claudexor/util@3.10.5
- @claudexor/workspace@3.10.5

## 3.10.4

### Patch Changes

- Codex model operations carry the caller's live `x-codex-turn-state` transport continuation on the existing route-bound opaque envelope (opt-in per request, first successful header captured before the body, replayed unchanged on the matching route, empty on a changed route). Attempt telemetry, run telemetry and run summaries gain an additive normalized `input_token_usage` / `inputTokenUsage` object (complete input total, cache reads, cache writes; null stays unknown) folded strictly across contributions; legacy token fields keep their harness-specific meanings.
- Updated dependencies
  - @claudexor/schema@3.10.4
  - @claudexor/arbitration@3.10.4
  - @claudexor/budget@3.10.4
  - @claudexor/config@3.10.4
  - @claudexor/context@3.10.4
  - @claudexor/core@3.10.4
  - @claudexor/delivery@3.10.4
  - @claudexor/event-log@3.10.4
  - @claudexor/gateway@3.10.4
  - @claudexor/policy@3.10.4
  - @claudexor/review@3.10.4
  - @claudexor/workspace@3.10.4
  - @claudexor/synthesis@3.10.4
  - @claudexor/artifact-store@3.10.4
  - @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- @claudexor/arbitration@3.10.3
- @claudexor/artifact-store@3.10.3
- @claudexor/budget@3.10.3
- @claudexor/config@3.10.3
- @claudexor/context@3.10.3
- @claudexor/core@3.10.3
- @claudexor/delivery@3.10.3
- @claudexor/event-log@3.10.3
- @claudexor/gateway@3.10.3
- @claudexor/policy@3.10.3
- @claudexor/review@3.10.3
- @claudexor/schema@3.10.3
- @claudexor/synthesis@3.10.3
- @claudexor/util@3.10.3
- @claudexor/workspace@3.10.3

## 3.10.2

### Patch Changes

- Preserve useful contradictory Council drafts as explicitly unverified merger inputs and move journal maintenance after admission, including Windows pending-tail recovery and native coverage.
- Updated dependencies
  - @claudexor/schema@3.10.2
  - @claudexor/arbitration@3.10.2
  - @claudexor/budget@3.10.2
  - @claudexor/config@3.10.2
  - @claudexor/context@3.10.2
  - @claudexor/core@3.10.2
  - @claudexor/delivery@3.10.2
  - @claudexor/event-log@3.10.2
  - @claudexor/gateway@3.10.2
  - @claudexor/policy@3.10.2
  - @claudexor/review@3.10.2
  - @claudexor/workspace@3.10.2
  - @claudexor/synthesis@3.10.2
  - @claudexor/artifact-store@3.10.2
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.1
  - @claudexor/arbitration@3.10.1
  - @claudexor/budget@3.10.1
  - @claudexor/config@3.10.1
  - @claudexor/context@3.10.1
  - @claudexor/core@3.10.1
  - @claudexor/delivery@3.10.1
  - @claudexor/event-log@3.10.1
  - @claudexor/gateway@3.10.1
  - @claudexor/policy@3.10.1
  - @claudexor/review@3.10.1
  - @claudexor/workspace@3.10.1
  - @claudexor/synthesis@3.10.1
  - @claudexor/artifact-store@3.10.1
  - @claudexor/util@3.10.1

## 3.10.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.10.0
  - @claudexor/schema@3.10.0
  - @claudexor/context@3.10.0
  - @claudexor/delivery@3.10.0
  - @claudexor/gateway@3.10.0
  - @claudexor/review@3.10.0
  - @claudexor/workspace@3.10.0
  - @claudexor/arbitration@3.10.0
  - @claudexor/budget@3.10.0
  - @claudexor/config@3.10.0
  - @claudexor/event-log@3.10.0
  - @claudexor/policy@3.10.0
  - @claudexor/synthesis@3.10.0
  - @claudexor/artifact-store@3.10.0
  - @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Make internal model review opt-in for ordinary Agent work, independently of executor selection. Preserve explicit panels, Best-of, and requested review cycles; persist intent separately from results and retain historical behavior on replay. Deliberately unreviewed changes remain normally applicable with honest Not reviewed status while required checks and patch integrity remain enforced. Expose the same choice through API, CLI, MCP, ACP, and the native composer.
- Updated dependencies
- Updated dependencies
  - @claudexor/schema@3.9.8
  - @claudexor/arbitration@3.9.8
  - @claudexor/delivery@3.9.8
  - @claudexor/budget@3.9.8
  - @claudexor/config@3.9.8
  - @claudexor/context@3.9.8
  - @claudexor/core@3.9.8
  - @claudexor/event-log@3.9.8
  - @claudexor/gateway@3.9.8
  - @claudexor/policy@3.9.8
  - @claudexor/review@3.9.8
  - @claudexor/workspace@3.9.8
  - @claudexor/synthesis@3.9.8
  - @claudexor/artifact-store@3.9.8
  - @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/arbitration@3.9.7
- @claudexor/artifact-store@3.9.7
- @claudexor/budget@3.9.7
- @claudexor/config@3.9.7
- @claudexor/context@3.9.7
- @claudexor/core@3.9.7
- @claudexor/delivery@3.9.7
- @claudexor/event-log@3.9.7
- @claudexor/gateway@3.9.7
- @claudexor/policy@3.9.7
- @claudexor/review@3.9.7
- @claudexor/schema@3.9.7
- @claudexor/synthesis@3.9.7
- @claudexor/util@3.9.7
- @claudexor/workspace@3.9.7

## 3.9.6

### Patch Changes

- Updated dependencies [dd02e0a]
  - @claudexor/workspace@3.9.6
  - @claudexor/delivery@3.9.6
  - @claudexor/review@3.9.6
  - @claudexor/arbitration@3.9.6
  - @claudexor/artifact-store@3.9.6
  - @claudexor/budget@3.9.6
  - @claudexor/config@3.9.6
  - @claudexor/context@3.9.6
  - @claudexor/core@3.9.6
  - @claudexor/event-log@3.9.6
  - @claudexor/gateway@3.9.6
  - @claudexor/policy@3.9.6
  - @claudexor/schema@3.9.6
  - @claudexor/synthesis@3.9.6
  - @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- @claudexor/arbitration@3.9.5
- @claudexor/artifact-store@3.9.5
- @claudexor/budget@3.9.5
- @claudexor/config@3.9.5
- @claudexor/context@3.9.5
- @claudexor/core@3.9.5
- @claudexor/delivery@3.9.5
- @claudexor/event-log@3.9.5
- @claudexor/gateway@3.9.5
- @claudexor/policy@3.9.5
- @claudexor/review@3.9.5
- @claudexor/schema@3.9.5
- @claudexor/synthesis@3.9.5
- @claudexor/util@3.9.5
- @claudexor/workspace@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/arbitration@3.9.4
- @claudexor/artifact-store@3.9.4
- @claudexor/budget@3.9.4
- @claudexor/config@3.9.4
- @claudexor/context@3.9.4
- @claudexor/core@3.9.4
- @claudexor/delivery@3.9.4
- @claudexor/event-log@3.9.4
- @claudexor/gateway@3.9.4
- @claudexor/policy@3.9.4
- @claudexor/review@3.9.4
- @claudexor/schema@3.9.4
- @claudexor/synthesis@3.9.4
- @claudexor/util@3.9.4
- @claudexor/workspace@3.9.4

## 3.9.3

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.3
  - @claudexor/arbitration@3.9.3
  - @claudexor/budget@3.9.3
  - @claudexor/config@3.9.3
  - @claudexor/context@3.9.3
  - @claudexor/core@3.9.3
  - @claudexor/delivery@3.9.3
  - @claudexor/event-log@3.9.3
  - @claudexor/gateway@3.9.3
  - @claudexor/policy@3.9.3
  - @claudexor/review@3.9.3
  - @claudexor/workspace@3.9.3
  - @claudexor/synthesis@3.9.3
  - @claudexor/artifact-store@3.9.3
  - @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- @claudexor/arbitration@3.9.2
- @claudexor/artifact-store@3.9.2
- @claudexor/budget@3.9.2
- @claudexor/config@3.9.2
- @claudexor/context@3.9.2
- @claudexor/core@3.9.2
- @claudexor/delivery@3.9.2
- @claudexor/event-log@3.9.2
- @claudexor/gateway@3.9.2
- @claudexor/policy@3.9.2
- @claudexor/review@3.9.2
- @claudexor/schema@3.9.2
- @claudexor/synthesis@3.9.2
- @claudexor/util@3.9.2
- @claudexor/workspace@3.9.2

## 3.9.1

### Patch Changes

- @claudexor/arbitration@3.9.1
- @claudexor/artifact-store@3.9.1
- @claudexor/budget@3.9.1
- @claudexor/config@3.9.1
- @claudexor/context@3.9.1
- @claudexor/core@3.9.1
- @claudexor/delivery@3.9.1
- @claudexor/event-log@3.9.1
- @claudexor/gateway@3.9.1
- @claudexor/policy@3.9.1
- @claudexor/review@3.9.1
- @claudexor/schema@3.9.1
- @claudexor/synthesis@3.9.1
- @claudexor/util@3.9.1
- @claudexor/workspace@3.9.1

## 3.9.0

### Patch Changes

- Updated dependencies [d9cccac]
- Updated dependencies [69500f8]
- Updated dependencies [e39c57b]
- Updated dependencies [fd623ff]
- Updated dependencies [278e436]
  - @claudexor/schema@3.9.0
  - @claudexor/arbitration@3.9.0
  - @claudexor/budget@3.9.0
  - @claudexor/config@3.9.0
  - @claudexor/context@3.9.0
  - @claudexor/core@3.9.0
  - @claudexor/delivery@3.9.0
  - @claudexor/event-log@3.9.0
  - @claudexor/gateway@3.9.0
  - @claudexor/policy@3.9.0
  - @claudexor/review@3.9.0
  - @claudexor/workspace@3.9.0
  - @claudexor/synthesis@3.9.0
  - @claudexor/artifact-store@3.9.0
  - @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- Preserve typed quota failures for exhausted implicit profile lanes while
  allowing a surviving sibling harness to continue an automatic pool run.
  - @claudexor/arbitration@3.8.4
  - @claudexor/artifact-store@3.8.4
  - @claudexor/budget@3.8.4
  - @claudexor/config@3.8.4
  - @claudexor/context@3.8.4
  - @claudexor/core@3.8.4
  - @claudexor/delivery@3.8.4
  - @claudexor/event-log@3.8.4
  - @claudexor/gateway@3.8.4
  - @claudexor/policy@3.8.4
  - @claudexor/review@3.8.4
  - @claudexor/schema@3.8.4
  - @claudexor/synthesis@3.8.4
  - @claudexor/util@3.8.4
  - @claudexor/workspace@3.8.4

## 3.8.3

### Patch Changes

- @claudexor/arbitration@3.8.3
- @claudexor/artifact-store@3.8.3
- @claudexor/budget@3.8.3
- @claudexor/config@3.8.3
- @claudexor/context@3.8.3
- @claudexor/core@3.8.3
- @claudexor/delivery@3.8.3
- @claudexor/event-log@3.8.3
- @claudexor/gateway@3.8.3
- @claudexor/policy@3.8.3
- @claudexor/review@3.8.3
- @claudexor/schema@3.8.3
- @claudexor/synthesis@3.8.3
- @claudexor/util@3.8.3
- @claudexor/workspace@3.8.3

## 3.8.2

### Patch Changes

- @claudexor/arbitration@3.8.2
- @claudexor/artifact-store@3.8.2
- @claudexor/budget@3.8.2
- @claudexor/config@3.8.2
- @claudexor/context@3.8.2
- @claudexor/core@3.8.2
- @claudexor/delivery@3.8.2
- @claudexor/event-log@3.8.2
- @claudexor/gateway@3.8.2
- @claudexor/policy@3.8.2
- @claudexor/review@3.8.2
- @claudexor/schema@3.8.2
- @claudexor/synthesis@3.8.2
- @claudexor/util@3.8.2
- @claudexor/workspace@3.8.2

## 3.8.1

### Patch Changes

- 2794ec7: Remove the engine-owned outer Seatbelt wrapper and restore each harness's
  native access policy. Delegated mutating runs now keep stable project identity
  separate from their disposable execution workspace, active requests use
  `readonly`, `workspace_write`, or explicitly trusted `full`, and historical
  outer-confinement artifacts remain readable without enabling new retired-mode
  runs.
- Updated dependencies [ce6dba1]
- Updated dependencies [2794ec7]
  - @claudexor/core@3.8.1
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1
  - @claudexor/workspace@3.8.1
  - @claudexor/context@3.8.1
  - @claudexor/delivery@3.8.1
  - @claudexor/gateway@3.8.1
  - @claudexor/review@3.8.1
  - @claudexor/arbitration@3.8.1
  - @claudexor/budget@3.8.1
  - @claudexor/config@3.8.1
  - @claudexor/event-log@3.8.1
  - @claudexor/policy@3.8.1
  - @claudexor/artifact-store@3.8.1
  - @claudexor/synthesis@3.8.1

## 3.8.0

### Patch Changes

- 6054b7d: Make credential-profile custody and managed setup login platform-aware, with an exact Windows Antigravity one-binding policy, vendor-proven doctor/quota results, durable ambiguity handling, and host-resolved terminal capability projection.
- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/core@3.8.0
  - @claudexor/arbitration@3.8.0
  - @claudexor/budget@3.8.0
  - @claudexor/config@3.8.0
  - @claudexor/context@3.8.0
  - @claudexor/delivery@3.8.0
  - @claudexor/event-log@3.8.0
  - @claudexor/gateway@3.8.0
  - @claudexor/policy@3.8.0
  - @claudexor/review@3.8.0
  - @claudexor/workspace@3.8.0
  - @claudexor/synthesis@3.8.0
  - @claudexor/artifact-store@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

- @claudexor/arbitration@3.7.0
- @claudexor/artifact-store@3.7.0
- @claudexor/budget@3.7.0
- @claudexor/config@3.7.0
- @claudexor/context@3.7.0
- @claudexor/core@3.7.0
- @claudexor/delivery@3.7.0
- @claudexor/event-log@3.7.0
- @claudexor/gateway@3.7.0
- @claudexor/policy@3.7.0
- @claudexor/review@3.7.0
- @claudexor/schema@3.7.0
- @claudexor/synthesis@3.7.0
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
  - @claudexor/workspace@3.6.0
  - @claudexor/arbitration@3.6.0
  - @claudexor/budget@3.6.0
  - @claudexor/config@3.6.0
  - @claudexor/context@3.6.0
  - @claudexor/core@3.6.0
  - @claudexor/delivery@3.6.0
  - @claudexor/event-log@3.6.0
  - @claudexor/gateway@3.6.0
  - @claudexor/policy@3.6.0
  - @claudexor/review@3.6.0
  - @claudexor/synthesis@3.6.0
  - @claudexor/artifact-store@3.6.0
  - @claudexor/util@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0
  - @claudexor/artifact-store@3.5.0
  - @claudexor/budget@3.5.0
  - @claudexor/config@3.5.0
  - @claudexor/context@3.5.0
  - @claudexor/core@3.5.0
  - @claudexor/delivery@3.5.0
  - @claudexor/event-log@3.5.0
  - @claudexor/policy@3.5.0
  - @claudexor/review@3.5.0
  - @claudexor/schema@3.5.0
  - @claudexor/workspace@3.5.0
  - @claudexor/gateway@3.5.0
  - @claudexor/arbitration@3.5.0
  - @claudexor/synthesis@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/arbitration@3.4.2
- @claudexor/artifact-store@3.4.2
- @claudexor/budget@3.4.2
- @claudexor/config@3.4.2
- @claudexor/context@3.4.2
- @claudexor/core@3.4.2
- @claudexor/delivery@3.4.2
- @claudexor/event-log@3.4.2
- @claudexor/gateway@3.4.2
- @claudexor/policy@3.4.2
- @claudexor/review@3.4.2
- @claudexor/schema@3.4.2
- @claudexor/synthesis@3.4.2
- @claudexor/util@3.4.2
- @claudexor/workspace@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/arbitration@3.4.1
- @claudexor/artifact-store@3.4.1
- @claudexor/budget@3.4.1
- @claudexor/config@3.4.1
- @claudexor/context@3.4.1
- @claudexor/core@3.4.1
- @claudexor/delivery@3.4.1
- @claudexor/event-log@3.4.1
- @claudexor/gateway@3.4.1
- @claudexor/policy@3.4.1
- @claudexor/review@3.4.1
- @claudexor/schema@3.4.1
- @claudexor/synthesis@3.4.1
- @claudexor/util@3.4.1
- @claudexor/workspace@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/arbitration@3.4.0
- @claudexor/artifact-store@3.4.0
- @claudexor/budget@3.4.0
- @claudexor/config@3.4.0
- @claudexor/context@3.4.0
- @claudexor/core@3.4.0
- @claudexor/delivery@3.4.0
- @claudexor/event-log@3.4.0
- @claudexor/gateway@3.4.0
- @claudexor/policy@3.4.0
- @claudexor/review@3.4.0
- @claudexor/schema@3.4.0
- @claudexor/synthesis@3.4.0
- @claudexor/util@3.4.0
- @claudexor/workspace@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/arbitration@3.3.16
- @claudexor/artifact-store@3.3.16
- @claudexor/budget@3.3.16
- @claudexor/config@3.3.16
- @claudexor/context@3.3.16
- @claudexor/core@3.3.16
- @claudexor/delivery@3.3.16
- @claudexor/event-log@3.3.16
- @claudexor/gateway@3.3.16
- @claudexor/policy@3.3.16
- @claudexor/review@3.3.16
- @claudexor/schema@3.3.16
- @claudexor/synthesis@3.3.16
- @claudexor/util@3.3.16
- @claudexor/workspace@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/arbitration@3.3.15
- @claudexor/artifact-store@3.3.15
- @claudexor/budget@3.3.15
- @claudexor/config@3.3.15
- @claudexor/context@3.3.15
- @claudexor/core@3.3.15
- @claudexor/delivery@3.3.15
- @claudexor/event-log@3.3.15
- @claudexor/gateway@3.3.15
- @claudexor/policy@3.3.15
- @claudexor/review@3.3.15
- @claudexor/schema@3.3.15
- @claudexor/synthesis@3.3.15
- @claudexor/util@3.3.15
- @claudexor/workspace@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/arbitration@3.3.14
- @claudexor/artifact-store@3.3.14
- @claudexor/budget@3.3.14
- @claudexor/config@3.3.14
- @claudexor/context@3.3.14
- @claudexor/core@3.3.14
- @claudexor/delivery@3.3.14
- @claudexor/event-log@3.3.14
- @claudexor/gateway@3.3.14
- @claudexor/policy@3.3.14
- @claudexor/review@3.3.14
- @claudexor/schema@3.3.14
- @claudexor/synthesis@3.3.14
- @claudexor/util@3.3.14
- @claudexor/workspace@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/arbitration@3.3.13
- @claudexor/artifact-store@3.3.13
- @claudexor/budget@3.3.13
- @claudexor/config@3.3.13
- @claudexor/context@3.3.13
- @claudexor/core@3.3.13
- @claudexor/delivery@3.3.13
- @claudexor/event-log@3.3.13
- @claudexor/gateway@3.3.13
- @claudexor/policy@3.3.13
- @claudexor/review@3.3.13
- @claudexor/schema@3.3.13
- @claudexor/synthesis@3.3.13
- @claudexor/util@3.3.13
- @claudexor/workspace@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/arbitration@3.3.12
- @claudexor/artifact-store@3.3.12
- @claudexor/budget@3.3.12
- @claudexor/config@3.3.12
- @claudexor/context@3.3.12
- @claudexor/core@3.3.12
- @claudexor/delivery@3.3.12
- @claudexor/event-log@3.3.12
- @claudexor/gateway@3.3.12
- @claudexor/policy@3.3.12
- @claudexor/review@3.3.12
- @claudexor/schema@3.3.12
- @claudexor/synthesis@3.3.12
- @claudexor/util@3.3.12
- @claudexor/workspace@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/arbitration@3.3.0
- @claudexor/artifact-store@3.3.0
- @claudexor/budget@3.3.0
- @claudexor/config@3.3.0
- @claudexor/context@3.3.0
- @claudexor/core@3.3.0
- @claudexor/delivery@3.3.0
- @claudexor/event-log@3.3.0
- @claudexor/gateway@3.3.0
- @claudexor/policy@3.3.0
- @claudexor/review@3.3.0
- @claudexor/schema@3.3.0
- @claudexor/synthesis@3.3.0
- @claudexor/util@3.3.0
- @claudexor/workspace@3.3.0

## 3.2.1

### Patch Changes

- Resolve the effective model and opt-in rotated account before quota filters the route, while preserving model-scoped headroom for fallback, downgrade, and convergence attempts.
- @claudexor/arbitration@3.2.1
- @claudexor/artifact-store@3.2.1
- @claudexor/budget@3.2.1
- @claudexor/config@3.2.1
- @claudexor/context@3.2.1
- @claudexor/core@3.2.1
- @claudexor/delivery@3.2.1
- @claudexor/event-log@3.2.1
- @claudexor/gateway@3.2.1
- @claudexor/policy@3.2.1
- @claudexor/review@3.2.1
- @claudexor/schema@3.2.1
- @claudexor/synthesis@3.2.1
- @claudexor/util@3.2.1
- @claudexor/workspace@3.2.1

## 3.2.0

### Patch Changes

- Centralize Plan attachment and pool admission, finite-or-disabled interactions, credential readiness and rotation, Git preconditions, useful-progress inactivity, and terminal RunFacts presentation.
- Bound Deep Research synthesis from admission through teardown, preserve
  terminal usage/death-proof evidence without accepting late output, and settle
  every admitted planner, scout, council, and continuation path exactly once.
- @claudexor/arbitration@3.2.0
- @claudexor/artifact-store@3.2.0
- @claudexor/budget@3.2.0
- @claudexor/config@3.2.0
- @claudexor/context@3.2.0
- @claudexor/core@3.2.0
- @claudexor/delivery@3.2.0
- @claudexor/event-log@3.2.0
- @claudexor/gateway@3.2.0
- @claudexor/policy@3.2.0
- @claudexor/review@3.2.0
- @claudexor/schema@3.2.0
- @claudexor/synthesis@3.2.0
- @claudexor/util@3.2.0
- @claudexor/workspace@3.2.0

## 3.1.2

### Patch Changes

- Restore Delegate in packaged installs through the exact daemon self-entry; enforce required MCP startup, bounded shared parent/child budget and cancellation authority, typed lineage and degradation receipts, and durable CLI/macOS projections across reload and reconnect.
- Updated dependencies
  - @claudexor/budget@3.1.2
  - @claudexor/core@3.1.2
  - @claudexor/event-log@3.1.2
  - @claudexor/schema@3.1.2
  - @claudexor/context@3.1.2
  - @claudexor/delivery@3.1.2
  - @claudexor/gateway@3.1.2
  - @claudexor/review@3.1.2
  - @claudexor/workspace@3.1.2
  - @claudexor/arbitration@3.1.2
  - @claudexor/config@3.1.2
  - @claudexor/policy@3.1.2
  - @claudexor/synthesis@3.1.2
  - @claudexor/artifact-store@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Engine honesty fixes: a delivered plan now survives an unrecovered tool error
  instead of being escalated to a harness error before finalization, an empty
  thrown message can no longer terminalize a failed harness run as a clean
  success, and the automatic economy-ranking pass reads one pinned clock for all
  candidates instead of a fresh timestamp per comparison.
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @claudexor/core@3.1.1
  - @claudexor/budget@3.1.1
  - @claudexor/review@3.1.1
  - @claudexor/schema@3.1.1
  - @claudexor/context@3.1.1
  - @claudexor/delivery@3.1.1
  - @claudexor/gateway@3.1.1
  - @claudexor/workspace@3.1.1
  - @claudexor/arbitration@3.1.1
  - @claudexor/config@3.1.1
  - @claudexor/event-log@3.1.1
  - @claudexor/policy@3.1.1
  - @claudexor/synthesis@3.1.1
  - @claudexor/artifact-store@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Minor Changes

- c3b7ece: Support declared JSON Schema draft-07 and draft 2020-12 output contracts, publish the supported dialect catalog, and record the selected dialect plus stable schema hash in structured-output receipts. Local JSON Pointer references are inlined only for native provider transport while the original schema remains the validation authority.

### Patch Changes

- Updated dependencies [c3b7ece]
- Updated dependencies [6e36993]
  - @claudexor/schema@3.1.0
  - @claudexor/core@3.1.0
  - @claudexor/arbitration@3.1.0
  - @claudexor/budget@3.1.0
  - @claudexor/config@3.1.0
  - @claudexor/context@3.1.0
  - @claudexor/delivery@3.1.0
  - @claudexor/event-log@3.1.0
  - @claudexor/gateway@3.1.0
  - @claudexor/policy@3.1.0
  - @claudexor/review@3.1.0
  - @claudexor/workspace@3.1.0
  - @claudexor/synthesis@3.1.0
  - @claudexor/artifact-store@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/arbitration@3.0.3
- @claudexor/artifact-store@3.0.3
- @claudexor/budget@3.0.3
- @claudexor/config@3.0.3
- @claudexor/context@3.0.3
- @claudexor/core@3.0.3
- @claudexor/delivery@3.0.3
- @claudexor/event-log@3.0.3
- @claudexor/gateway@3.0.3
- @claudexor/policy@3.0.3
- @claudexor/review@3.0.3
- @claudexor/schema@3.0.3
- @claudexor/synthesis@3.0.3
- @claudexor/util@3.0.3
- @claudexor/workspace@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/arbitration@3.0.0
- @claudexor/artifact-store@3.0.0
- @claudexor/budget@3.0.0
- @claudexor/config@3.0.0
- @claudexor/context@3.0.0
- @claudexor/core@3.0.0
- @claudexor/delivery@3.0.0
- @claudexor/event-log@3.0.0
- @claudexor/gateway@3.0.0
- @claudexor/policy@3.0.0
- @claudexor/review@3.0.0
- @claudexor/schema@3.0.0
- @claudexor/synthesis@3.0.0
- @claudexor/util@3.0.0
- @claudexor/workspace@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/arbitration@2.1.3
- @claudexor/artifact-store@2.1.3
- @claudexor/budget@2.1.3
- @claudexor/config@2.1.3
- @claudexor/context@2.1.3
- @claudexor/core@2.1.3
- @claudexor/delivery@2.1.3
- @claudexor/event-log@2.1.3
- @claudexor/gateway@2.1.3
- @claudexor/interview@2.1.3
- @claudexor/policy@2.1.3
- @claudexor/review@2.1.3
- @claudexor/schema@2.1.3
- @claudexor/synthesis@2.1.3
- @claudexor/util@2.1.3
- @claudexor/workspace@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/arbitration@2.1.2
- @claudexor/artifact-store@2.1.2
- @claudexor/budget@2.1.2
- @claudexor/config@2.1.2
- @claudexor/context@2.1.2
- @claudexor/core@2.1.2
- @claudexor/delivery@2.1.2
- @claudexor/event-log@2.1.2
- @claudexor/gateway@2.1.2
- @claudexor/interview@2.1.2
- @claudexor/policy@2.1.2
- @claudexor/review@2.1.2
- @claudexor/schema@2.1.2
- @claudexor/synthesis@2.1.2
- @claudexor/util@2.1.2
- @claudexor/workspace@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/arbitration@2.1.1
- @claudexor/artifact-store@2.1.1
- @claudexor/budget@2.1.1
- @claudexor/config@2.1.1
- @claudexor/context@2.1.1
- @claudexor/core@2.1.1
- @claudexor/delivery@2.1.1
- @claudexor/event-log@2.1.1
- @claudexor/gateway@2.1.1
- @claudexor/interview@2.1.1
- @claudexor/policy@2.1.1
- @claudexor/review@2.1.1
- @claudexor/schema@2.1.1
- @claudexor/synthesis@2.1.1
- @claudexor/util@2.1.1
- @claudexor/workspace@2.1.1

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
  - @claudexor/core@2.1.0
  - @claudexor/config@2.1.0
  - @claudexor/gateway@2.1.0
  - @claudexor/arbitration@2.1.0
  - @claudexor/budget@2.1.0
  - @claudexor/context@2.1.0
  - @claudexor/delivery@2.1.0
  - @claudexor/event-log@2.1.0
  - @claudexor/interview@2.1.0
  - @claudexor/policy@2.1.0
  - @claudexor/review@2.1.0
  - @claudexor/workspace@2.1.0
  - @claudexor/synthesis@2.1.0
  - @claudexor/artifact-store@2.1.0
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/arbitration@2.0.2
- @claudexor/artifact-store@2.0.2
- @claudexor/budget@2.0.2
- @claudexor/config@2.0.2
- @claudexor/context@2.0.2
- @claudexor/core@2.0.2
- @claudexor/delivery@2.0.2
- @claudexor/event-log@2.0.2
- @claudexor/gateway@2.0.2
- @claudexor/interview@2.0.2
- @claudexor/policy@2.0.2
- @claudexor/review@2.0.2
- @claudexor/schema@2.0.2
- @claudexor/synthesis@2.0.2
- @claudexor/util@2.0.2
- @claudexor/workspace@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/arbitration@2.0.1
- @claudexor/artifact-store@2.0.1
- @claudexor/budget@2.0.1
- @claudexor/config@2.0.1
- @claudexor/context@2.0.1
- @claudexor/core@2.0.1
- @claudexor/delivery@2.0.1
- @claudexor/event-log@2.0.1
- @claudexor/gateway@2.0.1
- @claudexor/interview@2.0.1
- @claudexor/policy@2.0.1
- @claudexor/review@2.0.1
- @claudexor/schema@2.0.1
- @claudexor/synthesis@2.0.1
- @claudexor/util@2.0.1
- @claudexor/workspace@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/arbitration@2.0.0
- @claudexor/artifact-store@2.0.0
- @claudexor/budget@2.0.0
- @claudexor/config@2.0.0
- @claudexor/context@2.0.0
- @claudexor/core@2.0.0
- @claudexor/delivery@2.0.0
- @claudexor/event-log@2.0.0
- @claudexor/gateway@2.0.0
- @claudexor/interview@2.0.0
- @claudexor/policy@2.0.0
- @claudexor/review@2.0.0
- @claudexor/schema@2.0.0
- @claudexor/synthesis@2.0.0
- @claudexor/util@2.0.0
- @claudexor/workspace@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Stabilize the checkpoint release with explicit reviewer-panel hardening, mandatory
  review evidence preflight, scoped Cursor reviewer readiness, frozen SpecPack gate
  merging, protected-path approvals, and thin control/macOS projection parity.
- Honor cancellation immediately after agent/race reviewer panels so a stopped
  run cannot continue into synthesis or arbitration with a non-cancelled terminal
  outcome.
- Split spec/config protected paths from auto-protected gate/test paths so
  `protected_path_approvals` never suppress frozen SpecPack protections, and
  de-duplicate merged deterministic gate commands.
- Updated dependencies
  - @claudexor/core@0.14.1
  - @claudexor/context@0.14.1
  - @claudexor/interview@0.14.1
  - @claudexor/review@0.14.1
  - @claudexor/schema@0.14.1
  - @claudexor/delivery@0.14.1
  - @claudexor/gateway@0.14.1
  - @claudexor/workspace@0.14.1
  - @claudexor/policy@0.14.1
  - @claudexor/arbitration@0.14.1
  - @claudexor/budget@0.14.1
  - @claudexor/config@0.14.1
  - @claudexor/event-log@0.14.1
  - @claudexor/synthesis@0.14.1
  - @claudexor/artifact-store@0.14.1
  - @claudexor/util@0.14.1

## 0.14.0

### Patch Changes

- @claudexor/arbitration@0.14.0
- @claudexor/artifact-store@0.14.0
- @claudexor/budget@0.14.0
- @claudexor/config@0.14.0
- @claudexor/context@0.14.0
- @claudexor/core@0.14.0
- @claudexor/delivery@0.14.0
- @claudexor/event-log@0.14.0
- @claudexor/gateway@0.14.0
- @claudexor/interview@0.14.0
- @claudexor/policy@0.14.0
- @claudexor/review@0.14.0
- @claudexor/schema@0.14.0
- @claudexor/synthesis@0.14.0
- @claudexor/util@0.14.0
- @claudexor/workspace@0.14.0

## 0.13.3

### Patch Changes

- @claudexor/arbitration@0.13.3
- @claudexor/artifact-store@0.13.3
- @claudexor/budget@0.13.3
- @claudexor/config@0.13.3
- @claudexor/context@0.13.3
- @claudexor/core@0.13.3
- @claudexor/delivery@0.13.3
- @claudexor/event-log@0.13.3
- @claudexor/gateway@0.13.3
- @claudexor/interview@0.13.3
- @claudexor/policy@0.13.3
- @claudexor/review@0.13.3
- @claudexor/schema@0.13.3
- @claudexor/synthesis@0.13.3
- @claudexor/util@0.13.3
- @claudexor/workspace@0.13.3

## 0.12.1

### Patch Changes

- @claudexor/arbitration@0.12.1
- @claudexor/artifact-store@0.12.1
- @claudexor/budget@0.12.1
- @claudexor/config@0.12.1
- @claudexor/context@0.12.1
- @claudexor/core@0.12.1
- @claudexor/delivery@0.12.1
- @claudexor/event-log@0.12.1
- @claudexor/gateway@0.12.1
- @claudexor/interview@0.12.1
- @claudexor/policy@0.12.1
- @claudexor/review@0.12.1
- @claudexor/schema@0.12.1
- @claudexor/synthesis@0.12.1
- @claudexor/util@0.12.1
- @claudexor/workspace@0.12.1
