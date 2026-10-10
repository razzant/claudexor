# @claudexor/harness-agy

## 4.0.0

### Patch Changes

- Updated dependencies [2fbf7c9]
  - @claudexor/schema@4.0.0
  - @claudexor/util@4.0.0
  - @claudexor/core@4.0.0

## 3.25.1

### Patch Changes

- @claudexor/core@3.25.1
- @claudexor/schema@3.25.1
- @claudexor/util@3.25.1

## 3.25.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.25.0
  - @claudexor/core@3.25.0
  - @claudexor/util@3.25.0

## 3.24.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.24.0
  - @claudexor/schema@3.24.0
  - @claudexor/util@3.24.0

## 3.23.2

### Patch Changes

- @claudexor/core@3.23.2
- @claudexor/schema@3.23.2
- @claudexor/util@3.23.2

## 3.23.1

### Patch Changes

- @claudexor/core@3.23.1
- @claudexor/schema@3.23.1
- @claudexor/util@3.23.1

## 3.23.0

### Patch Changes

- @claudexor/core@3.23.0
- @claudexor/schema@3.23.0
- @claudexor/util@3.23.0

## 3.22.1

### Patch Changes

- Updated dependencies [902532e]
  - @claudexor/schema@3.22.1
  - @claudexor/util@3.22.1
  - @claudexor/core@3.22.1

## 3.22.0

### Patch Changes

- Updated dependencies [51578d4]
- Updated dependencies [785bba7]
  - @claudexor/schema@3.22.0
  - @claudexor/core@3.22.0
  - @claudexor/util@3.22.0

## 3.21.0

### Patch Changes

- 7c541ba: One effort word now works on Cursor and Antigravity too, where the level is a token of the compound model id. Given an effort preference, the adapter's preparation selects the listed level variant of the requested model's family from the inventory of the account that will run (`grok-4.7-high` + `max` runs the listed `grok-4.7-xhigh`; `gemini-3.8-flash-low` + `max` runs `gemini-3.8-flash-high`): the family is the id with exactly one shared-order level token removed, `fast` and `thinking` stay in the family key so the choice never crosses fast/standard or thinking/no-thinking, a family exists only when the account lists two or more levels, and the level is placed by the shared preference order alone. One preparation yields the final id (the processing receipt's `submittedNative`, which is the `--model` argument) and the effort receipt (`parameter: --model`, `submitted` = level token), recorded once per spawn and per reviewer dispatch; the requested id stays in the model hint and in `attempts[].requested_model`. Nothing new refuses: an unknown word, an ambiguous id, a family-less id or an empty account list keep the id unchanged with an `omitted` receipt and a note. Antigravity rewrites only from the pinned account's live `agy models` list; the static hint list never authorizes a rewrite. Settings writes accept the preference for these routes, the existing fast-pair and paid policy run after the level choice, and the final telemetry `model_mismatch` compares the observation with the id actually sent.
- a4ff572: Reconcile older quota refusals with newer account observations, preserve genuine credential rejections without duplicating poller state, and pace quota reads per affected account. Ordinary Accounts and account-catalog reads retain their first observation instead of repeatedly probing vendors. Discover Antigravity models for the selected account, forward explicitly requested unlisted models with disclosure, and preserve known quota-family applicability for new model IDs.
- Updated dependencies [7c541ba]
- Updated dependencies [f0ab916]
- Updated dependencies [83bc0da]
- Updated dependencies [9ccd45d]
- Updated dependencies [a4ff572]
  - @claudexor/core@3.21.0
  - @claudexor/schema@3.21.0
  - @claudexor/util@3.21.0

## 3.20.1

### Patch Changes

- Updated dependencies [eb506c1]
- Updated dependencies [dc30eda]
- Updated dependencies [705c2c1]
  - @claudexor/schema@3.20.1
  - @claudexor/core@3.20.1
  - @claudexor/util@3.20.1

## 3.20.0

### Patch Changes

- Updated dependencies [c12828c]
  - @claudexor/core@3.20.0
  - @claudexor/util@3.20.0
  - @claudexor/schema@3.20.0

## 3.19.0

### Patch Changes

- 386bbf1: Add the Gemini 3.8 Flash model definitions (gemini-3.8-flash-high, gemini-3.8-flash-medium, gemini-3.8-flash-low) to the Antigravity known-model list. The verified CLI version stays 1.1.13, the version the recorded fixtures were captured against: the three ids were confirmed live with `agy models` under a Claudexor profile HOME on 2026-10-03 (the host agy answered 1.1.13 right before the listing and self-updated to 1.2.16 during it), which is evidence of the ids on the vendor backend, not a fixture re-verification.
- Updated dependencies
  - @claudexor/core@3.19.0
  - @claudexor/schema@3.19.0
  - @claudexor/util@3.19.0

## 3.18.0

### Patch Changes

- Updated dependencies [b00408e]
  - @claudexor/core@3.18.0
  - @claudexor/schema@3.18.0
  - @claudexor/util@3.18.0

## 3.17.2

### Patch Changes

- Preserve native input-size refusals without account retries or unrelated quota resets, publish measured ASK input budgets, distinguish proven undelivered Codex model requests, and move large Claude and AGY inputs off process arguments.
- Updated dependencies
  - @claudexor/schema@3.17.2
  - @claudexor/core@3.17.2
  - @claudexor/util@3.17.2

## 3.17.1

### Patch Changes

- Updated dependencies [72825b9]
  - @claudexor/schema@3.17.1
  - @claudexor/core@3.17.1
  - @claudexor/util@3.17.1

## 3.17.0

### Patch Changes

- Updated dependencies [092ec2b]
- Updated dependencies [951489f]
  - @claudexor/core@3.17.0
  - @claudexor/schema@3.17.0
  - @claudexor/util@3.17.0

## 3.16.0

### Patch Changes

- Updated dependencies [788ddca]
  - @claudexor/schema@3.16.0
  - @claudexor/core@3.16.0
  - @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- @claudexor/core@3.15.1
- @claudexor/schema@3.15.1
- @claudexor/util@3.15.1

## 3.15.0

### Patch Changes

- Updated dependencies [3bc8af4]
  - @claudexor/core@3.15.0
  - @claudexor/schema@3.15.0
  - @claudexor/util@3.15.0

## 3.14.0

### Patch Changes

- Updated dependencies [2c024ac]
- Updated dependencies [7e615b6]
- Updated dependencies [fb42a94]
  - @claudexor/core@3.14.0
  - @claudexor/schema@3.14.0
  - @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/core@3.13.0
- @claudexor/schema@3.13.0
- @claudexor/util@3.13.0

## 3.12.10

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.10
  - @claudexor/core@3.12.10
  - @claudexor/util@3.12.10

## 3.12.9

### Patch Changes

- Updated dependencies [125aea9]
  - @claudexor/schema@3.12.9
  - @claudexor/core@3.12.9
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- @claudexor/core@3.12.8
- @claudexor/schema@3.12.8
- @claudexor/util@3.12.8

## 3.12.7

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.7
  - @claudexor/core@3.12.7
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- @claudexor/core@3.12.6
- @claudexor/schema@3.12.6
- @claudexor/util@3.12.6

## 3.12.5

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.5
  - @claudexor/core@3.12.5
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- @claudexor/core@3.12.4
- @claudexor/schema@3.12.4
- @claudexor/util@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/core@3.12.3
- @claudexor/schema@3.12.3
- @claudexor/util@3.12.3

## 3.12.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.2
  - @claudexor/core@3.12.2
  - @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.1
  - @claudexor/core@3.12.1
  - @claudexor/util@3.12.1

## 3.12.0

### Patch Changes

- Updated dependencies [217d53f]
  - @claudexor/schema@3.12.0
  - @claudexor/core@3.12.0
  - @claudexor/util@3.12.0

## 3.11.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.11.0
  - @claudexor/core@3.11.0
  - @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- @claudexor/core@3.10.5
- @claudexor/schema@3.10.5
- @claudexor/util@3.10.5

## 3.10.4

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.4
  - @claudexor/core@3.10.4
  - @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- @claudexor/core@3.10.3
- @claudexor/schema@3.10.3
- @claudexor/util@3.10.3

## 3.10.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.2
  - @claudexor/core@3.10.2
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- Keep Antigravity model and quota checks non-interactive by closing piped input instead of using a null device. Preserve ambiguous authentication timeouts as probe failures and expose failed refreshes alongside stale quota data.
- Updated dependencies
  - @claudexor/schema@3.10.1
  - @claudexor/core@3.10.1
  - @claudexor/util@3.10.1

## 3.10.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.10.0
  - @claudexor/schema@3.10.0
  - @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.8
  - @claudexor/core@3.9.8
  - @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/core@3.9.7
- @claudexor/schema@3.9.7
- @claudexor/util@3.9.7

## 3.9.6

### Patch Changes

- @claudexor/core@3.9.6
- @claudexor/schema@3.9.6
- @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- @claudexor/core@3.9.5
- @claudexor/schema@3.9.5
- @claudexor/util@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/core@3.9.4
- @claudexor/schema@3.9.4
- @claudexor/util@3.9.4

## 3.9.3

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.3
  - @claudexor/core@3.9.3
  - @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- @claudexor/core@3.9.2
- @claudexor/schema@3.9.2
- @claudexor/util@3.9.2

## 3.9.1

### Patch Changes

- @claudexor/core@3.9.1
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
  - @claudexor/core@3.9.0
  - @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- @claudexor/core@3.8.4
- @claudexor/schema@3.8.4
- @claudexor/util@3.8.4

## 3.8.3

### Patch Changes

- @claudexor/core@3.8.3
- @claudexor/schema@3.8.3
- @claudexor/util@3.8.3

## 3.8.2

### Patch Changes

- @claudexor/core@3.8.2
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
  - @claudexor/core@3.8.1
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1

## 3.8.0

### Minor Changes

- 6054b7d: Make credential-profile custody and managed setup login platform-aware, with an exact Windows Antigravity one-binding policy, vendor-proven doctor/quota results, durable ambiguity handling, and host-resolved terminal capability projection.

### Patch Changes

- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/core@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

- @claudexor/core@3.7.0
- @claudexor/schema@3.7.0
- @claudexor/util@3.7.0

## 3.6.0

### Patch Changes

- Updated dependencies [895967f]
  - @claudexor/schema@3.6.0
  - @claudexor/core@3.6.0
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
  - @claudexor/util@3.5.0
  - @claudexor/core@3.5.0
  - @claudexor/schema@3.5.0
