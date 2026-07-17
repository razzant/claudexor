import { describe, expect, it } from "vitest";
import { projectSession, projectThread } from "./thread-projection.js";

// Release wave round-15 #3: clients can SET a thread-sticky credential
// profile and are SUBJECT to a session's profile binding (resume never
// crosses profiles), so both projections must report the durable fields —
// a settable-but-invisible binding is not auditable.
describe("thread/session projections expose the profile bindings (INV-135)", () => {
  const now = new Date().toISOString();
  const thread = {
    id: "th-1",
    title: "t",
    repo: { root: "/repo", base_ref: "HEAD" },
    mode: "agent",
    workspace: { mode: "in_place" },
    auth_preference: "auto",
    primary_harness: null,
    eligible_harnesses: [],
    run_ids: [],
    head_run_id: null,
    state: "active",
    created_at: now,
    updated_at: now,
  };

  it("projects the thread's sticky credential_profile_id (and null when unset)", () => {
    expect(
      projectThread({ ...thread, credential_profile_id: "work" }, false).credentialProfileId,
    ).toBe("work");
    expect(projectThread(thread, false).credentialProfileId).toBeNull();
  });

  it("projects the session's creation profile_id (and null for engine-default)", () => {
    const session = {
      id: "se-1",
      thread_id: "th-1",
      harness_id: "claude",
      native_session_id: "n-1",
      last_observed_model: null,
      state: "live",
    };
    expect(projectSession({ ...session, profile_id: "work" }).profileId).toBe("work");
    expect(projectSession(session).profileId).toBeNull();
  });
});
