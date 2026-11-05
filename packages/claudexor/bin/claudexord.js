#!/usr/bin/env node
// Daemon entry wrapper (same contract as the claudexor bin). The boot is an
// EXPLICIT call — the module import itself is side-effect-free (X228/X231),
// so a wrapper path in argv[1] can never silently skip the daemon start.
//
// UV_THREADPOOL_SIZE is read when libuv creates its pool, on the first
// filesystem or dns.lookup call. A static import of the daemon graph would
// do that before this file could assign the variable, so the graph is loaded
// only after the assignment. An operator-set value is left as it is.
import { applyHostLibuvPool } from "./libuv-pool.js";

applyHostLibuvPool();

const { runClaudexordEntry } = await import("@claudexor/cli/claudexord");
runClaudexordEntry();
