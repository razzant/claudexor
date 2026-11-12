import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DelegatedEvidenceIncompleteError, DelegatedHomeUnavailableError } from "@claudexor/core";
import {
  DELIBERATE_NO_OUTER_BOUNDARY_REASON,
  RecordedAppliedAttemptFacts,
  WorkspaceEnvelope,
} from "@claudexor/schema";
import { ensureDir } from "@claudexor/util";
import { WorkspaceManager } from "@claudexor/workspace";
import {
  appliedAttemptFacts,
  appliedEvidenceComplete,
  assertDelegatedEvidence,
  followSpecHome,
  outerBoundaryNotice,
  scopedHarnessHome,
  selectLaneHome,
} from "./delegatedHome.js";

function envelopeAt(base: string, repoRoot: string, inPlace: boolean): WorkspaceEnvelope {
  const homeDir = join(base, "home");
  ensureDir(homeDir);
  return WorkspaceEnvelope.parse({
    id: "env-1",
    task_id: "task-1",
    attempt_id: "a01",
    repo_root: repoRoot,
    base_ref: "HEAD",
    base_sha: null,
    worktree_path: inPlace ? repoRoot : join(base, "tree"),
    branch_name: inPlace ? "inplace" : "claudexor/task-1/a01",
    home_dir: homeDir,
    harness_config_dirs: {
      codex_home: join(homeDir, ".codex"),
      claude_config: join(homeDir, ".claude"),
    },
    policy_profile: "workspace_write",
    dirty_policy: "snapshot",
    created_at: new Date().toISOString(),
  });
}

describe("scopedHarnessHome", () => {
  const base = mkdtempSync(join(tmpdir(), "claudexor-delegated-home-"));
  const repoRoot = join(base, "repo");
  ensureDir(repoRoot);
  const wsm = new WorkspaceManager(repoRoot, { runtimeRoot: join(base, "runtime") });
  afterAll(() => rmSync(base, { recursive: true, force: true }), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  it("leaves an ordinary in-place attempt on the operator's native environment", () => {
    expect(scopedHarnessHome(wsm, envelopeAt(base, repoRoot, true), true, false)).toEqual({
      isolated: false,
      homeDir: null,
      outerBoundaryUnavailableReason: null,
    });
  });

  it("scopes isolated and delegated in-place attempts", () => {
    const envelope = envelopeAt(base, repoRoot, true);
    const home = scopedHarnessHome(wsm, envelope, true, true);
    expect(home.isolated).toBe(true);
    expect(home.homeDir).toBe(envelope.home_dir);
    expect(home.env?.["HOME"]).toBe(envelope.home_dir);
    expect(home.env?.["CODEX_HOME"]).toBe(join(envelope.home_dir, ".codex"));
    expect(home.env?.["CLAUDE_CONFIG_DIR"]).toBe(join(envelope.home_dir, ".claude"));
    expect(home.env?.["XDG_CONFIG_HOME"]).toBe(join(envelope.home_dir, ".config"));
  });

  it("refuses a delegated attempt whose scoped home is absent", () => {
    const envelope = envelopeAt(base, repoRoot, true);
    rmSync(envelope.home_dir, { recursive: true, force: true });
    expect(() => scopedHarnessHome(wsm, envelope, true, true)).toThrowError(
      DelegatedHomeUnavailableError,
    );
    expect(scopedHarnessHome(wsm, envelope, true, false).isolated).toBe(false);
  });
});

describe("durable lane home of a delegated thread candidate (INV-034)", () => {
  const base = mkdtempSync(join(tmpdir(), "claudexor-delegated-lane-"));
  const project = join(base, "project");
  const copy = join(base, "copy");
  ensureDir(project);
  ensureDir(copy);
  // The execution root's manager owns per-attempt scratch; the lane belongs to
  // the stable project identity, exactly as the orchestrator keys it.
  const wsm = new WorkspaceManager(copy, { runtimeRoot: join(base, "copy-runtime") });
  const lanes = new WorkspaceManager(project, { runtimeRoot: join(base, "project-runtime") });
  const laneFor = (profile: string | null) => lanes.laneHomeEnv("th-1", "claude", profile).env;
  afterAll(() => rmSync(base, { recursive: true, force: true }), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  it("re-keys the in-place candidate to the resolved account's lane, the same home every turn", () => {
    const first = scopedHarnessHome(wsm, envelopeAt(base, copy, true), true, true, "full", laneFor);
    const envelopeHome = first.homeDir;
    selectLaneHome(first, "acct-a");
    const second = scopedHarnessHome(
      wsm,
      envelopeAt(base, copy, true),
      true,
      true,
      "full",
      laneFor,
    );
    selectLaneHome(second, "acct-a");
    const lane = laneFor("acct-a")["HOME"];
    expect(first.homeDir).toBe(lane);
    expect(first.homeDir).not.toBe(envelopeHome);
    expect(second.homeDir).toBe(first.homeDir);
    expect(first.env?.["HOME"]).toBe(lane);
    expect(lane).toContain(join("project-runtime", "lanes", "th-1", "claude-acct-a", "home"));
    expect(appliedAttemptFacts(first, "full", "requested")).toMatchObject({
      harness_home_isolated: true,
      harness_home_dir: lane,
      credential_profile_applied: "acct-a",
      confinement_unavailable_reason: DELIBERATE_NO_OUTER_BOUNDARY_REASON,
    });
    expect(appliedEvidenceComplete(appliedAttemptFacts(first, "full", "requested"))).toBe(true);
  });

  it("keeps Best-of/isolated candidates and ordinary in-place turns off the lane", () => {
    const isolated = scopedHarnessHome(
      wsm,
      envelopeAt(base, copy, false),
      false,
      true,
      "full",
      laneFor,
    );
    selectLaneHome(isolated, "acct-a");
    expect(isolated.laneHomeFor).toBeUndefined();
    expect(isolated.homeDir).toBe(join(base, "home"));
    const ordinary = scopedHarnessHome(
      wsm,
      envelopeAt(base, copy, true),
      true,
      false,
      "full",
      laneFor,
    );
    selectLaneHome(ordinary, "acct-a");
    expect(ordinary).toEqual({
      isolated: false,
      homeDir: null,
      outerBoundaryUnavailableReason: null,
    });
  });

  it("follows an in-run account hop: home and account move together, failure path included", () => {
    const home = scopedHarnessHome(
      wsm,
      envelopeAt(base, copy, true),
      true,
      true,
      "workspace_write",
      laneFor,
    );
    selectLaneHome(home, "acct-a");
    const rotatedEnv = laneFor("acct-b");
    // The live spec after rotatedSpecInLaneHome: account B, B's lane env.
    followSpecHome(home, { env: rotatedEnv, credential_profile: { profile_id: "acct-b" } }, null);
    // A later failure records through the SAME object with the run's requested
    // profile as fallback; the evidence must still name what actually ran.
    const failure = appliedAttemptFacts(home, "workspace_write", "acct-a");
    expect(failure.harness_home_dir).toBe(rotatedEnv["HOME"]);
    expect(failure.credential_profile_applied).toBe("acct-b");
  });

  it("does not relabel an envelope home that the spec never left", () => {
    const home = scopedHarnessHome(
      wsm,
      envelopeAt(base, copy, true),
      true,
      true,
      "workspace_write",
    );
    const before = home.homeDir;
    followSpecHome(home, { env: { HOME: "/somewhere/else" }, credential_profile: null }, "req");
    expect(home.homeDir).toBe(before);
    expect(appliedAttemptFacts(home, "workspace_write", "x").credential_profile_applied).toBe(
      "req",
    );
  });
});

describe("delegated boundary disclosure", () => {
  const base = mkdtempSync(join(tmpdir(), "claudexor-delegated-disclosure-"));
  const repoRoot = join(base, "project");
  ensureDir(repoRoot);
  const wsm = new WorkspaceManager(repoRoot, { runtimeRoot: join(base, "runtime") });
  afterAll(() => rmSync(base, { recursive: true, force: true }), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  it("keeps native workspace_write and records deliberate no-outer-boundary evidence", () => {
    const home = scopedHarnessHome(
      wsm,
      envelopeAt(base, repoRoot, true),
      true,
      true,
      "workspace_write",
    );
    expect(home.outerBoundaryUnavailableReason).toBe(DELIBERATE_NO_OUTER_BOUNDARY_REASON);
    expect(appliedAttemptFacts(home, "workspace_write", "profile-a")).toMatchObject({
      access_applied: "workspace_write",
      credential_profile_applied: "profile-a",
      confinement_mechanism: null,
      confinement_profile_digest: null,
      confinement_verified_denied_path: null,
      confinement_unavailable_reason: DELIBERATE_NO_OUTER_BOUNDARY_REASON,
    });
  });

  it("does not add the disclosure to readonly or ordinary attempts", () => {
    const envelope = envelopeAt(base, repoRoot, true);
    expect(
      scopedHarnessHome(wsm, envelope, true, true, "readonly").outerBoundaryUnavailableReason,
    ).toBeNull();
    expect(
      scopedHarnessHome(wsm, envelope, true, false, "workspace_write")
        .outerBoundaryUnavailableReason,
    ).toBeNull();
  });

  it("tells the child that scoped HOME is not containment", () => {
    const envelope = envelopeAt(base, repoRoot, true);
    const disclosure = outerBoundaryNotice(
      scopedHarnessHome(wsm, envelope, true, true, "workspace_write"),
    );
    expect(disclosure).toContain(DELIBERATE_NO_OUTER_BOUNDARY_REASON);
    expect(disclosure).toContain("not containment");
    expect(disclosure).toContain("Stay within\nthe execution workspace and do not access");
    expect(outerBoundaryNotice(scopedHarnessHome(wsm, envelope, true, false))).toBeNull();
  });

  it("names explicit auxiliary grants instead of claiming the workspace is the only target", () => {
    const envelope = envelopeAt(base, repoRoot, true);
    const roots = ["/srv/cache/uv", "/srv/scratch"];
    const delegated = outerBoundaryNotice(
      scopedHarnessHome(wsm, envelope, true, true, "workspace_write"),
      roots,
    );
    expect(delegated).toContain(
      "the execution workspace and the granted service directories below",
    );
    expect(delegated).toContain("/srv/cache/uv, /srv/scratch");
    expect(delegated).toContain("never part of the project result");
    // An ordinary lane has no boundary disclosure, but still learns its grant.
    expect(outerBoundaryNotice(scopedHarnessHome(wsm, envelope, true, false), roots)).toContain(
      "/srv/cache/uv, /srv/scratch",
    );
    expect(outerBoundaryNotice(scopedHarnessHome(wsm, envelope, true, false), [])).toBeNull();
  });
});

describe("applied attempt evidence", () => {
  const historicalProven = RecordedAppliedAttemptFacts.parse({
    harness_home_isolated: true,
    harness_home_dir: "/scoped",
    access_applied: "external_sandbox_full",
    credential_profile_applied: null,
    confinement_mechanism: "seatbelt",
    confinement_profile_digest: "sha256:abc",
    confinement_verified_denied_path: "/runtime",
    confinement_unavailable_reason: null,
  });
  const deliberate = {
    harness_home_isolated: true,
    harness_home_dir: "/scoped",
    access_applied: "workspace_write" as const,
    credential_profile_applied: null,
    confinement_mechanism: null,
    confinement_profile_digest: null,
    confinement_verified_denied_path: null,
    confinement_unavailable_reason: DELIBERATE_NO_OUTER_BOUNDARY_REASON,
  };

  it("writes an incomplete all-null block before home selection", () => {
    const facts = appliedAttemptFacts(undefined, "workspace_write", null);
    expect(facts).toEqual({
      harness_home_dir: null,
      access_applied: "workspace_write",
      credential_profile_applied: null,
      confinement_mechanism: null,
      confinement_profile_digest: null,
      confinement_verified_denied_path: null,
      confinement_unavailable_reason: null,
    });
    expect(appliedEvidenceComplete(facts)).toBe(false);
  });

  it("accepts historical proven Seatbelt and current deliberate absence", () => {
    expect(appliedEvidenceComplete(historicalProven)).toBe(true);
    expect(appliedEvidenceComplete(deliberate)).toBe(true);
    expect(() =>
      assertDelegatedEvidence(true, "workspace_write", [{ attemptId: "a01", applied: deliberate }]),
    ).not.toThrow();
  });

  it("refuses missing or half-proven evidence", () => {
    expect(() =>
      assertDelegatedEvidence(true, "workspace_write", [{ attemptId: "a01" }]),
    ).toThrowError(DelegatedEvidenceIncompleteError);
    expect(
      appliedEvidenceComplete({
        ...historicalProven,
        confinement_verified_denied_path: null,
      }),
    ).toBe(false);
  });

  it("leaves an attempt this run marked as failed before its HOME to its own failure (#648)", () => {
    const beforeHome = appliedAttemptFacts(undefined, "workspace_write", null);
    const marked = { errored: true, homeUndecided: true, applied: beforeHome } as const;
    // No child ran: the gate does not replace that attempt's own failure.
    expect(() =>
      assertDelegatedEvidence(true, "full", [{ attemptId: "a01", ...marked }]),
    ).not.toThrow();
    expect(() =>
      assertDelegatedEvidence(true, "workspace_write", [
        { attemptId: "a01", ...marked },
        { attemptId: "a02", applied: deliberate },
      ]),
    ).not.toThrow();
    // The gap stays a gap: the record never claims what did not run.
    expect(appliedEvidenceComplete(beforeHome)).toBe(false);
    // Only that marker exempts: the same homeless block read without it (a
    // historical record, or one whose catch did not know), a success, a missing
    // block, or a decided HOME without its disclosure stays unauditable.
    const started = { ...deliberate, confinement_unavailable_reason: null };
    for (const attempt of [
      { attemptId: "a03", errored: true, applied: beforeHome },
      { attemptId: "a03", homeUndecided: true, applied: beforeHome },
      { attemptId: "a03", errored: false, homeUndecided: true, applied: beforeHome },
      { attemptId: "a03", errored: true },
      { attemptId: "a03", errored: true, applied: started },
    ])
      expect(() =>
        assertDelegatedEvidence(true, "workspace_write", [
          { attemptId: "a01", ...marked },
          attempt,
        ]),
      ).toThrowError(/1 attempt\(s\) state neither .* \(a03\)$/);
  });

  it("does not gate non-delegated or readonly runs", () => {
    expect(() =>
      assertDelegatedEvidence(false, "workspace_write", [{ attemptId: "a01" }]),
    ).not.toThrow();
    expect(() => assertDelegatedEvidence(true, "readonly", [{ attemptId: "a01" }])).not.toThrow();
  });

  it("records the HOME an adapter actually gave its child instead of the engine HOME", () => {
    const spec = {
      env: { HOME: "/runtime/lane/home" },
      credential_profile: { profile_id: "acct" },
    };
    const profileHome = { childHome: () => "/owned/profiles/acct" };
    const delegated = followSpecHome(
      {
        isolated: true,
        homeDir: "/runtime/lane/home",
        outerBoundaryUnavailableReason: DELIBERATE_NO_OUTER_BOUNDARY_REASON,
      },
      spec,
      null,
      profileHome,
    );
    const facts = appliedAttemptFacts(delegated, "workspace_write", "acct");
    expect(facts).toMatchObject({
      harness_home_isolated: true,
      harness_home_dir: "/owned/profiles/acct",
      credential_profile_applied: "acct",
      confinement_unavailable_reason: DELIBERATE_NO_OUTER_BOUNDARY_REASON,
    });
    expect(appliedEvidenceComplete(facts)).toBe(true);
    // An ordinary in-place attempt inherits the operator env, but a child the
    // adapter moved into a Claudexor-owned profile HOME did not run there.
    const ordinary = () => ({
      isolated: false,
      homeDir: null,
      outerBoundaryUnavailableReason: null,
    });
    expect(
      appliedAttemptFacts(followSpecHome(ordinary(), spec, null, profileHome), "full", "acct"),
    ).toMatchObject({ harness_home_isolated: true, harness_home_dir: "/owned/profiles/acct" });
    // Without an adapter-named HOME the record is unchanged.
    for (const adapter of [undefined, {}, { childHome: () => null }])
      expect(
        appliedAttemptFacts(followSpecHome(ordinary(), spec, null, adapter), "full", "acct"),
      ).toMatchObject({ harness_home_isolated: false, harness_home_dir: null });
    // A failure before the home was decided keeps its gap: no child ran.
    expect(appliedAttemptFacts(undefined, "workspace_write", "acct")).not.toHaveProperty(
      "harness_home_isolated",
    );
  });
});
