---
"claudexor": patch
---

CLI live printer: the codex answer prints once, not twice (Ф2.5 sol #4
follow-up).

Codex narrates its answer mid-run and then repeats the same text as its
typed final message; `claudexor ask`/`agent`/`follow` printed both. The
live formatter now dedups on the typed `final` flag per lane — a final
whose rendered line is already on screen is suppressed, while a final
carrying new text (claude/cursor results, which never repeat narration)
still prints. The dedup keys on the rendered 160-char line (what the
terminal actually shows), state is bounded per lane and survives SSE
reconnects, and `--json`/NDJSON machine surfaces stay verbatim.

Reviewed by gpt-5.6-sol (initial pass: 1 major + 2 minor, all fixed;
confirmation pass on the fixes: 1 minor, fixed).
