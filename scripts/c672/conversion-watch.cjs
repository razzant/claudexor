// Preloaded only in the built CLI running the synthetic Update. Every rename
// reaches Windows. Publish the first denial and immediately rethrow it.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { join, relative } = require("node:path");
// On Windows libuv's hrtime and the holder's Stopwatch both read system QPC.
const nowMs = () => Number(process.hrtime.bigint() / 1_000_000n);

const root = process.env.C672_PACKAGE;
const evidence = process.env.COPILOT_HOME;
if (process.platform !== "win32" || !root || !evidence)
  throw new Error("Expected the Windows conversion fixture");

const attempts = [];
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  if (
    typeof from !== "string" ||
    typeof to !== "string" ||
    relative(root, from) !== "" ||
    relative(root + ".claudexor-converted", to) !== ""
  )
    return rename.apply(this, arguments);

  const call = { from, to, startedMs: nowMs() };
  attempts.push(call);
  try {
    return rename.apply(this, arguments);
  } catch (error) {
    call.deniedMs = nowMs();
    call.error = {
      code: error.code,
      errno: error.errno,
      syscall: error.syscall,
      path: error.path,
      dest: error.dest,
      message: error.message,
    };
    try {
      if (
        attempts.length === 1 &&
        error.syscall === "rename" &&
        ["EPERM", "EACCES", "EBUSY"].includes(error.code)
      ) {
        const signal = join(evidence, "first-denial.json");
        fs.writeFileSync(signal + ".tmp", JSON.stringify(call));
        rename.call(fs, signal + ".tmp", signal);
      }
    } catch (observerError) {
      call.observerError = String(observerError);
    }
    throw error;
  } finally {
    call.returnedMs = nowMs();
  }
};
// The next ordinary version probe bounds the decision before final inventory
// takes time. Actual invocations also write their own independent transcript.
const spawn = childProcess.spawnSync;
childProcess.spawnSync = function () {
  const last = attempts.at(-1);
  if (last && last.nextProcessMs === undefined) last.nextProcessMs = nowMs();
  return spawn.apply(this, arguments);
};
syncBuiltinESMExports();
process.once("exit", () => {
  fs.writeFileSync(join(evidence, "renames.json"), JSON.stringify(attempts, null, 2));
});
