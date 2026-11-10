---
"@claudexor/harness-claude": patch
"@claudexor/core": patch
---

A Claude question whose answer the adapter could not obtain or deliver is no
longer recorded as the user's decline (#622). An `AskUserQuestion` error result
is now a neutral record with the CLI's own detail ("returned an error instead
of answers") and the session input Claudexor held when it read the question.
Frames can arrive in batches, so that state does not say when the model asked.
When the adapter itself cannot obtain or send an answer, an
`interaction_answer_unavailable` status names the reason with the request and
tool-use ids: the run has no answer channel, the channel failed, the process
ended before an answer was sent, the response could not be written, or the
CLI's permission request was read after Claudexor had closed the session's
stdin. That late request carries its exact native input instead of counting as
a dropped frame. Only the no-channel and failed-channel denies tell the model
why it got no answer; in the other cases it sees at most the CLI's own error,
and a deny that cannot be written adds a second status. The stdin handle of a
bidirectional session gains `send`, which reports whether a frame reached the
child's pipe: nothing is written once the child has exited, even while a
descendant still holds its output pipes, and a refused write reports its error.
A declined or expired question keeps its benign decline and typed interaction
events, and none of these is a blocking tool error. A failure inside the
orchestrator's answer surface that it resolves as no answer is still sent as
the benign decline.
