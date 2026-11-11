/**
 * A start lookup reads the bindings an earlier engine wrote for an unchanged request.
 * `RUN_5_1` and `TURN_5_1` are the v5.1.0 schema's own parse of these bodies (generated
 * from the v5.1.0 source; the digest owners have not changed since). A new defaulted
 * request field that would move the digest fails here instead of hiding accepted work.
 */
import { describe, expect, it } from "vitest";
import { ControlThreadTurnRequest } from "@claudexor/schema";
import { commandDigests } from "../../daemon/src/command-store.js";
import { turnIdempotency } from "../../daemon/src/thread-store-support.js";
import { acceptedRunQuery, recordedRunStart } from "./run-start.js";
import { acceptedTurnCommandQuery } from "./thread-recovery.js";
import { threadTurnCreateIdempotency } from "./thread-turn-routes.js";

const RUN_BODY = {
  mode: "agent",
  prompt: "Review the staged candidate",
  scope: { kind: "project", root: " /fixture/project ", context: "auto" },
  execution: { isolation: "live", workspaceRoot: "/fixture/clone", delegated: true },
  access: "full",
  model: "claude-opus-5",
  effort: "high",
};
/** v5.1.0 `RecordedControlRunStartRequest.parse(RUN_BODY)` after its replay projection. */
const RUN_5_1 = {
  prompt: "Review the staged candidate",
  mode: "agent",
  scope: { kind: "project", root: "/fixture/project", context: "auto", ephemeral: false },
  execution: { isolation: "live", delegated: true, workspaceRoot: "/fixture/clone" },
  model: "claude-opus-5",
  effort: "high",
  access: "full",
};
const TURN_BODY = {
  prompt: "Review the candidate in this round",
  mode: "agent",
  access: "readonly",
  reviewerPanel: [{ harness: "claude", model: "claude-opus-5" }],
};
/** v5.1.0 `ControlThreadTurnRequest.parse(TURN_BODY)`. */
const TURN_5_1 = {
  prompt: "Review the candidate in this round",
  mode: "agent",
  access: "readonly",
  reviewerPanel: [{ harness: "claude", model: "claude-opus-5" }],
};

function runDigests(params: unknown, key: string) {
  return commandDigests("partition", {
    params,
    idempotencyKey: key,
    clientId: "control-api",
    idempotencyParams: params,
  });
}

describe("start lookup canonicalization", () => {
  it("reads the command binding 5.1.0 wrote for an unchanged one-shot request", () => {
    const [params, options] = acceptedRunQuery(recordedRunStart(RUN_BODY), "key-1");
    expect(options).toMatchObject({ idempotencyKey: "key-1", clientId: "control-api" });
    expect(runDigests(options.idempotencyRequest, "key-1")).toEqual(runDigests(RUN_5_1, "key-1"));
    expect(params).toBe(options.idempotencyRequest);
    // Discriminating: an uncanonicalized body is another request.
    expect(runDigests(RUN_BODY, "key-1").requestDigest).not.toBe(
      runDigests(RUN_5_1, "key-1").requestDigest,
    );
  });

  it("reads the turn and command bindings 5.1.0 wrote for an unchanged turn request", () => {
    const body = ControlThreadTurnRequest.parse(TURN_BODY);
    const lookup = threadTurnCreateIdempotency("th-1", body, "key-2");
    const wrote = {
      key: "key-2",
      client: "control-api",
      request: { threadId: "th-1", body: TURN_5_1 },
    };
    expect(turnIdempotency("global", "th-1", lookup)).toEqual(
      turnIdempotency("global", "th-1", wrote),
    );
    const [params, options] = acceptedTurnCommandQuery("th-1", lookup);
    const command = (request: unknown) =>
      commandDigests("global", {
        params,
        idempotencyKey: options.idempotencyKey,
        clientId: options.clientId,
        operation: options.operation,
        idempotencyParams: request,
      });
    expect(command(options.idempotencyRequest)).toEqual(command(wrote.request));
    expect(command({ threadId: "th-2", body: TURN_5_1 }).requestDigest).not.toBe(
      command(wrote.request).requestDigest,
    );
  });
});
