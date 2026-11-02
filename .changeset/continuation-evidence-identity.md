---
"@claudexor/event-log": patch
"@claudexor/workspace": patch
"@claudexor/orchestrator": patch
"@claudexor/harness-claude": patch
---

Continuation packets and D-16d checkpoints no longer drop a run's own recorded output because the carried answer, report or prompt contains its words (#568). Only the carried final itself is left out, with its keyed fragments and exact adjacent repeats; other attempts, earlier tries and earlier turns keep their messages whatever their text. `final/retained-output.md` groups keyed text by its speech key and keeps each native turn's final separate. In a Claude `text_runs_joined` response, the one deferred frame of a run of text blocks names the keys it joins (`payload.joined_speech_keys`) and becomes their single block when its words are exactly theirs; otherwise every block stays as recorded. Limits: a represented try without a typed final is still left out whole, since its joined narration is the answer; more evidence now competes for the bounded evidence section, whose cut stays marked; when the represented try is unknown nothing is left out, so the answer can appear twice; the earlier carried-text argument and option are still accepted and ignored.
