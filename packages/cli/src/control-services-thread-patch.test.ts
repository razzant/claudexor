import { describe, expect, it } from "vitest";
import { controlServices } from "./control-services.js";

describe("thread PATCH forwarding (release wave round-7 tier1 blocker)", () => {
  it("updateThread forwards EVERY typed patch field — credentialProfileId included", async () => {
    let seen: Record<string, unknown> | undefined;
    const threads = {
      updateThread: (_id: string, patch: Record<string, unknown>) => {
        seen = patch;
        return { id: "th-1" };
      },
    };
    const services = controlServices(
      undefined as never,
      undefined as never,
      threads as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      async () => [],
    );
    await services.updateThread("th-1", {
      title: "t",
      state: "active",
      primaryHarness: "claude",
      credentialProfileId: "work",
      eligibleHarnesses: ["claude"],
    });
    // The schema contract promises the sticky profile is settable/clearable;
    // a service-layer drop silently voids it (the exact blocker class).
    expect(seen).toMatchObject({
      title: "t",
      primaryHarness: "claude",
      credentialProfileId: "work",
      eligibleHarnesses: ["claude"],
    });
    await services.updateThread("th-1", { credentialProfileId: null });
    expect(seen).toMatchObject({ credentialProfileId: null });
  });
});
