import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BETTERLEAKS_RELEASES } from "@claudexor/delivery";

const generator = resolve("scripts/generate-release-sbom.mjs");
const remoteGenerator = resolve("scripts/generate-remote-runtime-sbom.mjs");
const nodeVersion = readFileSync(resolve(".node-version"), "utf8").trim();
// The product version comes from the root SSOT — asserting a literal here
// broke on every release bump without guarding anything.
const rootVersion = (
  JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string }
).version;
const browserVersion = (
  JSON.parse(readFileSync(resolve("packages/core/package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  }
).dependencies["@playwright/mcp"];
const licenses = {
  "Apache-2.0": [{ name: "@playwright/mcp", versions: [browserVersion], license: "Apache-2.0" }],
  MIT: [
    { name: "example-prod-dependency", versions: ["1.2.3"], license: "MIT" },
    { name: "multi-version-dependency", versions: ["1.0.0", "2.0.0"], license: "MIT" },
  ],
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
      expect(dependencies).toHaveLength(4);
      expect(
        dependencies.every((relationship: any) => relationship.spdxElementId === product.SPDXID),
      ).toBe(true);

      const containedIds = new Set(
        document.relationships
          .filter((relationship: any) => relationship.relationshipType === "CONTAINS")
          .map((relationship: any) => relationship.relatedSpdxElement),
      );
      const runtimeNames = [
        "@playwright/mcp",
        "claudexor-conpty-helper",
        "claudexor-process-identity",
        "Node.js runtime",
        "Betterleaks publication scanner (darwin-arm64)",
        "Betterleaks publication scanner (darwin-x64)",
      ];
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
      for (const key of ["darwin-arm64", "darwin-x64"]) {
        expect(
          document.packages.find(
            (pkg: any) => pkg.name === `Betterleaks publication scanner (${key})`,
          ),
        ).toMatchObject({
          versionInfo: "1.9.0",
          licenseDeclared: "MIT",
          downloadLocation: `https://github.com/betterleaks/betterleaks/releases/download/v1.9.0/${BETTERLEAKS_RELEASES[key]!.asset}`,
          externalRefs: [
            expect.objectContaining({
              referenceLocator: "pkg:github/betterleaks/betterleaks@v1.9.0",
            }),
          ],
        });
      }
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

  it("fails closed when the app bundle lacks a bundled publication scanner", () => {
    const fixture = appFixture();
    try {
      rmSync(join(fixture.app, "Contents/Resources/native/betterleaks/darwin-x64/provenance.json"));
      expect(() => generate(fixture.app)).toThrow(
        /lacks the bundled darwin-x64 publication scanner/,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("emits byte-identical output when license groups arrive in a different order", () => {
    const fixture = appFixture();
    try {
      const reordered = {
        MIT: [
          { ...licenses.MIT[1], versions: [...licenses.MIT[1].versions].reverse() },
          licenses.MIT[0],
        ],
        "Apache-2.0": licenses["Apache-2.0"],
      };
      expect(generateRaw(fixture.app, reordered)).toBe(generateRaw(fixture.app, licenses));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe("remote runtime SPDX SBOM", () => {
  it("inventories every target, bundled Node runtime, and production npm dependency", () => {
    const fixture = mkdtempSync(join(tmpdir(), "claudexor-remote-sbom-"));
    const licensesPath = join(fixture, "licenses.json");
    writeFileSync(licensesPath, JSON.stringify(licenses));
    const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
    // The generator reads per-archive facts from the promoted (unsigned)
    // manifest, never from build-internal sidecar files — publish regenerates
    // the SBOM from exactly these promoted release assets.
    const assets = targets.map((target) => {
      const name = `claudexor-remote-runtime-${rootVersion}-${target}.tar.gz`;
      const contents = `archive:${target}`;
      writeFileSync(join(fixture, name), contents);
      return {
        archiveName: name,
        target,
        nodeVersion,
        sha256: createHash("sha256").update(contents).digest("hex"),
      };
    });
    writeFileSync(
      join(fixture, "remote-runtime-manifest.json"),
      JSON.stringify({ kind: "claudexor-remote-runtime", version: rootVersion, assets }),
    );
    try {
      const generated = execFileSync(
        process.execPath,
        [remoteGenerator, fixture, rootVersion, licensesPath],
        {
          cwd: resolve("."),
          encoding: "utf8",
          env: { ...process.env, GITHUB_SHA: "b".repeat(40) },
        },
      );
      const regenerated = execFileSync(
        process.execPath,
        [remoteGenerator, fixture, rootVersion, licensesPath],
        {
          cwd: resolve("."),
          encoding: "utf8",
          env: { ...process.env, GITHUB_SHA: "b".repeat(40) },
        },
      );
      // Publish byte-compares its regeneration against the candidate SBOM, so
      // two runs over the same promoted inputs must be byte-identical.
      expect(regenerated).toBe(generated);
      const document = JSON.parse(generated);
      expect(document.files).toHaveLength(4);
      expect(
        document.packages.filter((pkg: any) => pkg.name.startsWith("Claudexor remote runtime (")),
      ).toHaveLength(4);
      expect(
        document.packages.filter((pkg: any) => pkg.name.startsWith("Node.js runtime (")),
      ).toHaveLength(4);
      expect(
        document.packages.find((pkg: any) => pkg.name === "example-prod-dependency"),
      ).toMatchObject({ versionInfo: "1.2.3", licenseDeclared: "MIT" });
      const containedIds = new Set(
        document.relationships
          .filter((relationship: any) => relationship.relationshipType === "CONTAINS")
          .map((relationship: any) => relationship.relatedSpdxElement),
      );
      for (const dependencyName of ["@playwright/mcp", "example-prod-dependency"]) {
        const dependency = document.packages.find((pkg: any) => pkg.name === dependencyName);
        expect(containedIds.has(dependency.SPDXID), dependencyName).toBe(true);
      }
      // Each target archive carries exactly its own platform's pinned scanner.
      for (const target of targets) {
        const scanner = document.packages.find(
          (pkg: any) => pkg.name === `Betterleaks publication scanner (${target})`,
        );
        expect(scanner).toMatchObject({
          versionInfo: "1.9.0",
          licenseDeclared: "MIT",
          checksums: [
            { algorithm: "SHA256", checksumValue: BETTERLEAKS_RELEASES[target]!.binarySha256 },
          ],
        });
        expect(containedIds.has(scanner.SPDXID), target).toBe(true);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

function generate(app: string) {
  return JSON.parse(generateRaw(app, licenses));
}

function generateRaw(app: string, licenseInput: typeof licenses): string {
  return execFileSync(process.execPath, [generator, "--app-bundle", app], {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, GITHUB_SHA: "a".repeat(40) },
    input: JSON.stringify(licenseInput),
    stdio: ["pipe", "pipe", "pipe"],
  });
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
    "claudexor-conpty-helper": join(resources, "native", "claudexor-conpty-helper.exe"),
    "Node.js runtime": join(resources, "node"),
    "Betterleaks publication scanner (darwin-arm64)": join(
      resources,
      "native/betterleaks/darwin-arm64/betterleaks",
    ),
    "Betterleaks publication scanner (darwin-x64)": join(
      resources,
      "native/betterleaks/darwin-x64/betterleaks",
    ),
  };
  const contents = {
    "@playwright/mcp": "fixture:@playwright/mcp",
    "claudexor-process-identity": "fixture:claudexor-process-identity",
    "claudexor-conpty-helper": fakePe(),
    "Node.js runtime": `#!/bin/sh\nprintf 'v${nodeVersion}\\n'\n`,
    "Betterleaks publication scanner (darwin-arm64)": "fixture:signed-betterleaks-darwin-arm64",
    "Betterleaks publication scanner (darwin-x64)": "fixture:signed-betterleaks-darwin-x64",
  };
  for (const [name, path] of Object.entries(files)) {
    mkdirSync(dirname(path), { recursive: true });
    if (name === "Node.js runtime") continue;
    writeFileSync(path, contents[name as keyof typeof contents]);
  }
  // On recent macOS versions an ad-hoc executable created inside a `.app`
  // fixture can be killed by code-signing enforcement before `/bin/sh` runs.
  // Keep the executable fixture outside the bundle and expose it through the
  // exact packaged path; hashing and execution still follow the same bytes.
  const fixtureNode = join(root, "node-fixture");
  writeFileSync(fixtureNode, contents["Node.js runtime"]);
  chmodSync(fixtureNode, 0o755);
  symlinkSync(fixtureNode, files["Node.js runtime"]);
  for (const key of ["darwin-arm64", "darwin-x64"]) {
    const release = BETTERLEAKS_RELEASES[key]!;
    writeFileSync(
      join(resources, "native/betterleaks", key, "provenance.json"),
      JSON.stringify({
        name: "betterleaks",
        version: "1.9.0",
        platform: key,
        license: "MIT",
        source: `https://github.com/betterleaks/betterleaks/releases/download/v1.9.0/${release.asset}`,
        archiveSha256: release.archiveSha256,
        upstreamBinarySha256: release.binarySha256,
        bundledSha256: createHash("sha256")
          .update(contents[`Betterleaks publication scanner (${key})` as keyof typeof contents])
          .digest("hex"),
      }),
    );
  }
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

function fakePe(): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(0xf0, 0x94);
  bytes.writeUInt16LE(0x0002, 0x96);
  bytes.writeUInt16LE(0x020b, 0x98);
  return bytes;
}
