import { describe, expect, it } from "vitest";
import { OPERATION_CATALOG } from "./operation-catalog.js";

const op = (method: string, path: string) =>
  OPERATION_CATALOG.operations.find((o) => o.method === method && o.path === path);

describe("operation catalog wording (QA-039 / QA-049)", () => {
  it("describes uploads honestly as single-shot — no resumable/append/range claim", () => {
    // The store is single-shot (ResourceStore truncates on write and requires
    // the whole declared body in ONE request); the catalog must not promise a
    // resumable/append/byte-range protocol it cannot honor.
    const uploadSummaries = [
      op("POST", "/v2/uploads"),
      op("PUT", "/v2/uploads/:id/bytes"),
      op("GET", "/v2/uploads/:id"),
    ].map((o) => {
      expect(o).toBeDefined();
      return (o?.summary ?? "").toLowerCase();
    });
    for (const summary of uploadSummaries) {
      // The honest "not resumable" disclosure is allowed; any AFFIRMATIVE
      // resumable/append/byte-range claim is not.
      const affirmative = summary.replace(/\bnot\b[^.]*?resumable[^.]*/g, "");
      expect(affirmative).not.toMatch(/resumable|append|byte range|content-range|upload-offset/);
    }
    // The PUT descriptor states the single-request contract explicitly.
    expect(op("PUT", "/v2/uploads/:id/bytes")?.summary.toLowerCase()).toMatch(/one request|single/);
  });

  it("advertises the opt-in store identity header on the handshake", () => {
    expect(op("POST", "/v2/handshake")?.parameters).toEqual([
      expect.objectContaining({
        name: "x-claudexor-store-identity",
        location: "header",
        required: false,
        enum: ["1"],
      }),
    ]);
  });

  it("advertises DELETE /v2/projects/:id as a fenced, artifact-retaining removal", () => {
    const remove = op("DELETE", "/v2/projects/:id");
    expect(remove).toBeDefined();
    expect(remove?.mutability).toBe("mutating");
    expect(remove?.responseSchema).toBe("ControlProjectRemoveReceipt");
    expect(remove?.summary.toLowerCase()).toMatch(/409|refused/);
  });

  it("advertises the fixed-window route-health read as a global parameterless fact", () => {
    const health = op("GET", "/v2/daemon/route-health");
    expect(health).toMatchObject({
      mutability: "read_only",
      requestSchema: null,
      responseSchema: "ControlRouteHealth",
      applicability: "global",
      parameters: [],
      idempotency: "natural",
    });
    expect(health?.summary).toContain("seven days");
    expect(health?.summary.toLowerCase()).not.toMatch(/threshold.*(alarm|alert)|alarm/);
  });

  it("advertises addressed run timer read and revision-guarded mutation", () => {
    const read = op("GET", "/v2/runs/:id/time-limit");
    const patch = op("PATCH", "/v2/runs/:id/time-limit");
    expect(read).toMatchObject({
      mutability: "read_only",
      responseSchema: "RunTimeLimitSnapshot",
      applicability: "run",
    });
    expect(patch).toMatchObject({
      mutability: "mutating",
      requestSchema: "RunTimeLimitRequest",
      responseSchema: "RunTimeLimitSnapshot",
      applicability: "run",
      idempotency: "none",
    });
    expect(patch?.summary).toContain("expected revision");
  });

  it("advertises the typed taken decision for captured terminal patches", () => {
    const decision = op("POST", "/v2/runs/:id/decision");
    expect(decision).toMatchObject({
      requestSchema: "ControlRunDecisionRequest",
      responseSchema: "ControlRunDecisionResponse",
      idempotency: "key_required",
    });
    expect(decision?.summary).toMatch(/taken/);
    expect(decision?.summary).toMatch(/captured_result/);
  });
});
