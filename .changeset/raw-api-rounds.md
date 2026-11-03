---
"@claudexor/schema": patch
"@claudexor/context": patch
"@claudexor/workspace": patch
"@claudexor/harness-raw-api": patch
"@claudexor/orchestrator": patch
---

Convergence rounds now work on a Raw API route (#551). Each round is produced and applied against the exact candidate the earlier round left, including new files and a native round's work, while the run keeps one delivery base, so the final result from that base holds every round. A packet's file contents are now read from the tree the packet names, so a file that changes while the packet is prepared is never sent under the identity of another version; a file whose line endings Git converts on checkout is sent as the tree stores it, the form its patch applies to, and a file that is not UTF-8 text is left out, or refused if mandatory, instead of being sent with replaced bytes. A refused patch was recorded as a crashed process; it is now the attempt's typed failure with the received usage kept. A patch the model can correct reaches the next round through the ordinary revise prompt, and an impossible state, isolation or digest failure ends the run without a retry. Such a refused round applied nothing, so it never counts as a repeat of the earlier result: after an accepted round, an unapplicable or incomplete patch is followed by the correcting round instead of ending the run as `stuck_no_progress`. The correction spends one of the run's rounds, so `--attempts` and every other existing limit still bound it, the same refusal twice is a repeated failure, and the same accepted result twice against a failing gate still stops as `stuck_no_progress`.
