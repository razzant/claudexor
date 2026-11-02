---
"@claudexor/schema": patch
"@claudexor/harness-codex": patch
"@claudexor/orchestrator": patch
"@claudexor/review": patch
"@claudexor/daemon": patch
"@claudexor/cli": patch
---

A Codex usage refusal is no longer treated as a network blip (#558), and the vendor's own failure record reaches the run's diagnostics without an OS exit code (#414).

Codex's typed `usage_limit_exceeded` (a spent plan window or a workspace out of credits) now becomes a typed limit with no known reopening time (`rate_limit.reopening: "unknown"`), read from the rollout record or the app-server frame and never from the message words. The run never resumes or replays the same account for it, and neither does an ordinary reviewer when the refusal's words also read as a broken stream; a broken stream with no typed refusal is still retried on the same account as before. A pinned account ends at once with `code: null`, `category: harness_unavailable`, `resetsAt: null` and the vendor's cause, because `subscription_window_exhausted` tells every reader that waiting cures it, which nobody knows here. An unpinned run follows its `limit_action` (the default moves to the next ready account), and with no other account it ends with an undated `credential_pool_exhausted`. The daemon keeps the refusal for its existing bounded cooldown under the identity `cooldown:reopening_unknown`, with no invented usage or reset, so the next pinned run is refused before spawn with the same honest record and the pool ranks the account last and stays undated, even when another of the account's windows has a date. The same record is kept when a pinned Ask's `fallback_model` meets the refusal during attempt setup, and the Accounts `next_up` text no longer says unpinned runs wait for a reset when a member was refused this way. A newer recognized quota read retires the refusal under the same rules as a generic refusal. Vendor-dated windows, retry delays and vendor reset days with no such refusal beside them keep their code and reset. The `vendorFailure` of a failed try is recorded whether or not the try ended with an exit code, on that try's `poolAttempts` row and on the failure record for the attempt's last try only. A candidate that changed files before such a typed refusal now keeps the refusal's code, reset and remedy on its failure record instead of a generic harness error.
