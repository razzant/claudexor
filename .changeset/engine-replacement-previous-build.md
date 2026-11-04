---
"claudexor": patch
---

When the engine selected for an idle replacement does not come up, the macOS app
restarts the exact previous build if a saved copy was verified before the stop and
nothing can still be running beside it. Otherwise it goes Offline with the specific
reason and an explicit Retry, also in the sidebar when remote work keeps the thread
screen. If the restarted engine answers only in recovery mode, the notice names the
`daemon stop` command for the app's own engine root. The app reports a restart, not
a restore: data a newer engine already migrated stays with that engine.
