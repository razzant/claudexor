import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const generator = resolve("scripts/generate-release-sbom.mjs");
const nodeVersion = readFileSync(resolve(".node-version"), "utf8").trim();
// The product version comes from the root SSOT — asserting a literal here
// broke on every release bump without guarding anything.
const rootVersion = (
  JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string }
).version;
const browserVersion = "0.0.78";
const licenses = {
  "Apache-2.0": [{ name: "@playwright/mcp", versions: [browserVersion], license: "Apache-2.0" }],
  MIT: [{ name: "example-prod-dependency", versions: ["1.2.3"], license: "MIT" }],
};

describe("release SPDX SBOM", () => {
  it("describes Claudexor and binds dependencies plus packaged runtimes", () => {
    const fixture = appFixture();
    try {
      const document = generate(fixture.app);
      const product = document.packages.find((pkg: any) => pkg.name === "Claudexor");
      expect(product).toMatchObject({ versionInfo: rootVersion, licenseDeclared: "MIT" });
      expect(
        document.relationships.filter(
          (relationship: any) => relationship.relationshipType === "DESCRIBES",
        ),
      ).toEqual([
        {
          spdxElementId: "SPDXRef-DOCUMENT",
          relationshipType: "DESCRIBES",
          relatedSpdxElement: product.SPDXID,
        },
      ]);

      const dependencies = document.relationships.filter(
        (relationship: any) => relationship.relationshipType === "DEPENDS_ON",
      );
      expect(dependencies).toHaveLength(2);
      expect(
        dependencies.every((relationship: any) => relationship.spdxElementId === product.SPDXID),
      ).toBe(true);

      const containedIds = new Set(
        document.relationships
          .filter((relationship: any) => relationship.relationshipType === "CONTAINS")
          .map((relationship: any) => relationship.relatedSpdxElement),
      );
      const runtimeNames = ["@playwright/mcp", "claudexor-process-identity", "Node.js runtime"];
      for (const name of runtimeNames) {
        const runtime = document.packages.find((pkg: any) => pkg.name === name);
        expect(runtime, name).toBeDefined();
        expect(containedIds.has(runtime.SPDXID), name).toBe(true);
        expect(runtime.checksums).toEqual([
          { algorithm: "SHA256", checksumValue: fixture.digests[name] },
        ]);
        expect(runtime.packageFileName).toMatch(/^Contents\/Resources\//);
      }
      expect(document.packages.find((pkg: any) => pkg.name === "Node.js runtime").versionInfo).toBe(
        nodeVersion,
      );
      expect(document.packages.find((pkg: any) => pkg.name === "@playwright/mcp").versionInfo).toBe(
        browserVersion,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when the packaged Browser MCP version differs from its pin", () => {
    const fixture = appFixture("0.0.77");
    try {
      expect(() => generate(fixture.app)).toThrow(/packaged Browser MCP does not match/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

function generate(app: string) {
  return JSON.parse(
    execFileSync(process.execPath, [generator, "--app-bundle", app], {
      cwd: resolve("."),
      encoding: "utf8",
      env: { ...process.env, GITHUB_SHA: "a".repeat(40) },
      input: JSON.stringify(licenses),
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
}

function appFixture(packagedBrowserVersion = browserVersion) {
  const root = mkdtempSync(join(tmpdir(), "claudexor-sbom-"));
  const app = join(root, "Claudexor.app");
  const resources = join(app, "Contents", "Resources");
  const files = {
    "@playwright/mcp": join(
      resources,
      "browser-mcp-runtime",
      "node_modules",
      "@playwright",
      "mcp",
      "cli.js",
    ),
    "claudexor-process-identity": join(resources, "native", "claudexor-process-identity"),
    "Node.js runtime": join(resources, "node"),
  };
  const contents = {
    "@playwright/mcp": "fixture:@playwright/mcp",
    "claudexor-process-identity": "fixture:claudexor-process-identity",
    "Node.js runtime": `#!/bin/sh\nprintf 'v${nodeVersion}\\n'\n`,
  };
  for (const [name, path] of Object.entries(files)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents[name as keyof typeof contents]);
  }
  chmodSync(files["Node.js runtime"], 0o755);
  writeFileSync(
    join(dirname(files["@playwright/mcp"]), "package.json"),
    JSON.stringify({ name: "@playwright/mcp", version: packagedBrowserVersion }),
  );
  return {
    root,
    app,
    digests: Object.fromEntries(
      Object.entries(files).map(([name, path]) => [
        name,
        createHash("sha256")
          .update(contents[name as keyof typeof contents])
          .digest("hex"),
      ]),
    ),
  };
}
