import { describe, expect, it } from "vitest";
import { sensitiveResourcePolicy } from "./sensitive-resource.js";

describe("SensitiveResourcePolicy hostile corpus", () => {
  it.each([
    [".env", "environment_file"],
    ["config/.env.production", "environment_file"],
    [".envrc", "environment_file"],
    ["certs/signing.key", "private_key"],
    ["certs/client.p12", "private_key"],
    ["config/credentials.json", "credential_file"],
    ["secrets/service.json", "secret_container"],
    ["home/.aws/config", "credential_store"],
    ["home/.config/gcloud/application_default_credentials.json", "credential_store"],
    ["home/.ssh/id_ed25519", "credential_store"],
    ["repo/id_rsa", "private_key"],
    [".claudexor/auth/native.json", "credential_store"],
  ] as const)("classifies %s as %s", (path, expectedClass) => {
    expect(sensitiveResourcePolicy.classifyPath(path)).toMatchObject({
      sensitive: true,
      class: expectedClass,
    });
  });

  it.each([
    ".env.example",
    ".env.sample",
    ".env.template",
    "docs/environment.md",
    "keys/id_ed25519.pub",
    "src/gcloud/client.ts",
    "packages/secrets/src/index.ts",
  ])("does not confuse a safe template/public path with a secret: %s", (path) => {
    expect(sensitiveResourcePolicy.classifyPath(path).sensitive).toBe(false);
  });

  it("owns content signatures and exposes typed redact/reject decisions", () => {
    const jwt = `eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
    const redact = sensitiveResourcePolicy.inspectContent(`before ${jwt} after`, "redact");
    expect(redact).toMatchObject({
      action: "redact",
      containsSensitiveContent: true,
      signatures: ["jwt"],
      text: "before [redacted] after",
    });

    const reject = sensitiveResourcePolicy.inspectContent(jwt, "reject");
    expect(reject.action).toBe("reject");
    expect(reject.text).toBe("[redacted]");
    expect(sensitiveResourcePolicy.inspectContent("ordinary prose", "reject")).toEqual({
      action: "allow",
      containsSensitiveContent: false,
      signatures: [],
      text: "ordinary prose",
    });
  });

  it("allows only contained, relocatable, non-sensitive symlink targets", () => {
    const base = {
      sourceRoot: "/workspace",
      canonicalSourceRoot: "/workspace",
      sourcePath: "/workspace/link.txt",
      linkTarget: "safe.txt",
      resolvedTargetPath: "/workspace/safe.txt",
      targetKind: "file" as const,
      allowedTargetKinds: ["file"] as const,
      relocationRoot: "/relocated",
    };
    expect(sensitiveResourcePolicy.assessSymlink(base).allowed).toBe(true);
    expect(
      sensitiveResourcePolicy.assessSymlink({
        ...base,
        linkTarget: "../outside.txt",
        resolvedTargetPath: "/outside.txt",
      }),
    ).toMatchObject({ allowed: false, reason: "target_outside_root" });
    expect(
      sensitiveResourcePolicy.assessSymlink({
        ...base,
        linkTarget: ".env",
        resolvedTargetPath: "/workspace/.env",
      }),
    ).toMatchObject({ allowed: false, reason: "sensitive_target" });
    expect(
      sensitiveResourcePolicy.assessSymlink({
        ...base,
        sourcePath: "/workspace/nested/link.txt",
        linkTarget: "../../workspace/safe.txt",
        resolvedTargetPath: "/workspace/safe.txt",
      }),
    ).toMatchObject({ allowed: false, reason: "relocation_escape" });
  });
});
