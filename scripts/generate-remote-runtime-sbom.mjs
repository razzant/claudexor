#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BETTERLEAKS_RELEASE_URL,
  BETTERLEAKS_RELEASES,
  BETTERLEAKS_VERSION,
} from "../packages/delivery/src/publication-scanner-pin.ts";

const directory = resolve(process.argv[2] ?? "");
const version = process.argv[3] ?? "";
const licensesPath = process.argv[4];
if (!directory || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(
    "usage: generate-remote-runtime-sbom.mjs ASSET_DIR VERSION [PRODUCTION_LICENSES_JSON]",
  );
}

const licenses = licensesPath
  ? readJson(resolve(licensesPath))
  : JSON.parse(
      execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
        cwd: resolve("."),
        encoding: "utf8",
      }),
    );
const dependencies = licensedPackages(licenses);
// Per-archive facts come from the (unsigned) remote runtime manifest, the one
// metadata artifact that travels with the archives through candidate promotion.
// The per-target sidecar .json files are build-internal inputs to
// build-remote-runtime-manifest.mjs and never become release assets, so the
// publish run can regenerate this SBOM byte-identically without them.
const manifest = readJson(join(directory, "remote-runtime-manifest.json"));
if (manifest.kind !== "claudexor-remote-runtime" || manifest.version !== version) {
  throw new Error("remote runtime SBOM manifest kind or version does not match");
}
const manifestAssets = new Map(
  (Array.isArray(manifest.assets) ? manifest.assets : []).map((asset) => [
    asset?.archiveName,
    asset,
  ]),
);
const archives = readdirSync(directory)
  .filter((name) => name.endsWith(".tar.gz"))
  .sort()
  .map((name, index) => {
    const metadata = manifestAssets.get(name);
    const digest = sha256(join(directory, name));
    if (
      !metadata ||
      typeof metadata.target !== "string" ||
      typeof metadata.nodeVersion !== "string" ||
      metadata.sha256 !== digest
    ) {
      throw new Error(`remote runtime SBOM manifest metadata does not match ${name}`);
    }
    return {
      name,
      index,
      target: metadata.target,
      nodeVersion: metadata.nodeVersion,
      digest,
    };
  });
if (manifestAssets.size !== archives.length) {
  throw new Error("remote runtime SBOM requires one archive per manifest asset");
}
if (archives.length !== 4) throw new Error("remote runtime SBOM requires exactly four archives");
if (new Set(archives.map((archive) => archive.target)).size !== archives.length) {
  throw new Error("remote runtime SBOM requires four distinct runtime targets");
}

const product = {
  SPDXID: spdxId("Claudexor-remote-runtime", version),
  name: "Claudexor remote runtime distribution",
  versionInfo: version,
  downloadLocation: "NOASSERTION",
  filesAnalyzed: false,
  licenseConcluded: "MIT",
  licenseDeclared: "MIT",
  copyrightText: "NOASSERTION",
  primaryPackagePurpose: "APPLICATION",
  externalRefs: [
    {
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: `pkg:github/razzant/claudexor@${encodeURIComponent(version)}`,
    },
  ],
};
const targetPackages = archives.map((archive) => ({
  SPDXID: spdxId(`Claudexor-remote-runtime-${archive.target}`, version),
  name: `Claudexor remote runtime (${archive.target})`,
  versionInfo: version,
  downloadLocation: "NOASSERTION",
  filesAnalyzed: false,
  licenseConcluded: "MIT",
  licenseDeclared: "MIT",
  copyrightText: "NOASSERTION",
  primaryPackagePurpose: "APPLICATION",
  packageFileName: archive.name,
  checksums: [{ algorithm: "SHA256", checksumValue: archive.digest }],
  externalRefs: [
    {
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: `pkg:generic/claudexor-remote-runtime@${encodeURIComponent(version)}?target=${encodeURIComponent(archive.target)}`,
    },
  ],
}));
const nodePackages = archives.map((archive) => {
  const [os, architecture] = archive.target.split("-");
  return {
    SPDXID: spdxId(`Node.js-runtime-${archive.target}`, archive.nodeVersion),
    name: `Node.js runtime (${archive.target})`,
    versionInfo: archive.nodeVersion,
    downloadLocation: `https://nodejs.org/dist/v${archive.nodeVersion}/`,
    filesAnalyzed: false,
    licenseConcluded: "MIT",
    licenseDeclared: "MIT",
    copyrightText: "NOASSERTION",
    primaryPackagePurpose: "APPLICATION",
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: `pkg:generic/node@${encodeURIComponent(archive.nodeVersion)}?os=${encodeURIComponent(os ?? "")}&arch=${encodeURIComponent(architecture ?? "")}`,
      },
    ],
    comment: `Digest-pinned Node distribution packaged inside ${archive.name}.`,
  };
});

const scannerPackages = archives.map((archive) => {
  const release = BETTERLEAKS_RELEASES[archive.target];
  if (!release) throw new Error(`no pinned publication scanner for ${archive.target}`);
  return {
    SPDXID: spdxId(`betterleaks-${archive.target}`, BETTERLEAKS_VERSION),
    name: `Betterleaks publication scanner (${archive.target})`,
    versionInfo: BETTERLEAKS_VERSION,
    downloadLocation: `${BETTERLEAKS_RELEASE_URL}/${release.asset}`,
    filesAnalyzed: false,
    licenseConcluded: "MIT",
    licenseDeclared: "MIT",
    copyrightText: "NOASSERTION",
    primaryPackagePurpose: "APPLICATION",
    checksums: [{ algorithm: "SHA256", checksumValue: release.binarySha256 }],
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: `pkg:github/betterleaks/betterleaks@v${encodeURIComponent(BETTERLEAKS_VERSION)}`,
      },
    ],
    comment: `Digest-pinned publication scanner packaged inside ${archive.name} (archive ${release.archiveSha256}).`,
  };
});

const files = archives.map((archive) => ({
  SPDXID: `SPDXRef-RemoteRuntimeArchive-${archive.index + 1}`,
  fileName: archive.name,
  checksums: [{ algorithm: "SHA256", checksumValue: archive.digest }],
}));
const relationships = [
  {
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: product.SPDXID,
  },
  ...targetPackages.map((targetPackage) => ({
    spdxElementId: product.SPDXID,
    relationshipType: "CONTAINS",
    relatedSpdxElement: targetPackage.SPDXID,
  })),
  ...targetPackages.flatMap((targetPackage, index) => [
    {
      spdxElementId: targetPackage.SPDXID,
      relationshipType: "CONTAINS",
      relatedSpdxElement: `SPDXRef-RemoteRuntimeArchive-${index + 1}`,
    },
    {
      spdxElementId: targetPackage.SPDXID,
      relationshipType: "CONTAINS",
      relatedSpdxElement: nodePackages[index].SPDXID,
    },
    {
      spdxElementId: targetPackage.SPDXID,
      relationshipType: "CONTAINS",
      relatedSpdxElement: scannerPackages[index].SPDXID,
    },
    ...dependencies.map((dependency) => ({
      spdxElementId: targetPackage.SPDXID,
      relationshipType: "CONTAINS",
      relatedSpdxElement: dependency.SPDXID,
    })),
  ]),
];
const packages = [
  product,
  ...targetPackages,
  ...nodePackages,
  ...scannerPackages,
  ...dependencies,
].sort(
  (left, right) =>
    left.name.localeCompare(right.name) || left.versionInfo.localeCompare(right.versionInfo),
);
const created = execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], {
  encoding: "utf8",
}).trim();
const sha = process.env.GITHUB_SHA ?? "local";

process.stdout.write(
  `${JSON.stringify(
    {
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      SPDXID: "SPDXRef-DOCUMENT",
      name: `Claudexor remote runtimes ${version}`,
      documentNamespace: `https://github.com/razzant/claudexor/sbom/remote-runtime/${sha}`,
      creationInfo: {
        created,
        creators: ["Tool: scripts/generate-remote-runtime-sbom.mjs"],
      },
      packages,
      files,
      relationships,
    },
    null,
    2,
  )}\n`,
);

function licensedPackages(groups) {
  const packagesById = new Map();
  for (const [license, entries] of Object.entries(groups)) {
    for (const entry of entries) {
      for (const dependencyVersion of entry.versions ?? []) {
        const pkg = {
          SPDXID: spdxId(entry.name, dependencyVersion),
          name: entry.name,
          versionInfo: dependencyVersion,
          downloadLocation: "NOASSERTION",
          filesAnalyzed: false,
          licenseConcluded: "NOASSERTION",
          licenseDeclared: entry.license || license || "NOASSERTION",
          copyrightText: "NOASSERTION",
          externalRefs: [
            {
              referenceCategory: "PACKAGE-MANAGER",
              referenceType: "purl",
              referenceLocator: `pkg:npm/${encodeURIComponent(entry.name)}@${encodeURIComponent(dependencyVersion)}`,
            },
          ],
        };
        packagesById.set(pkg.SPDXID, pkg);
      }
    }
  }
  return [...packagesById.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.versionInfo.localeCompare(right.versionInfo),
  );
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function spdxId(name, componentVersion) {
  return `SPDXRef-Package-${name}-${componentVersion}`.replace(/[^A-Za-z0-9.-]/g, "-");
}
