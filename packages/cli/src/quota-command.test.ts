import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  controlApiFetch: vi.fn(),
  print: vi.fn(),
  printCliFailure: vi.fn(),
  printJson: vi.fn(),
}));

vi.mock("./daemon-run.js", () => ({ ensureDaemon: mocks.ensureDaemon }));
vi.mock("./live.js", () => ({ controlApiFetch: mocks.controlApiFetch }));
vi.mock("./cli-io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cli-io.js")>()),
  print: mocks.print,
  printCliFailure: mocks.printCliFailure,
  printJson: mocks.printJson,
}));

import { parseArgs } from "./args.js";
import { quotaCommand } from "./quota-command.js";

describe("quotaCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureDaemon.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "test" },
    });
    mocks.printCliFailure.mockImplementation((_json: boolean, error: { status?: number }) =>
      error.status === 400 ? 2 : 1,
    );
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
    expect(mocks.printCliFailure).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: 503,
        code: "quota_unavailable",
        message: "quota source is unavailable",
        retryable: true,
        requiredActions: ["retry"],
      }),
      { prefix: "claudexor quota: " },
    );
    expect(mocks.printJson).not.toHaveBeenCalled();
  });

  it("renders typed absences as lines in text mode", async () => {
    mocks.controlApiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          snapshots: [],
          absences: [
            {
              subject: {
                harness: "codex",
                credential_route: "vendor_native",
                plan_label: null,
                subject_id: "work",
              },
              reason: "not_logged_in",
              detail: "no login",
              observed_at: "2026-07-19T12:00:00.000Z",
            },
          ],
          refreshed_at: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    expect(await quotaCommand(parseArgs([]), false)).toBe(0);
    expect(mocks.print).toHaveBeenCalledWith("codex/work: no snapshot — not_logged_in (no login)");
  });

  it("passes absences through --json", async () => {
    mocks.controlApiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          snapshots: [],
          absences: [
            {
              subject: {
                harness: "claude",
                credential_route: "vendor_native",
                plan_label: null,
                subject_id: null,
              },
              reason: "no_source",
              detail: null,
              observed_at: "2026-07-19T12:00:00.000Z",
            },
          ],
          refreshed_at: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    expect(await quotaCommand(parseArgs([]), true)).toBe(0);
    expect(mocks.printJson).toHaveBeenCalledWith(
      expect.objectContaining({
        absences: [expect.objectContaining({ reason: "no_source" })],
      }),
    );
  });
});
