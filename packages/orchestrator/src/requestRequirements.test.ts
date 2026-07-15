import { describe, expect, it } from "vitest";
import { RequestRequirementsError, RequestRequirementsResolver } from "./requestRequirements.js";

describe("RequestRequirementsResolver browser preflight", () => {
  const resolver = new RequestRequirementsResolver();

  it("keeps mixed lanes truthful without dropping the incapable lane", () => {
    const capable = resolver.resolveBrowser({
      harnessId: "codex",
      requested: true,
      manifestCapable: true,
      webPolicy: "auto",
      access: "full",
    });
    const incapable = resolver.resolveBrowser({
      harnessId: "cursor",
      requested: true,
      manifestCapable: false,
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
    ["manifest_unsupported", false, "auto", "full"],
    ["web_policy_off", true, "off", "full"],
    ["access_profile_incompatible", true, "auto", "workspace_write"],
  ] as const)(
    "refuses a zero-effective pool with typed reason %s",
    (reason, capable, web, access) => {
      const resolution = resolver.resolveBrowser({
        harnessId: "lane",
        requested: true,
        manifestCapable: capable,
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
      webPolicy: "auto",
      access: "full",
    });
    expect(resolver.browserSpec(effective, "/tmp/run-root/browser")).toEqual({
      output_dir: "/tmp/run-root/browser",
      headless: false,
    });
    expect(resolver.browserSpec({ ...effective, effective: false }, "/tmp/browser")).toBeNull();
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
    expect(resolver.attachmentRefusal("raw", [attachment], [])).toContain(
      "text/plain is unsupported",
    );
    expect(
      resolver.attachmentRefusal(
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
      ),
    ).toBeNull();
  });
});
