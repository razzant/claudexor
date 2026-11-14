---
"claudexor": patch
---

The daemon tests that hold libuv pool threads with FIFO writes no longer depend
on the speed of the machine that runs them: their wait for the python helper
processes now bounds only a broken setup. On a loaded macOS release runner the
helpers took longer than the old five seconds, which stopped the 6.1.1 publish
run (#708).
