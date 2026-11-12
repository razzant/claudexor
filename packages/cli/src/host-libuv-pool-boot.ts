import { applyHostLibuvPool } from "./host-libuv-pool.js";

// This module is the daemon entry's first import. Its body assigns the pool
// size before later imports touch the filesystem; a call from the entry body
// would be too late, because those imports evaluate first.
applyHostLibuvPool();
