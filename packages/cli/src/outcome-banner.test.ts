import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ controlApiFetch: vi.fn() }));
vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live.js")>()),
  controlApiFetch: mocks.controlApiFetch,
}));

import { fetchOutcomeBanner, fetchRunDetail } from "./daemon-run.js";
import type { ControlApiAddress } from "./live.js";

const addr = { host: "127.0.0.1", port: 1, token: "t" } as unknown as ControlApiAddress;

describe("fetchOutcomeBanner (CLI consumer of the server-owned banner, D18)", () => {
  it("returns the server-owned banner string verbatim from the run detail", async () => {
    mocks.controlApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ outcomeBanner: "Candidate ready — NOT APPLIED" }),
    });
    expect(await fetchOutcomeBanner(addr, "run-1")).toBe("Candidate ready — NOT APPLIED");
  });

  it("returns null when the run is not terminal (no banner yet)", async () => {
    mocks.controlApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ outcomeBanner: null }),
    });
    expect(await fetchOutcomeBanner(addr, "run-1")).toBeNull();
  });

  it("returns null on a missing run detail instead of guessing a headline", async () => {
    mocks.controlApiFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    expect(await fetchOutcomeBanner(addr, "run-1")).toBeNull();
  });

  it("returns null for an empty run id without touching the network", async () => {
    mocks.controlApiFetch.mockClear();
    expect(await fetchOutcomeBanner(addr, "")).toBeNull();
    expect(mocks.controlApiFetch).not.toHaveBeenCalled();
  });
});

describe("fetchRunDetail three-state semantics (missing / unavailable / invalid)", () => {
  it("soft-fails to null on a missing (404/legacy) detail and on transport unavailability", async () => {
    mocks.controlApiFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    expect(await fetchRunDetail(addr, "run-1")).toBeNull();
    mocks.controlApiFetch.mockRejectedValue(new Error("socket lost"));
    expect(await fetchRunDetail(addr, "run-1")).toBeNull();
  });

  it("raises a typed problem for 500 run_facts_invalid instead of masquerading as legacy", async () => {
    mocks.controlApiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        code: "run_facts_invalid",
        message: "canonical RunFacts receipt is invalid",
        retryable: false,
        requiredActions: ["inspect_run_artifacts"],
      }),
    });
    await expect(fetchRunDetail(addr, "run-1")).rejects.toMatchObject({
      code: "run_facts_invalid",
      retryable: false,
    });
  });

  it("raises other typed non-404 problems through the same failure path", async () => {
    mocks.controlApiFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ code: "journal_recovery_required", message: "partition recovering" }),
    });
    await expect(fetchRunDetail(addr, "run-1")).rejects.toMatchObject({
      code: "journal_recovery_required",
    });
  });

  it("returns the parsed detail body on success", async () => {
    mocks.controlApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ runFacts: null, outcomeBanner: "Done" }),
    });
    expect(await fetchRunDetail(addr, "run-1")).toEqual({ runFacts: null, outcomeBanner: "Done" });
  });
});
