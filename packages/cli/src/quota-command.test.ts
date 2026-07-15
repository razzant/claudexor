import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  controlApiFetch: vi.fn(),
  printJson: vi.fn(),
}));

vi.mock("./daemon-run.js", () => ({ ensureDaemon: mocks.ensureDaemon }));
vi.mock("./live.js", () => ({ controlApiFetch: mocks.controlApiFetch }));
vi.mock("./cli-io.js", () => ({ print: vi.fn(), printJson: mocks.printJson }));

import { parseArgs } from "./args.js";
import { quotaCommand } from "./quota-command.js";

describe("quotaCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureDaemon.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "test" },
    });
  });

  it("reports problem+json before attempting the success schema", async () => {
    mocks.controlApiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "quota_unavailable",
          message: "quota source is unavailable",
          retryable: true,
          fieldErrors: {},
          requiredActions: ["retry"],
          evidenceRefs: [],
          context: {},
        }),
        { status: 503, headers: { "content-type": "application/problem+json" } },
      ),
    );

    expect(await quotaCommand(parseArgs([]), true)).toBe(1);
    expect(mocks.printJson).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("quota_unavailable") }),
    );
    expect(mocks.printJson).not.toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("snapshots") }),
    );
  });
});
