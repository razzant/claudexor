---
"@claudexor/harness-claude": patch
---

Live messages and questions keep reaching a resumed Claude session while its
prompt is still running (#536). The adapter remembers the uuid of the prompt
frame it writes. Once Claude Code shows that it identifies commands by uuid (a
lifecycle frame names the prompt, or a result names only commands the session
never sent), the session's input stays open until a result names the prompt or
the prompt's own lifecycle ends. Previously the first result closed the input
whenever no message or background task was pending, so a result for an earlier
turn of a resumed session could close it while Claude kept working; later
messages were then refused with `not_active`/`no_live_session`. The input now
stays open whether that earlier result arrives before or after Claude Code
reports the prompt. An error result that names no command still ends the
prompt, as the first result always did, and a Claude Code build that names no
command keeps the close on the first result. An earlier result that names no
command and arrives before the prompt's lifecycle still closes the input, and a
success result that names no command leaves an identified prompt open until its
own result, its lifecycle end or the run's time limits. A finished run still
closes on its own result, queued messages and claimed background tasks still
hold it, and a Monitor task without that claim still does not.

A result for another turn also no longer decides the run's outcome. While the
prompt runs, a result naming only commands the session never sent keeps its
usage, and its failure, answer or context limit is kept as a `foreign_result`
status instead of this run's error or final answer, so an earlier failed turn
of a resumed session cannot fail a prompt that then succeeds. The prompt's own
result, a live message's result and a result naming no command keep their
meaning.
