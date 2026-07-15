#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const appBundle = readRequiredArgument("--app-bundle");
let input = "";
for await (const chunk of process.stdin) input += chunk;

const licenses = JSON.parse(input);
const root = readJson("package.json");
const core = readJson("packages/core/package.json");
const nodeVersion = readFileSync(".node-version", "utf8").trim();
const resources = join(appBundle, "Contents", "Resources");
const browserPackagePath = join(
  resources,
  "browser-mcp-runtime",
  "node_modules",
  "@playwright",
  "mcp",
  "package.json",
);
const browserPackage = readJson(browserPackagePath);
const expectedBrowserVersion = core.dependencies?.["@playwright/mcp"];
const bundledNodePath = join(resources, "node");

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedBrowserVersion ?? "")) {
  fail("packages/core must pin @playwright/mcp to an exact version");
}
if (
  browserPackage.name !== "@playwright/mcp" ||
  browserPackage.version !== expectedBrowserVersion
) {
  fail("packaged Browser MCP does not match packages/core/package.json");
}
const bundledNodeVersion = execFileSync(bundledNodePath, ["--version"], {
  encoding: "utf8",
}).trim();
if (bundledNodeVersion !== `v${nodeVersion}`) {
  fail(`packaged Node ${bundledNodeVersion} does not match .node-version v${nodeVersion}`);
}

const dependencies = licensedPackages(licenses);
const browserDependency = dependencies.find(
  (pkg) => pkg.name === "@playwright/mcp" && pkg.versionInfo === expectedBrowserVersion,
);
if (!browserDependency) fail("licensed production dependency list omits packaged Browser MCP");

Object.assign(
  browserDependency,
  packagedFile(
    appBundle,
    join(resources, "browser-mcp-runtime", "node_modules", "@playwright", "mcp", "cli.js"),
  ),
);
browserDependency.primaryPackagePurpose = "APPLICATION";
browserDependency.comment = "Pinned Browser MCP CLI packaged for offline browser requests.";

const product = {
  SPDXID: spdxId("Claudexor", root.version),
  name: "Claudexor",
  versionInfo: root.version,
  downloadLocation: "NOASSERTION",
  filesAnalyzed: false,
  licenseConcluded: root.license ?? "NOASSERTION",
  licenseDeclared: root.license ?? "NOASSERTION",
  copyrightText: "NOASSERTION",
  primaryPackagePurpose: "APPLICATION",
  externalRefs: [
    {
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: `pkg:github/razzant/claudexor@${encodeURIComponent(root.version)}`,
    },
  ],
};
const processIdentity = {
  SPDXID: spdxId("claudexor-process-identity", root.version),
  name: "claudexor-process-identity",
  versionInfo: root.version,
  downloadLocation: "NOASSERTION",
  filesAnalyzed: false,
  licenseConcluded: root.license ?? "NOASSERTION",
  licenseDeclared: root.license ?? "NOASSERTION",
  copyrightText: "NOASSERTION",
  primaryPackagePurpose: "APPLICATION",
  ...packagedFile(appBundle, join(resources, "native", "claudexor-process-identity")),
  comment: "Universal arm64+x86_64 Darwin process-identity helper bundled with Claudexor.",
};
const nodeRuntime = {
  SPDXID: spdxId("Node.js-runtime", nodeVersion),
  name: "Node.js runtime",
  versionInfo: nodeVersion,
  downloadLocation: `https://nodejs.org/dist/v${nodeVersion}/`,
  filesAnalyzed: false,
  licenseConcluded: "MIT",
  licenseDeclared: "MIT",
  copyrightText: "NOASSERTION",
  primaryPackagePurpose: "APPLICATION",
  ...packagedFile(appBundle, bundledNodePath),
  externalRefs: [
    {
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: `pkg:generic/node@${encodeURIComponent(nodeVersion)}?os=darwin`,
    },
  ],
  comment: "Node executable bundled to run the Claudexor daemon and setup helper offline.",
};

const runtimeComponents = [browserDependency, processIdentity, nodeRuntime];
const packages = [product, ...dependencies, processIdentity, nodeRuntime];
packages.sort((a, b) => a.name.localeCompare(b.name) || a.versionInfo.localeCompare(b.versionInfo));

const sha = process.env.GITHUB_SHA ?? "local";
const created = execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], {
  encoding: "utf8",
}).trim();
const relationships = [
  {
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: product.SPDXID,
  },
  ...dependencies.map((dependency) => ({
    spdxElementId: product.SPDXID,
    relationshipType: "DEPENDS_ON",
    relatedSpdxElement: dependency.SPDXID,
  })),
  ...runtimeComponents.map((component) => ({
    spdxElementId: product.SPDXID,
    relationshipType: "CONTAINS",
    relatedSpdxElement: component.SPDXID,
  })),
];
const document = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `Claudexor-${root.version}`,
  documentNamespace: `https://github.com/razzant/claudexor/sbom/${sha}`,
  creationInfo: {
    created,
    creators: ["Tool: scripts/generate-release-sbom.mjs"],
  },
  packages,
  relationships,
};
process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);

function licensedPackages(groups) {
  const packagesById = new Map();
  for (const [license, entries] of Object.entries(groups)) {
    for (const entry of entries) {
      for (const version of entry.versions ?? []) {
        const pkg = {
          SPDXID: spdxId(entry.name, version),
          name: entry.name,
          versionInfo: version,
          downloadLocation: "NOASSERTION",
          filesAnalyzed: false,
          licenseConcluded: "NOASSERTION",
          licenseDeclared: entry.license || license || "NOASSERTION",
          copyrightText: "NOASSERTION",
          externalRefs: [
            {
              referenceCategory: "PACKAGE-MANAGER",
              referenceType: "purl",
              referenceLocator: `pkg:npm/${encodeURIComponent(entry.name)}@${encodeURIComponent(version)}`,
            },
          ],
        };
        packagesById.set(pkg.SPDXID, pkg);
      }
    }
  }
  return [...packagesById.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.versionInfo.localeCompare(b.versionInfo),
  );
}

function packagedFile(app, file) {
  return {
    packageFileName: relative(app, file),
    checksums: [
      {
        algorithm: "SHA256",
        checksumValue: createHash("sha256").update(readFileSync(file)).digest("hex"),
      },
    ],
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readRequiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) fail(`missing required ${name}`);
  return value;
}

function spdxId(name, version) {
  return `SPDXRef-Package-${name}-${version}`.replace(/[^A-Za-z0-9.-]/g, "-");
}

function fail(message) {
  throw new Error(`release SBOM: ${message}`);
}
