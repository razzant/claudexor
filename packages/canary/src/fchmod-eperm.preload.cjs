"use strict";

const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

fs.fchmodSync = function forcedFchmodFailure() {
  throw Object.assign(new Error("EPERM: operation not permitted, fchmod"), {
    code: "EPERM",
    syscall: "fchmod",
  });
};
syncBuiltinESMExports();
