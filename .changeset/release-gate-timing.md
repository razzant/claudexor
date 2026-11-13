---
"claudexor": patch
---

Three macOS app tests no longer depend on the speed of the machine that runs
them: the generation-fence tests hold the old connection's response until the
test has moved to the next generation, and the SSH cancellation and early-exit
tests bound only a hang. Their timing failures stopped the 6.1.0 publish run on
a loaded release runner (#705).
