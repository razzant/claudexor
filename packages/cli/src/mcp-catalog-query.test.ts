import { beforeEach, describe, expect, it, vi } from "vitest";

const controlApiFetch = vi.fn(async (_addr: unknown, path: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ path }),
}));

vi.mock("./daemon-run.js", () => ({
  ensureDaemon: async () => ({ addr: { url: "http://127.0.0.1:1", token: "t" } }),
  connectDaemonIfRunning: async () => ({ addr: { url: "http://127.0.0.1:1", token: "t" } }),
}));
vi.mock("./live.js", () => ({
  controlApiFetch: (addr: unknown, path: string) => controlApiFetch(addr, path),
}));

const { catalogQuery } = await import("./mcp-catalog-query.js");

describe("catalogQuery __accounts routing (MCP accounts default is cached)", () => {
  beforeEach(() => controlApiFetch.mockClear());

  it("defaults to the cached credential-profiles listing (no snapshot fan-out)", async () => {
    await catalogQuery("__accounts");
    expect(controlApiFetch).toHaveBeenCalledWith(expect.anything(), "/credential-profiles");
  });

  it("fresh:true opts into the atomic snapshot form", async () => {
    await catalogQuery("__accounts", false, { fresh: true });
    expect(controlApiFetch).toHaveBeenCalledWith(
      expect.anything(),
      "/credential-profiles?snapshot=true",
    );
  });

  it("anything but fresh:true stays cached", async () => {
    await catalogQuery("__accounts", false, {});
    await catalogQuery("__accounts", false, { fresh: false });
    // Each listing joins the additive routing-evidence read; neither refreshes.
    expect(controlApiFetch.mock.calls.map(([, path]) => path)).toEqual([
      "/credential-profiles",
      "/accounts/routing-evidence?includeCapabilities=true&includeCredentialUnusable=true",
      "/credential-profiles",
      "/accounts/routing-evidence?includeCapabilities=true&includeCredentialUnusable=true",
    ]);
  });
});
