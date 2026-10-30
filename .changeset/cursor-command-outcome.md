---
"@claudexor/schema": patch
"@claudexor/harness-cursor": patch
"@claudexor/orchestrator": patch
"@claudexor/control-api": patch
"@claudexor/acp-server": patch
---

A Cursor shell command that is still running is no longer reported as a finished success. When Cursor moves a command to a background shell (for example after its 30-second shell timeout) or its timeout elapses, the tool result keeps its ordinary tool status but now carries typed `command_outcome` facts (`backgrounded` with the shell handle, process id and reason, `timed_out`, an observed `exited` with its exit code and signal, or `unknown` for an unrecognized shape), and the complete native result is kept in the durable `harness.event` payload. Such a result never recovers an earlier failure of the same command and never discards a delivered answer; the run timeline shows it as a warning, ACP closes it as `failed` with the state as text instead of `completed`, and the macOS transcript shows a caution row that never joins a group of finished calls. A shell spawn error is now an error instead of ok. The timeout and background shapes follow the `agent.v1` shell protocol of cursor-agent 2026.08.11; no such frame has been recorded live yet. Motivation: two reviewer runs reported a 30-second `find` as a successful command while it was still running, and the journal could not tell a timeout from a background handoff (razzant/claudexor#450).
