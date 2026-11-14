---
"claudexor": patch
---

The daemon tests that hold libuv pool threads with FIFO writes give their
python helper processes 20 seconds to start instead of 5. That wait is meant to
catch a broken setup, not to time the machine: on loaded macOS release runners
the first start of a run took close to 5 seconds, and in the 6.1.1 publish run
it took longer, which stopped the run (#708).
