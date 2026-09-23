---
"@claudexor/harness-codex": patch
"@claudexor/harness-claude": patch
"@claudexor/cli": patch
---

Support GPT-6 Sol (`gpt-6-sol`) and GPT-6 Luna (`gpt-6-luna`) by moving the verified Codex CLI pin to 0.156.1, and Claude Opus 5.5 (`claude-opus-5-5`) by moving the verified Claude Code pin to 2.1.280 and admitting the id to the Claude manifest known-model list; `claudexor harness install` now fetches those builds. The Codex effort snapshot is re-recorded from the 0.156.1 bundled catalog (Sol through `ultra`, Luna through `max`, GPT-6 Astra's advertised default now `low`), ids the bundled list no longer shows stay admissible with their retained ladders, and the raw Codex model route still refuses a model the account catalog does not list. The canary sandbox no longer inherits ambient provider credentials, so offline stories stay offline on machines that have them.
