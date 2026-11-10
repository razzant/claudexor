---
"@claudexor/schema": patch
"@claudexor/core": patch
"@claudexor/orchestrator": patch
"@claudexor/daemon": patch
"@claudexor/control-api": patch
"@claudexor/cli": patch
"@claudexor/mcp-server": patch
"@claudexor/acp-server": patch
"@claudexor/harness-codex": patch
"@claudexor/harness-claude": patch
"@claudexor/harness-fake": patch
---

Questions now say whether the agent waits for the answer (#628). Each pending
question carries `delivery`: `blocking` (every question so far, and the
meaning of a stored question without the field) or `async`, a question the
agent asks while it keeps working. An async question is still attention: it
sets `waitingOnUser`, wakes `claudexor_run_wait`, and can be answered through
the same routes. It does not pause the inactivity watchdog or refuse live
messages, and the new run-summary flag `asyncQuestionsOnly` is true only while
every pending question is async, so a blocking question is never hidden behind
one. `claudexor follow`, ACP and the macOS app no longer call such a run paused
or waiting: they keep it working, say that silence or expiry sends nothing,
and a blocking question is asked before an open async prompt. ACP and MCP
answer prompts for an async question no longer hold the run's terminal; they
close when the question is answered elsewhere or the run ends. In the macOS app a
run that has ended no longer shows a question card, a Send button or a question
state while its last snapshot still lists the question; a late answer the engine
refuses reads as a sentence saying it was not sent, instead of a raw HTTP error;
the deadline label keeps counting down; and an async question between the last
message and the final answer no longer leaves a copy of that answer in Activity.

A failed answer surface is no longer reported as the user's decline. When the
engine cannot register or keep a question, the run's interaction channel now
rejects with the cause instead of returning "no answer"; a question that was
never registered is not announced. A Codex approval or access request whose
answer channel failed stays declined and records `interaction_answer_unavailable`
instead of failing the run. A failed read of a run's pending questions is no
longer reported as having none: `GET /v2/runs/:id` for a live run answers with
the typed problem, so an open prompt stays open and a kept answer is retried,
while a finished run's detail, a run list and a child card still render.

A Codex app-server run now raises Codex's `request_user_input_async` as such a
question: one async interaction per native item, with Codex's own question ids
and options. Its text stays visible as an agent message but is never taken as
the run's answer, even when the turn produced no other text. A committed answer
goes to the turn that asked, once, as Codex's reply envelope (`turn/steer` with
client message id `interaction-answer:<id>`), and each send leaves an
`interaction_answer_steer` receipt. The end of that turn,
Stop and the run's end withdraw an open question and send nothing. A sub-agent's
question cannot be answered, and a question Claudexor cannot read, a run without
an answer channel and a failing channel are recorded as
`interaction_answer_unavailable`. This follows the Codex 0.162.1 source; it was
not checked against a live Codex run.
