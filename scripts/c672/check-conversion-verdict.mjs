// Offline reducer controls. Times are monotonic milliseconds from the first error.
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkConversion,
  checkConversionBaseline,
  checkConversionEffects,
} from "./conversion-verdict.mjs";

const from = "/old";
const to = "/old.claudexor-converted";
const message = `EPERM: operation not permitted, rename '${from}' -> '${to}'`;
const reason = `After the installer exited 17, npm copy conversion failed (EPERM): ${message}`;
const denied = {
  from,
  to,
  error: { syscall: "rename", code: "EPERM", path: from, dest: to, message },
};
const record = (ms, count = 2) =>
  `Windows npm conversion: first rename error EPERM; ${count} attempts; elapsed ${ms} ms.`;
const released = {
  signal: "first-denial.json",
  seenMs: 1,
  closingMs: 201,
  closedMs: 202,
  finishedMs: 250,
};
const kept = {
  signal: "update-finished",
  seenMs: 2021,
  closingMs: 2021,
  closedMs: 2022,
  finishedMs: 2020,
};

function check(mode, retryMs, limits, holder, returnedMs = 0, overrides = {}) {
  holder ??= mode === "release" ? released : kept;
  const single = retryMs === null;
  const control = single && !overrides.candidate;
  const ok = overrides.ok ?? (!single && mode === "release");
  const attempts = [{ ...denied, startedMs: 0, deniedMs: 0, returnedMs }];
  for (const ms of overrides.priorRetries ?? [])
    attempts.push({ ...denied, startedMs: ms, deniedMs: ms, returnedMs: ms });
  if (single) attempts[0].nextProcessMs = holder.finishedMs;
  else
    attempts.push({
      ...(ok ? {} : denied),
      startedMs: retryMs,
      deniedMs: ok ? undefined : retryMs,
      returnedMs: retryMs,
      nextProcessMs: holder.finishedMs,
    });
  const receipt = {
    ok,
    exitCode: 17,
    commands: [{}],
    outcome: ok ? "changed" : "not_changed",
    mutation: overrides.mutation ?? (ok ? "applied" : "unknown"),
    problem: ok ? null : { code: "vendor_command_failed" },
    limitations: limits,
  };
  const run = { error: null, signal: null, status: ok ? 0 : 17, receipt };
  checkConversion(
    control ? "control" : "candidate",
    mode,
    !control && mode === "release",
    run,
    attempts,
    holder,
  );
}

test("qualify delayed recovery, exhaustion and a control that exits before release", () => {
  check("release", 225, [record(225)]);
  check("persistent", 1950, [record(2000), reason]);
  check("persistent", 1620, [record(2000), reason]); // next wake exceeded the deadline
  check("release", null, [reason], { ...released, finishedMs: 10 });
});

test("an immediate retry and zero elapsed cannot qualify either candidate", () => {
  assert.throws(() => check("release", 0, [record(0)]), /reported 0 ms/);
  assert.throws(
    () => check("persistent", 0, [record(0), reason]),
    /no real retry in the second half/,
  );
  assert.throws(
    () => check("persistent", 0, [record(2000), reason]),
    /no real retry in the second half/,
  );
});

test("check the elapsed time and the fields of a single record", () => {
  assert.throws(() => check("release", 225, [record(0)]), /reported 0 ms/);
  assert.throws(() => check("persistent", 1950, [record(0), reason]), /reported 0 ms/);
  assert.throws(() => check("release", 225, record(225).split(";")), /Windows npm conversion/);
});

test("timer start after the first observed return can explain a short receipt, but cannot qualify it", () => {
  const holder = { ...released, finishedMs: 375 };
  const retries = { priorRetries: [50] };
  check("release", 355, [record(355, 3)], holder, 0, retries);
  assert.throws(() => check("release", 355, [record(350, 3)], holder, 0, retries), {
    code: "fixture_gap",
    message: /product timer started later/,
  });
  assert.throws(() => check("release", 225, [record(1)]), { code: "fixture_gap" });
  assert.throws(
    () => check("release", 355, [record(100, 3)], holder, 0, retries),
    /reported 100 ms/,
  );
  assert.throws(() => check("release", 355, [record(350)], holder, 0, retries), {
    code: "ERR_ASSERTION",
  });
});

test("a retry outside even the latest possible window fails, rather than becoming a gap", () => {
  const holder = { ...kept, seenMs: 2101, closingMs: 2101, closedMs: 2102, finishedMs: 2100 };
  const retries = { priorRetries: [50] };
  assert.throws(() => check("persistent", 2005, [record(2000, 3), reason], holder, 0, retries), {
    code: "fixture_gap",
    message: /could not be placed within the 2s budget/,
  });
  assert.throws(
    () => check("persistent", 2055, [record(2055, 3), reason], holder, 0, retries),
    /started a rename outside the 2s budget/,
  );
});

test("late release or release by cleanup leaves a fixture gap", () => {
  assert.throws(() => check("release", 225, [record(15)], released, 210), { code: "fixture_gap" });
  assert.throws(() => check("release", 225, [record(225)], released, 210), /reported 225 ms/);
  for (const holder of [
    { ...released, closedMs: 800 },
    { ...released, signal: "update-finished" },
  ])
    assert.throws(() => check("release", null, [reason], holder), { code: "fixture_gap" });
});

test("a timing line cannot stand in for the actual error of this rename", () => {
  for (const wrong of [
    [],
    [reason.replace(`'${from}'`, "'/other'")],
    [reason.replace(to, "/wrong-dest")],
  ])
    assert.throws(
      () => check("persistent", 1950, [record(2000), ...wrong]),
      /missing original conversion error/,
    );
  assert.throws(
    () => check("persistent", 1950, [record(2000), reason], kept, 0, { mutation: "none" }),
    { code: "ERR_ASSERTION" },
  );
});

test("a one-attempt deadline with no observed opportunity is inconclusive, never passing", () => {
  const single = (ms) => record(ms).replace("2 attempts", "1 attempts");
  for (const mode of ["release", "persistent"]) {
    const holder = mode === "release" ? { ...released, finishedMs: 2020 } : kept;
    assert.throws(() => check(mode, null, [single(2000), reason], holder, 0, { candidate: true }), {
      code: "fixture_gap",
    });
    assert.throws(
      () => check(mode, null, [single(0), reason], holder, 0, { candidate: true }),
      /reported 0 ms/,
    );
    assert.throws(
      () => check(mode, null, [single(3000), reason], holder, 0, { candidate: true }),
      /reported 3000 ms/,
    );
  }
});

test("equal timestamps do not put a successful or refused retry after close", () => {
  const holder = { ...released, finishedMs: 2020 };
  const fullWindow = [record(2000), reason];
  const refusal = { ok: false };
  assert.throws(() => check("release", holder.closedMs, [record(holder.closedMs)], holder), {
    code: "fixture_gap",
    message: /Success could not be placed after close/,
  });
  assert.throws(() => check("release", 50, fullWindow, holder, 0, refusal), {
    code: "fixture_gap",
  });
  assert.throws(() => check("release", holder.closedMs, fullWindow, holder, 0, refusal), {
    code: "fixture_gap",
  });
  assert.throws(
    () => check("release", holder.closedMs + 1, fullWindow, holder, 0, refusal),
    /refused a rename started after the holder closed/,
  );
  assert.throws(
    () => check("release", 50, [record(1998), reason], holder, 0, refusal),
    /reported 1998 ms/,
  );
  assert.throws(
    () =>
      check(
        "release",
        50,
        [record(2000).replace("2 attempts", "1 attempts"), reason],
        holder,
        0,
        refusal,
      ),
    { code: "ERR_ASSERTION" },
  );
});

test("an inconclusive hold still requires consistent selection, files and actual installer count", () => {
  const paths = {
    home: "/home",
    old: "/home/old",
    vendor: "/home/vendor",
    installer: "/home/installer",
  };
  const old = { path: paths.old, realPath: paths.old, version: "1.0.113", overrideValue: null };
  const update = {
    receipt: { ok: false, before: old, after: old, commands: [{ args: ["install"] }] },
  };
  const after = { status: 0, receipt: { harnesses: [{ selection: old }] } };
  const disk = { pkg: true, shim: true, sibling: false };
  const calls = [
    ["installer", "install"],
    ["old", "--version"],
  ];
  const evaluate = (observed = after, files = disk, transcript = calls) => {
    checkConversionEffects(paths, update, observed, files, transcript, ["--version"]);
    check("release", 50, [record(2000), reason], { ...released, finishedMs: 2020 }, 0, {
      ok: false,
    });
  };
  assert.throws(() => evaluate(), { code: "fixture_gap" });
  assert.throws(
    () =>
      evaluate({ ...after, receipt: { harnesses: [{ selection: { ...old, version: "0.0.0" } }] } }),
    { code: "ERR_ASSERTION" },
  );
  assert.throws(
    () =>
      evaluate({
        ...after,
        receipt: { harnesses: [{ selection: { ...old, realPath: paths.vendor } }] },
      }),
    { code: "ERR_ASSERTION" },
  );
  assert.throws(() => evaluate(after, { ...disk, shim: false }), { code: "ERR_ASSERTION" });
  assert.throws(
    () => evaluate(after, disk, [...calls, calls[0]]),
    /actual synthetic installer invocations/,
  );
});

test("missing qualified controls are gaps, while a present control must match actual calls", () => {
  const healthy = [
    ["installer", "install"],
    ["vendor", "--version"],
  ];
  const release = [
    ["installer", "install"],
    ["old", "--version"],
  ];
  assert.throws(() => checkConversionBaseline("release", release, { release }), {
    code: "fixture_gap",
    message: /No qualified healthy control/,
  });
  assert.throws(() => checkConversionBaseline("persistent", release, { healthy }), {
    code: "fixture_gap",
    message: /No qualified release control/,
  });
  assert.throws(
    () => checkConversionBaseline("release", release, { healthy }),
    /version probes and installer/,
  );
  checkConversionBaseline("release", healthy, { healthy, release });
  checkConversionBaseline("persistent", release, { healthy, release });
});
