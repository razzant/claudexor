---
"@claudexor/harness-agy": patch
"@claudexor/schema": patch
"@claudexor/orchestrator": patch
"@claudexor/core": patch
---

Antigravity read-only runs no longer end at their first shell command, and
large Antigravity inputs reach the model whole (#653).

A read-only run now passes session-only settings that deny every command and
file write, including commands the profile allows. agy returns a denied call to
the model as a tool error, so the run keeps reading files and delivers its
answer; before, plan mode's unanswerable permission prompt ended the whole turn.
The profile's own allow, deny and ask rules stay in force: agy replaces each
list a session object names, so all three are copied from the profile. If the
profile settings cannot be read, the read-only run is refused before it starts;
if only saving the read grant fails, the session settings carry the grant.
Read-only runs therefore need agy 1.4.10 or newer, the first release that
accepts session-only settings: on an older CLI a read-only run stops before any
model call with a message asking to update agy, and `doctor` states the
minimum. Full-access and workspace-write runs are unaffected, and nothing
updates agy automatically. Every tool step agy
reports as ERROR, refused or otherwise failed, now records that call's error
result.

In the recorded runs agy kept only the first 192,000 bytes of each larger piped
prompt. Input over Claudexor's conservative 128 KiB limit is now saved unchanged
in the run's context directory and named by a short bootstrap whose size does
not grow with the input. This also covers inputs between 128 KiB and 192,000
bytes, which agy would have received whole, and a thread's summary pass, which
uses its enclosing run's directory. A lane without a run directory, an
unavailable profile read grant or a failed write refuses such input before
anything is sent.
