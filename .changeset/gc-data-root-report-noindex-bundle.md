---
"claudexor": patch
---

The `claudexor gc` receipt now discloses non-engine top-level entries in the Claudexor data root (advisory only — the full sorted list, never deleted; opt-in via the `data_root_report` request flag, which the CLI sends only to a lockstep same-version daemon, so the field is absent under any version skew, when the scan fails, or when the daemon predates it), and the packaged macOS app bundle plus the dmg-stage move under `apps/macos/dist/bundle.noindex/` so Spotlight never indexes dev-built bundles as launchable apps — DMG/ZIP artifacts and checksums stay in `apps/macos/dist/`.
