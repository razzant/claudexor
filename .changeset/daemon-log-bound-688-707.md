---
"@claudexor/cli": patch
"@claudexor/daemon": patch
---

Write quota observations once and keep each daemon log generation within 256 KiB. `claudexor daemon logs` also shows delayed event-loop windows and Stop requests from a separate bounded history, even when the main log is missing (#688, #707).
