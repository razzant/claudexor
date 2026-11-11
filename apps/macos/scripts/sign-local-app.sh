#!/usr/bin/env bash
set -euo pipefail

APP="$1"
# Seal only the root bundle, leaving nested executable bytes and entitlements intact.
# Deep verification does not validate individual code signatures in Resources;
# byte identity and the build's execution probes cover preservation and usability.
codesign --force --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
