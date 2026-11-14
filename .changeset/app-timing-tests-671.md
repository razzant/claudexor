---
"claudexor": patch
---

Two macOS app tests that failed on loaded runners get wider bounds (#671). The
install coordinator test that restores the previous runtime gives each
handshake wait 2 seconds instead of 0.2, since the same timeout also bounds the
restored runtime's answers, and the remote project registration test waits up
to 20 seconds, not 5, for its first request and releases it even when it fails
early.
