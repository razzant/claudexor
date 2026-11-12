import { describe, expect, it } from "vitest";
import type { Intent } from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { RequestRequirementsError, RequestRequirementsResolver } from "./requestRequirements.js";

describe("RequestRequirementsResolver browser preflight", () => {
  const resolver = new RequestRequirementsResolver();

  it("keeps mixed lanes truthful without dropping the incapable lane", () => {
    const capable = resolver.resolveBrowser({
      harnessId: "codex",
      requested: true,
      manifestCapable: true,
      requiresFullAccess: true,
      webPolicy: "auto",
      access: "full",
    });
    const incapable = resolver.resolveBrowser({
      harnessId: "cursor",
      requested: true,
      manifestCapable: false,
      requiresFullAccess: false,
      webPolicy: "auto",
      access: "full",
    });

    expect([capable, incapable]).toMatchObject([
      { harness_id: "codex", eligible: true, requested: true, effective: true },
      {
        harness_id: "cursor",
        eligible: false,
        requested: true,
        effective: false,
        reason: "manifest_unsupported",
      },
    ]);
    expect(() => resolver.requireEffectiveBrowser(true, [capable, incapable])).not.toThrow();
  });

  it.each([
    ["manifest_unsupported", false, false, "auto", "full"],
    ["web_policy_off", true, false, "off", "full"],
    ["access_profile_incompatible", true, true, "auto", "workspace_write"],
  ] as const)(
    "refuses a zero-effective pool with typed reason %s",
    (reason, capable, requiresFullAccess, web, access) => {
      const resolution = resolver.resolveBrowser({
        harnessId: "lane",
        requested: true,
        manifestCapable: capable,
        requiresFullAccess,
        webPolicy: web,
        access,
      });
      expect(resolution.reason).toBe(reason);
      expect(() => resolver.requireEffectiveBrowser(true, [resolution])).toThrow(
        RequestRequirementsError,
      );
      try {
        resolver.requireEffectiveBrowser(true, [resolution]);
      } catch (error) {
        expect(error).toMatchObject({ code: "browser_unavailable", resolutions: [resolution] });
      }
    },
  );

  it("projects browser wiring only from an effective receipt", () => {
    const effective = resolver.resolveBrowser({
      harnessId: "codex",
      requested: true,
      manifestCapable: true,
      requiresFullAccess: true,
      webPolicy: "auto",
      access: "full",
    });
    expect(resolver.browserSpec(effective, "/tmp/run-root/browser")).toEqual({
      output_dir: "/tmp/run-root/browser",
      headless: false,
    });
    expect(resolver.browserSpec({ ...effective, effective: false }, "/tmp/browser")).toBeNull();
  });

  it("admits workspace-write Browser only when the adapter's native MCP policy permits it", () => {
    const claude = resolver.resolveBrowser({
      harnessId: "claude",
      requested: true,
      manifestCapable: true,
      requiresFullAccess: false,
      webPolicy: "auto",
      access: "workspace_write",
    });
    const codex = resolver.resolveBrowser({
      harnessId: "codex",
      requested: true,
      manifestCapable: true,
      requiresFullAccess: true,
      webPolicy: "auto",
      access: "workspace_write",
    });
    const readonly = resolver.resolveBrowser({
      harnessId: "claude",
      requested: true,
      manifestCapable: true,
      requiresFullAccess: false,
      webPolicy: "auto",
      access: "readonly",
    });
    expect(claude).toMatchObject({ effective: true, reason: "effective" });
    expect(codex).toMatchObject({ effective: false, reason: "access_profile_incompatible" });
    expect(readonly).toMatchObject({ effective: false, reason: "access_profile_incompatible" });
  });

  it("returns the first finite attachment-limit refusal", () => {
    const attachment = {
      resource_id: "res-1",
      kind: "file" as const,
      mime: "text/plain",
      name: "notes.txt",
      sha256: "sha256:test",
      size_bytes: 12,
      path: "/tmp/notes.txt",
    };
    expect(resolver.resolveAttachmentLane("raw", [attachment], []).message).toContain(
      "text/plain is unsupported",
    );
    expect(
      resolver.resolveAttachmentLane(
        "raw",
        [attachment],
        [
          {
            kind: "file",
            mime_types: ["text/plain"],
            max_bytes: 20,
            max_count: 1,
            transport: "text_inline",
          },
        ],
      ).message,
    ).toBeNull();
  });

  it("returns typed per-lane attachment admission reasons", () => {
    const attachment = {
      resource_id: "res-1",
      kind: "file" as const,
      mime: "text/plain",
      name: "notes.txt",
      sha256: "sha256:test",
      size_bytes: 12,
      path: "/tmp/notes.txt",
    };
    expect(resolver.resolveAttachmentLane("cursor", [attachment], [])).toMatchObject({
      harnessId: "cursor",
      admitted: false,
      reason: "unsupported_input",
      attachmentResourceId: "res-1",
    });
    const declaration = {
      kind: "file" as const,
      mime_types: ["text/plain"],
      max_bytes: 20,
      max_count: 1,
      transport: "text_inline" as const,
    };
    expect(
      resolver.resolveAttachmentLane(
        "cursor",
        [{ ...attachment, resource_id: "big", size_bytes: 21 }],
        [declaration],
      ),
    ).toMatchObject({ admitted: false, reason: "max_bytes_exceeded" });
    expect(
      resolver.resolveAttachmentLane(
        "cursor",
        [attachment, { ...attachment, resource_id: "res-2" }],
        [declaration],
      ),
    ).toMatchObject({ admitted: false, reason: "max_count_exceeded" });
  });

  it("owns exact explicit and auto attachment-pool aggregation", () => {
    const attachment = {
      resource_id: "res-1",
      kind: "file" as const,
      mime: "text/plain",
      name: "notes.txt",
      sha256: "sha256:test",
      size_bytes: 12,
      path: "/tmp/notes.txt",
    };
    const declaration = {
      kind: "file" as const,
      mime_types: ["text/plain"],
      max_bytes: 20,
      max_count: 1,
      transport: "text_inline" as const,
    };
    const lanes = [
      { harnessId: "capable", declarations: [declaration], available: true },
      { harnessId: "blind", declarations: [], available: true },
      { harnessId: "offline", declarations: [declaration], available: false },
      { harnessId: "capable", declarations: [], available: true },
    ];

    expect(resolver.resolveAttachmentPool("explicit", [attachment], lanes)).toMatchObject({
      outcome: "refused",
      admittedHarnessIds: [],
      rejected: [{ harnessId: "blind", reason: "unsupported_input" }],
    });
    expect(resolver.resolveAttachmentPool("auto", [attachment], lanes)).toMatchObject({
      outcome: "degraded",
      admittedHarnessIds: ["capable"],
      rejected: [{ harnessId: "blind", reason: "unsupported_input" }],
    });
    expect(
      resolver.resolveAttachmentPool(
        "auto",
        [attachment],
        [{ harnessId: "offline", declarations: [declaration], available: false }],
      ),
    ).toMatchObject({ outcome: "refused", admittedHarnessIds: [], rejected: [] });
  });
});

describe("RequestRequirementsResolver Delegate preflight", () => {
  const resolver = new RequestRequirementsResolver();

  it("gives manifest incapability precedence when both manifest and runtime are unavailable", () => {
    expect(
      resolver.resolveDelegation({
        harnessId: "incapable",
        requested: true,
        manifestCapable: false,
        runtimeAvailable: false,
        requiresFullAccess: false,
        fullAccess: false,
      }),
    ).toMatchObject({
      effective: false,
      reason: "manifest_unsupported",
      evidence_refs: ["manifest.capability_profile.mcp_injection"],
    });
  });
});

describe("adapterAccess native policy", () => {
  const resolver = new RequestRequirementsResolver();

  it("preserves requested native access", () => {
    expect(resolver.adapterAccess("implement", "workspace", "workspace_write")).toBe(
      "workspace_write",
    );
    expect(resolver.adapterAccess("implement", "workspace", "full")).toBe("full");
  });

  it("retains the patch-envelope readonly clamp", () => {
    expect(resolver.adapterAccess("implement", "workspace", "workspace_write")).toBe(
      "workspace_write",
    );
    expect(resolver.adapterAccess("implement", "workspace", "readonly")).toBe("readonly");
    expect(resolver.adapterAccess("implement", "git_patch_envelope", "workspace_write")).toBe(
      "readonly",
    );
  });
});

describe("RequestRequirementsResolver project-read admission (#133)", () => {
  const resolver = new RequestRequirementsResolver();
  const remote = (enabledIntents: Intent[], readFiles: boolean) => ({
    id: "openrouter",
    enabledIntents,
    manifest: { capabilities: { read_files: readFiles } },
  });
  const project = { repoRoot: "/work/project" };

  it("refuses a project Ask on a route that may answer but cannot read files", () => {
    expect(resolver.projectReadRefusal("explain", project, remote(["explain"], false))).toBe(
      "openrouter (cannot read project files: ask without a project or choose a harness that reads files)",
    );
  });

  it.each(["plan", "spec"] as const)("refuses a project %s the same way (#137)", (intent) => {
    expect(resolver.projectReadRefusal(intent, project, remote([intent], false))).toBe(
      "openrouter (cannot read project files: ask without a project or choose a harness that reads files)",
    );
  });

  it("admits work without a project, a file-reading route, and an intent that reads nothing", () => {
    const noProject = { repoRoot: noProjectRepoRoot() };
    for (const intent of ["explain", "plan", "spec"] as const) {
      expect(resolver.projectReadRefusal(intent, noProject, remote([intent], false))).toBeNull();
      expect(resolver.projectReadRefusal(intent, project, remote([intent], true))).toBeNull();
    }
    // A patch producer's packet carries what it reads; its implement is untouched.
    expect(
      resolver.projectReadRefusal("implement", project, remote(["implement"], false)),
    ).toBeNull();
  });

  it("leaves a route whose doctor does not enable explain to the capability refusal", () => {
    expect(resolver.projectReadRefusal("explain", project, remote(["plan"], false))).toBeNull();
  });
});

describe("RequestRequirementsResolver convergence rounds (#147)", () => {
  const resolver = new RequestRequirementsResolver();

  it("asks a patch-envelope producer for its candidate intent, every other harness for repair", () => {
    const raw = { implementationTransport: "git_patch_envelope" as const };
    const native = { implementationTransport: "workspace" as const };
    expect(resolver.convergenceIntent(raw, "implement")).toBe("implement");
    expect(resolver.convergenceIntent(native, "implement")).toBe("repair");
  });
});
