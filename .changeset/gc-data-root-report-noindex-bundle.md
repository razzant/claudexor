---
"claudexor": patch
---

The `claudexor gc` receipt now discloses non-engine top-level entries in the Claudexor data root (advisory only — named, sorted, bounded, never deleted; the field is absent when the scan fails or the daemon predates it), and the packaged macOS app bundle plus the dmg-stage move under `apps/macos/dist/bundle.noindex/` so Spotlight never indexes dev-built bundles as launchable apps — DMG/ZIP artifacts and checksums stay in `apps/macos/dist/`.
