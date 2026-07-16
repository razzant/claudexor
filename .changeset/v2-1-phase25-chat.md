---
"claudexor": patch
---

Phase 2.5 (2.0.2) — Chat-V2: the conversation reads as a conversation, and
agent output actually reaches the user.

Answer finality is typed end to end: adapters carry the vendors' own final
marker (claude/cursor `result`, codex's finalized last agent message) as
`final` on the message event, and only for SUCCESS results — a failed
result's partial text never wins as the answer. The orchestrator's
AnswerAssembly takes a typed final verbatim across all three task-producing
lanes; the app renders it as the loudest element (its own bubble) and never
duplicates it in the transcript. claude's `api_retry` becomes a typed
`status` event (documented category enum, redacted+bounded prose) that lands
in the activity feed and a live «Retrying 2/10 · overloaded · in 2s» status
line — never reasoning junk. Reasoning merges into segments with observed
durations; mid-run narration is dimmed; tool rows lead with a kind icon and
a humane short title with the raw command one disclosure away. Opt-in live
text deltas stream on single-candidate claude/cursor lanes (bounded by a
per-attempt budget with a disclosed cutoff); the reducer grows one streaming
block and the complete message replaces it, sealing on final.

Agent images render inline, path-scoped to the thread's repoRoot / run dir
(canonical symlink-resolved checks, off-main bounded decode, size+mtime
cache, disclosed refusal outside the scope); file links open through the
same gate and ONLY for safe document/image types (an executable inside the
repo is refused, not launched); the Canvas surfaces every image the run's
diff touched. Markdown is hard-bounded before layout on every path
(collapsed, expanded, Run Detail, prompt) — closing the reopened W23 hang
class. The daemon gains a disclosed SIGTERM escalation ladder (stop deadline
+ post-stop drain sweep, exit code read at fire time, timers cancelled on
finalize) so a hung or leaked-handle shutdown can no longer leave immortal
claudexords behind. DESIGN_SYSTEM §5 rewritten to the Chat-V2 vocabulary.
