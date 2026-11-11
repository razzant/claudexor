import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountResetCommand } from "./account-reset-command.js";
import { quotaCommand } from "./quota-command.js";
import { parseArgs } from "./args.js";
import { controlApiFetch } from "./live.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";
import { accountResourceTools } from "../../mcp-server/src/account-resource-tools.js";
vi.mock("./daemon-run.js", () => ({
  ensureDaemon: vi.fn(async () => ({ addr: { host: "127.0.0.1", port: 1, token: "fixture" } })),
  connectDaemonIfRunning: vi.fn(async () => ({
    addr: { host: "127.0.0.1", port: 1, token: "fixture" },
  })),
}));
vi.mock("./live.js", () => ({ controlApiFetch: vi.fn() }));
vi.mock("./cli-io.js", () => ({ print: vi.fn(), printJson: vi.fn(), printErr: vi.fn() }));
const target = { harness: "claude", profile_id: "claude-default" };
const receipt = {
  id: "account-reset-fixture",
  request: { target, offer_id: "claude_granted", grant_id: "one" },
  state: "completed",
  created_at: "2026-10-09T12:00:00Z",
  completed_at: "2026-10-09T12:00:01Z",
  outcome: "unknown",
  detail: null,
  readback: { state: "failed", attempted_at: null, detail: null },
  resources: null,
};
beforeEach(() => vi.clearAllMocks());
describe("CLI and MCP account wire parity", () => {
  it("sends the original request and key through a lost response with no receipt id", async () => {
    vi.mocked(controlApiFetch)
      .mockRejectedValueOnce(new Error("fixture HTTP timeout"))
      .mockImplementation(async () => new Response(JSON.stringify(receipt)));
    const args = parseArgs([
      "account-reset",
      "claude/claude-default",
      "--offer",
      "claude_granted",
      "--grant",
      "one",
      "--idempotency-key",
      "same-key",
    ]);
    expect(await accountResetCommand(args, true)).toBe(1);
    const tools = accountResourceTools(mcpSurfaceRunner());
    const result = await tools
      .find((t) => t.name === "claudexor_account_reset")!
      .handler({ ...receipt.request, idempotency_key: "same-key" }, {});
    const first = vi.mocked(controlApiFetch).mock.calls[0]!;
    const second = vi.mocked(controlApiFetch).mock.calls[1]!;
    expect(first.slice(1)).toEqual(second.slice(1));
    expect(second[1]).toBe("/account-resets");
    expect(second[2]).toMatchObject({
      method: "POST",
      headers: { "Idempotency-Key": "same-key" },
      body: JSON.stringify(receipt.request),
    });
    expect(result).toMatchObject({ structured: receipt });
  });
  it("uses the same selected refresh and rich read shape on CLI and MCP", async () => {
    const rich = { snapshots: [], absences: [], refreshed_at: null, resources: [] };
    vi.mocked(controlApiFetch).mockImplementation(async () => new Response(JSON.stringify(rich)));
    expect(
      await quotaCommand(
        parseArgs(["quota", "--resources", "--refresh", "--profile", "claude/claude-default"]),
        true,
      ),
    ).toBe(0);
    const tool = accountResourceTools(mcpSurfaceRunner()).find(
      (t) => t.name === "claudexor_account_resources",
    )!;
    expect(await tool.handler({ refresh: true, target }, {})).toMatchObject({ structured: rich });
    const calls = vi.mocked(controlApiFetch).mock.calls;
    expect(calls[0]?.slice(1)).toEqual(calls[1]?.slice(1));
    expect(calls[1]?.[1]).toBe("/quota?view=resources&includeApiKeys=true");
  });
});
