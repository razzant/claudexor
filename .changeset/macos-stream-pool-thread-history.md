---
"claudexor": patch
---

The macOS app no longer makes ordinary requests wait behind long-lived event
streams. Each engine connection, local or remote, now keeps its run, global
journal (including the Accounts quota observer) and setup-job streams in a
connection pool of its own, configured like its request session, so while many
runs stream, opening a thread, refreshing runs and run controls are no longer
queued until a stream ends or the 60-second request timeout passes. Switching
threads also reads the selected thread's history at once instead of after the
global run list: the run-list reconciliation for the previous selection runs
beside that read, and when it answers it keeps the off-page rows of the local
thread selected at that moment; a selected remote thread no longer keeps local
rows that share its run ids. Streams still share the platform's per-host
connection limit among themselves (6 observed for loopback HTTP/1.1 on macOS
26.4): a stream beyond it waits for another stream to end. No engine API,
stream semantics or background-run status changed.
