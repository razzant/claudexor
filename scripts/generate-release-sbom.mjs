#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const licenses = JSON.parse(input);
const root = JSON.parse(readFileSync("package.json", "utf8"));
const packages = [];
for (const [license, entries] of Object.entries(licenses)) {
  for (const entry of entries) {
    for (const version of entry.versions ?? []) {
      packages.push({
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
      });
    }
  }
}
packages.sort((a, b) => a.name.localeCompare(b.name) || a.versionInfo.localeCompare(b.versionInfo));
const sha = process.env.GITHUB_SHA ?? "local";
const created = execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], {
  encoding: "utf8",
}).trim();
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
  relationships: packages.map((pkg) => ({
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: pkg.SPDXID,
  })),
};
process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);

function spdxId(name, version) {
  return `SPDXRef-Package-${name}-${version}`.replace(/[^A-Za-z0-9.-]/g, "-");
}
