import { describe, expect, it } from "vitest";
import {
  RUN_SCOPE_MARKER_PREFIX,
  SCOPE_MARKER_NAME,
  inheritedScopeMarkers,
  isRunScopeMarkerName,
  isScopeMarkerName,
  mintRunScopeMarker,
  scopeMarkerEnv,
  withoutRunScopeMarkers,
} from "./process-scope.js";
import { composeBaseEnv, composeSpawnEnv } from "./env-scope.js";

const NO_RUNNER = "/no/such/node";
const HEX = "0123456789abcdef0123456789abcdef";

describe("scope marker grammar", () => {
  it("mints a run marker of the shared shape with 32 random hex digits", () => {
    const a = mintRunScopeMarker();
    const b = mintRunScopeMarker();
    expect(a).toMatch(SCOPE_MARKER_NAME);
    expect(a.startsWith(RUN_SCOPE_MARKER_PREFIX)).toBe(true);
    expect(a.slice(RUN_SCOPE_MARKER_PREFIX.length)).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(isRunScopeMarkerName(a)).toBe(true);
    expect(scopeMarkerEnv(a)).toEqual({ [a]: "1" });
  });

  it("accepts every role of the grammar and refuses near-misses", () => {
    expect(isScopeMarkerName(`OURO_INSTALL_SCOPE_${HEX}`)).toBe(true);
    expect(isScopeMarkerName(`OURO_TASK_SCOPE_${HEX}`)).toBe(true);
    expect(isScopeMarkerName(`CLAUDEXOR_RUN_SCOPE_${HEX}`)).toBe(true);
    // Path-shaped, short, uppercase hex, lowercase prefix, wrong separator.
    expect(isScopeMarkerName(`/tmp/x_SCOPE_${HEX}`)).toBe(false);
    expect(isScopeMarkerName(`X_SCOPE_${HEX.slice(0, 31)}`)).toBe(false);
    expect(isScopeMarkerName(`X_SCOPE_${HEX.toUpperCase()}`)).toBe(false);
    expect(isScopeMarkerName(`x_scope_${HEX}`)).toBe(false);
    expect(isScopeMarkerName(`X-SCOPE_${HEX}`)).toBe(false);
    expect(isScopeMarkerName(`OURO_PROC_CONTAINER_${HEX}`)).toBe(false);
    expect(isRunScopeMarkerName(`OURO_INSTALL_SCOPE_${HEX}`)).toBe(false);
    expect(() => scopeMarkerEnv("NOT_A_MARKER")).toThrow(/grammar/);
  });

  it("collects only grammar-matching names whose value is exactly 1", () => {
    const run = mintRunScopeMarker();
    const markers = inheritedScopeMarkers({
      [run]: "1",
      [`OURO_INSTALL_SCOPE_${HEX}`]: "1",
      [`OURO_TASK_SCOPE_${HEX}`]: "true",
      [`OURO_PROC_CONTAINER_${HEX}`]: "1",
      PATH: "/usr/bin",
      [`X_SCOPE_${HEX}`]: "",
    });
    expect(markers).toEqual({ [run]: "1", [`OURO_INSTALL_SCOPE_${HEX}`]: "1" });
  });
});

describe("a process handed to a longer-lived custodian", () => {
  it("sheds only Claudexor run markers; a host's markers and every other entry stay", () => {
    const run = mintRunScopeMarker();
    const host = `OURO_INSTALL_SCOPE_${HEX}`;
    expect(
      withoutRunScopeMarkers({ [run]: "1", [host]: "1", HOME: "/row", CURSOR_API_KEY: null }),
    ).toEqual({ [host]: "1", HOME: "/row", CURSOR_API_KEY: null });
  });
});

describe("clean inheritance forwards enclosing scope markers (CX item 1)", () => {
  const install = `OURO_INSTALL_SCOPE_${HEX}`;
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    [install]: "1",
    [`OURO_PROC_CONTAINER_${HEX}`]: "1",
    SECRET_THING: "leak",
    [`FAKE_SCOPE_${HEX}`]: "2",
  };

  it("clean keeps the installation marker and still drops everything else off the allowlist", () => {
    const env = composeBaseEnv("clean", source, NO_RUNNER);
    expect(env[install]).toBe("1");
    expect("SECRET_THING" in env).toBe(false);
    // Not forwarded: the legacy container token (not the grammar) and a
    // grammar-shaped name whose value is not `1`.
    expect(`OURO_PROC_CONTAINER_${HEX}` in env).toBe(false);
    expect(`FAKE_SCOPE_${HEX}` in env).toBe(false);
  });

  it("mirror_native carries the marker as it always did", () => {
    const env = composeBaseEnv("mirror_native", source, NO_RUNNER);
    expect(env[install]).toBe("1");
    expect(env.SECRET_THING).toBe("leak");
  });

  it("a run marker in the spec patch survives clean composition (applied after the base)", () => {
    const run = mintRunScopeMarker();
    const env = composeSpawnEnv("clean", { ...scopeMarkerEnv(run), HOME: "/scoped/home" });
    expect(env[run]).toBe("1");
    expect(env.HOME).toBe("/scoped/home");
  });
});
