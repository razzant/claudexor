import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  controlApiFetch: vi.fn(),
  print: vi.fn(),
  printJson: vi.fn(),
}));

vi.mock("./daemon-run.js", () => ({ ensureDaemon: mocks.ensureDaemon }));
vi.mock("./live.js", () => ({ controlApiFetch: mocks.controlApiFetch }));
vi.mock("./cli-io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cli-io.js")>()),
  print: mocks.print,
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
    expect(mocks.print).toHaveBeenCalledWith(
      "codex/work: no fresh snapshot — not_logged_in (no login)",
    );
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

  it("describes no_source as a quota-window gap, not absence of account resources", async () => {
    mocks.controlApiFetch.mockResolvedValue(
      Response.json({
        snapshots: [],
        absences: [
          {
            subject: {
              harness: "cursor",
              credential_route: "vendor_native",
              plan_label: null,
              subject_id: "work",
            },
            reason: "no_source",
            detail: null,
            observed_at: "2026-10-15T00:00:00Z",
          },
        ],
        refreshed_at: null,
      }),
    );
    expect(await quotaCommand(parseArgs([]), false)).toBe(0);
    expect(mocks.print).toHaveBeenCalledWith(
      "cursor/work: no fresh snapshot — no quota-window source (account resources may be reported separately)",
    );
  });

  it("identifies a paused account and route while retaining legacy vendor-only disclosure", async () => {
    const until = "2026-10-04T15:00:00Z";
    mocks.controlApiFetch.mockResolvedValue(
      Response.json({
        snapshots: [],
        refreshed_at: null,
        refresh_skipped: [
          {
            vendor: "claude",
            not_before: until,
            subject: {
              harness: "claude",
              subject_id: "work",
              credential_route: "vendor_native",
              plan_label: null,
            },
          },
          { vendor: "codex", not_before: until },
        ],
      }),
    );
    expect(await quotaCommand(parseArgs([]), false)).toBe(0);
    expect(mocks.print).toHaveBeenCalledWith(
      `claude/work (vendor_native): refresh skipped (rate-limit cooldown until ${until})`,
    );
    expect(mocks.print).toHaveBeenCalledWith(
      `codex: refresh skipped (rate-limit cooldown until ${until})`,
    );
  });
});
