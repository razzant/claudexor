import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ controlApiFetch: vi.fn() }));
vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live.js")>()),
  controlApiFetch: mocks.controlApiFetch,
}));

import { fetchOutcomeBanner } from "./daemon-run.js";
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

  it("returns null on a non-OK response instead of guessing a headline", async () => {
    mocks.controlApiFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await fetchOutcomeBanner(addr, "run-1")).toBeNull();
  });

  it("returns null for an empty run id without touching the network", async () => {
    mocks.controlApiFetch.mockClear();
    expect(await fetchOutcomeBanner(addr, "")).toBeNull();
    expect(mocks.controlApiFetch).not.toHaveBeenCalled();
  });
});
