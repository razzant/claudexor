import { describe, expect, it } from "vitest";
import { validatePublishedProvenance } from "../../../scripts/publish-npm-release.mjs";

const SLSA = "https://slsa.dev/provenance/v1";
const packageName = "@claudexor/core";
const version = "2.0.0";
const candidateSha = "a".repeat(40);
const sha512Hex = "b".repeat(128);
const integrity = `sha512-${Buffer.from("tarball").toString("base64")}`;
const repository = "razzant/claudexor";
const workflowPath = ".github/workflows/release.yml";
const ref = "refs/tags/v2.0.0";

function fixture() {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: "pkg:npm/%40claudexor/core@2.0.0",
        digest: { sha512: sha512Hex },
      },
    ],
    predicateType: SLSA,
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: "https://github.com/razzant/claudexor",
            path: workflowPath,
            ref,
          },
        },
        resolvedDependencies: [
          {
            uri: "git+https://github.com/razzant/claudexor@refs/tags/v2.0.0",
            digest: { gitCommit: candidateSha },
          },
        ],
      },
    },
  };
  return {
    metadata: {
      "dist-tags": { latest: version },
      dist: {
        integrity,
        attestations: {
          url: "https://registry.npmjs.org/-/npm/v1/attestations/%40claudexor%2fcore@2.0.0",
          provenance: { predicateType: SLSA },
        },
      },
    },
    attestationDocument: {
      attestations: [
        {
          predicateType: SLSA,
          bundle: {
            dsseEnvelope: {
              payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
            },
          },
        },
      ],
    },
    packageName,
    version,
    integrity,
    sha512Hex,
    candidateSha,
    repository,
    workflowPath,
    ref,
  };
}

function statement(input: ReturnType<typeof fixture>): any {
  const payload = input.attestationDocument.attestations[0].bundle.dsseEnvelope.payload;
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

function replaceStatement(input: ReturnType<typeof fixture>, next: unknown): void {
  input.attestationDocument.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(
    JSON.stringify(next),
  ).toString("base64");
}

describe("npm release provenance", () => {
  it("binds the published tarball to latest, repository, workflow, tag and candidate SHA", () => {
    expect(validatePublishedProvenance(fixture())).toEqual({ ok: true, reasons: [] });
  });

  it.each([
    [
      "registry integrity",
      (input: ReturnType<typeof fixture>) => {
        input.metadata.dist.integrity = "sha512-wrong";
      },
    ],
    [
      "metadata predicate",
      (input: ReturnType<typeof fixture>) => {
        input.metadata.dist.attestations.provenance.predicateType = "wrong";
      },
    ],
    [
      "SLSA attestation",
      (input: ReturnType<typeof fixture>) => {
        input.attestationDocument.attestations = [];
      },
    ],
    [
      "subject PURL",
      (input: ReturnType<typeof fixture>) => {
        const next = statement(input);
        next.subject[0].name = "pkg:npm/other@2.0.0";
        replaceStatement(input, next);
      },
    ],
    [
      "tarball digest",
      (input: ReturnType<typeof fixture>) => {
        const next = statement(input);
        next.subject[0].digest.sha512 = "c".repeat(128);
        replaceStatement(input, next);
      },
    ],
    [
      "repository",
      (input: ReturnType<typeof fixture>) => {
        const next = statement(input);
        next.predicate.buildDefinition.externalParameters.workflow.repository =
          "https://github.com/example/other";
        replaceStatement(input, next);
      },
    ],
    [
      "workflow path",
      (input: ReturnType<typeof fixture>) => {
        const next = statement(input);
        next.predicate.buildDefinition.externalParameters.workflow.path =
          ".github/workflows/other.yml";
        replaceStatement(input, next);
      },
    ],
    [
      "workflow ref",
      (input: ReturnType<typeof fixture>) => {
        const next = statement(input);
        next.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main";
        replaceStatement(input, next);
      },
    ],
    [
      "candidate commit",
      (input: ReturnType<typeof fixture>) => {
        const next = statement(input);
        next.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "d".repeat(40);
        replaceStatement(input, next);
      },
    ],
    [
      "latest dist-tag",
      (input: ReturnType<typeof fixture>) => {
        input.metadata["dist-tags"].latest = "1.0.1";
      },
    ],
  ])("rejects mismatched %s", (_label, mutate) => {
    const input = fixture();
    mutate(input);
    expect(validatePublishedProvenance(input).ok).toBe(false);
  });
});
