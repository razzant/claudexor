import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  moveNextChannel,
  npmFailureText,
  publishNpmPackage,
  type ReconcileIo,
  validatePublishedProvenance,
} from "../../../scripts/publish-npm-release.mjs";

const publisher = resolve(import.meta.dirname, "../../../scripts/publish-npm-release.mjs");

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
  it("rejects a branch ref before creating release output or invoking package tools", () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "claudexor-npm-ref-"));
    try {
      const result = spawnSync(process.execPath, [publisher, "--provenance"], {
        encoding: "utf8",
        env: {
          ...process.env,
          RUNNER_TEMP: runnerTemp,
          NODE_AUTH_TOKEN: "test-only-token",
          GITHUB_SHA: candidateSha,
          GITHUB_REPOSITORY: repository,
          GITHUB_REF: "refs/heads/main",
          PATH: "",
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("GITHUB_REF must be the exact release tag");
      expect(existsSync(join(runnerTemp, "claudexor-npm-release"))).toBe(false);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

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

  // v2.1.1 postmortem: builds are not byte-reproducible across CI runs, so
  // the already-published SKIP path anchors on npm's provenance instead of
  // local byte-identity — the SLSA subject must match the PUBLISHED tarball
  // digest and the workflow/tag/commit identity stays fully enforced.
  describe("allowSameSourceRebuild (retry skip path)", () => {
    function rebuildFixture() {
      const input = fixture();
      // A published tarball whose bytes differ from the local re-pack: the
      // registry integrity and the SLSA subject agree with EACH OTHER but
      // not with the local integrity/sha512Hex.
      const publishedSha512Hex = "e".repeat(128);
      input.metadata.dist.integrity = `sha512-${Buffer.from(publishedSha512Hex, "hex").toString("base64")}`;
      const next = statement(input);
      next.subject[0].digest.sha512 = publishedSha512Hex;
      replaceStatement(input, next);
      return { ...input, allowSameSourceRebuild: true };
    }

    it("accepts a same-source rebuild whose provenance matches the published bytes", () => {
      expect(validatePublishedProvenance(rebuildFixture())).toEqual({ ok: true, reasons: [] });
    });

    it("still rejects the same rebuild under the strict fresh-publish contract", () => {
      expect(
        validatePublishedProvenance({ ...rebuildFixture(), allowSameSourceRebuild: false }).ok,
      ).toBe(false);
    });

    it("rejects a published subject that does not match the published tarball", () => {
      const input = rebuildFixture();
      const next = statement(input);
      next.subject[0].digest.sha512 = "f".repeat(128);
      replaceStatement(input, next);
      expect(validatePublishedProvenance(input).ok).toBe(false);
    });

    it("rejects a rebuild from a different candidate commit", () => {
      const input = rebuildFixture();
      const next = statement(input);
      next.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "d".repeat(40);
      replaceStatement(input, next);
      expect(validatePublishedProvenance(input).ok).toBe(false);
    });

    it("rejects a rebuild published by a different workflow ref", () => {
      const input = rebuildFixture();
      const next = statement(input);
      next.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main";
      replaceStatement(input, next);
      expect(validatePublishedProvenance(input).ok).toBe(false);
    });
  });
});

describe("npm release publishing", () => {
  function registry(views: any[], publishes: any[] = [{ status: 0 }], fetches: any[] = [200]) {
    const { metadata: _metadata, attestationDocument, ...input } = fixture();
    let clock = 0;
    const take = (items: any[]) => (items.length > 1 ? items.shift() : items[0]);
    const calls: string[][] = [];
    const io: ReconcileIo = {
      spawn: (_command, args) => {
        calls.push(args);
        if (args[0] === "publish") return take(publishes);
        expect(args[0]).toBe("view");
        const answer = take(views);
        if (answer === 404) return { status: 1, stderr: "npm error code E404" };
        if (typeof answer === "string") return { status: 1, stderr: `npm error code ${answer}` };
        return { status: 0, stdout: JSON.stringify(answer) };
      },
      fetch: vi.fn(async (_url, options) => {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        const answer = take(fetches);
        if (answer instanceof Error) throw answer;
        return { status: answer, ok: answer === 200, json: async () => attestationDocument };
      }),
      now: () => clock,
      sleep: vi.fn(async (ms) => {
        clock += ms;
      }),
      log: vi.fn(),
      error: vi.fn(),
    };
    return { input, io, calls, publishes: () => calls.filter((args) => args[0] === "publish") };
  }
  const failed = (code: string) => ({ status: 1, stderr: `npm error code ${code}` });

  it("rechecks after DNS failure and retries the same packed file without repacking", async () => {
    const r = registry([404, 404, fixture().metadata], [failed("ENOTFOUND"), { status: 0 }]);
    await publishNpmPackage("/packed/core.tgz", r.input, r.io);
    expect(r.publishes()).toEqual(
      Array(2).fill(["publish", "/packed/core.tgz", "--access", "public", "--provenance"]),
    );
    expect(r.calls.map((args) => args[0])).toEqual(["view", "publish", "view", "publish", "view"]);
    expect(r.io.sleep).toHaveBeenCalledWith(15_000);
  });

  it("accepts a failed acknowledgement only after reading and validating the exposed original bytes", async () => {
    const r = registry([404, fixture().metadata], [failed("ECONNRESET")]);
    await publishNpmPackage("core.tgz", r.input, r.io);
    expect(r.publishes()).toHaveLength(1);
  });

  it("never repeats an acknowledged publish while its version listing lags", async () => {
    const r = registry([404, 404, 404, fixture().metadata]);
    await publishNpmPackage("core.tgz", r.input, r.io);
    expect(r.publishes()).toHaveLength(1);
    expect(r.io.sleep).toHaveBeenCalledTimes(2);
  });

  it("keeps a never-exposed acknowledged publish unresolved, without resending", async () => {
    const r = registry([404]);
    await expect(publishNpmPackage("core.tgz", r.input, r.io)).rejects.toThrow(
      "outcome unresolved",
    );
    expect(r.publishes()).toHaveLength(1);
    expect(r.io.now()).toBe(600_000);
    expect(r.io.log).toHaveBeenCalledExactlyOnceWith(
      `npm publish acknowledged: ${r.input.packageName}@${r.input.version}; verifying registry exposure and provenance`,
    );
  });

  it("bounds network-only publication attempts and does not turn absence into non-dispatch", async () => {
    const r = registry([404], [failed("ENOTFOUND")]);
    await expect(publishNpmPackage("core.tgz", r.input, r.io)).rejects.toThrow(
      "outcome unresolved",
    );
    expect(r.publishes()).toHaveLength(3);
    expect(r.io.sleep).toHaveBeenCalledTimes(2);
    expect(r.io.now()).toBe(60_000);
  });

  it("reconciles the final failed attempt without a fourth publish", async () => {
    const r = registry([404, 404, 404, fixture().metadata], [failed("ENOTFOUND")]);
    await publishNpmPackage("core.tgz", r.input, r.io);
    expect(r.publishes()).toHaveLength(3);
  });

  it.each(["E401", "E403", "EINTEGRITY", "ENOENT", "EUNKNOWN"])(
    "does not retry permanent or unknown %s",
    async (code) => {
      const r = registry([404], [failed(code)]);
      await expect(publishNpmPackage("core.tgz", r.input, r.io)).rejects.toThrow(code);
      expect(r.publishes()).toHaveLength(1);
      expect(r.io.sleep).not.toHaveBeenCalled();
    },
  );

  it("retries a transient view before deciding whether to publish", async () => {
    const r = registry(["EAI_AGAIN", 404, fixture().metadata]);
    await publishNpmPackage("core.tgz", r.input, r.io);
    expect(r.calls.map((args) => args[0])).toEqual(["view", "view", "publish", "view"]);
    expect(r.publishes()).toHaveLength(1);
  });

  it("retries network and exposure failures of attestations without another publish", async () => {
    const error = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
    const r = registry([404, fixture().metadata], undefined, [error, 503, 404, 200]);
    await publishNpmPackage("core.tgz", r.input, r.io);
    expect(r.io.fetch).toHaveBeenCalledTimes(4);
    expect(r.publishes()).toHaveLength(1);
  });

  it("keeps attestation failure bounded and permanent HTTP refusal immediate", async () => {
    for (const status of [404, 503, 403]) {
      const r = registry([404, fixture().metadata], undefined, [status]);
      await expect(publishNpmPackage("core.tgz", r.input, r.io)).rejects.toThrow(`HTTP ${status}`);
      expect(r.io.now()).toBe(status === 403 ? 0 : 600_000);
      expect(r.publishes()).toHaveLength(1);
    }
  });

  it("keeps slow registry reads inside the accepted publication's exposure window", async () => {
    const r = registry([404]);
    const spawn = r.io.spawn;
    r.io.spawn = (command, args, options) => {
      if (args[0] === "view") {
        expect(r.io.now()).toBeLessThan(660_000);
        void r.io.sleep(Number(options.timeout));
      }
      return spawn(command, args, options);
    };
    await expect(publishNpmPackage("core.tgz", r.input, r.io)).rejects.toThrow(
      "outcome unresolved",
    );
    expect(r.io.now()).toBe(660_000); // initial read 60s, then the accepted publish's 600s
    expect(r.publishes()).toHaveLength(1);
  });

  it("reconciles final-minute exposure with a fractional clock through the real spawn timeout boundary", async () => {
    const r = registry([404, 404, fixture().metadata]);
    const spawn = r.io.spawn;
    let clock = 0.25;
    const timeouts: number[] = [];
    r.io.now = () => clock;
    r.io.sleep = async () => {
      clock = 540_021;
    };
    r.io.spawn = (command, args, options) => {
      if (args[0] === "view") {
        const timeout = Number(options.timeout);
        timeouts.push(timeout);
        // No npm or network: exercise Node's actual timeout validation.
        const child = spawnSync(process.execPath, ["-e", ""], { timeout });
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
      }
      return spawn(command, args, options);
    };
    await publishNpmPackage("core.tgz", r.input, r.io);
    expect(timeouts).toEqual([60_000, 60_000, 59_980]);
    expect(r.publishes()).toHaveLength(1);
  });

  it("recovers an interrupted native fetch body and validates the next response without republishing", async () => {
    const r = registry([404, fixture().metadata]);
    let requests = 0;
    let interrupted: ServerResponse | undefined;
    let observedCode: unknown;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      if (requests === 1) {
        interrupted = response;
        response.write('{"attestations":');
      } else response.end(JSON.stringify(fixture().attestationDocument));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing local port");
      r.io.fetch = async (_url, options) => {
        const response = await fetch(`http://127.0.0.1:${address.port}`, options);
        return {
          ok: response.ok,
          status: response.status,
          json: async () => {
            const body = response.json();
            if (requests === 1) interrupted?.destroy();
            try {
              return await body;
            } catch (error) {
              observedCode = (error as Error & { cause?: { code?: string } }).cause?.code;
              throw error;
            }
          },
        };
      };
      await publishNpmPackage("core.tgz", r.input, r.io);
      expect(observedCode).toBe("UND_ERR_SOCKET");
      expect(requests).toBe(2);
      expect(r.publishes()).toHaveLength(1);
      expect(r.io.sleep).toHaveBeenCalledWith(10_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("retries an attestation body network failure, never the publication", async () => {
    const r = registry([404, fixture().metadata]);
    const fetch = r.io.fetch;
    let first = true;
    r.io.fetch = async (url, options) => {
      if (!first) return fetch(url, options);
      first = false;
      return {
        status: 200,
        ok: true,
        json: async () => {
          throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        },
      };
    };
    await publishNpmPackage("core.tgz", r.input, r.io);
    expect(r.publishes()).toHaveLength(1);
    expect(r.io.sleep).toHaveBeenCalledWith(10_000);
  });

  it("never treats a newly exposed mismatching publication as a same-source rebuild", async () => {
    const other = fixture().metadata;
    other.dist.integrity = `sha512-${Buffer.from(sha512Hex, "hex").toString("base64")}`;
    const r = registry([404, other], [failed("ECONNRESET")]);
    await expect(publishNpmPackage("core.tgz", r.input, r.io)).rejects.toThrow(
      "tarball integrity mismatch",
    );
    expect(r.publishes()).toHaveLength(1);
  });

  it("retains the verified pre-existing same-source rebuild path", async () => {
    const existing = fixture().metadata;
    existing.dist.integrity = `sha512-${Buffer.from(sha512Hex, "hex").toString("base64")}`;
    const r = registry([existing]);
    await publishNpmPackage("core.tgz", r.input, r.io);
    expect(r.publishes()).toHaveLength(0);
    expect(r.io.log).toHaveBeenCalledWith(
      `npm already published with verified provenance: ${packageName}@${version}`,
    );
  });

  it("needs no stored npm token: a run without NODE_AUTH_TOKEN reaches the release checks", () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "claudexor-npm-oidc-"));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        RUNNER_TEMP: runnerTemp,
        GITHUB_SHA: candidateSha,
        GITHUB_REPOSITORY: repository,
        GITHUB_REF: "refs/heads/main",
        PATH: "",
      };
      delete env.NODE_AUTH_TOKEN;
      const result = spawnSync(process.execPath, [publisher, "--provenance"], {
        encoding: "utf8",
        env,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain("NODE_AUTH_TOKEN");
      expect(result.stderr).toContain("GITHUB_REF must be the exact release tag");
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it("reports npm's error lines instead of the debug-log pointer", () => {
    const stderr = [
      "npm notice Publishing to https://registry.npmjs.org/ with tag latest",
      "npm error code E401",
      "npm error 401 Unauthorized - PUT https://registry.npmjs.org/@claudexor%2fcore",
      "npm error A complete log of this run can be found in: /tmp/_logs/debug-0.log",
    ].join("\n");
    expect(npmFailureText(stderr)).toBe(
      "npm error code E401\nnpm error 401 Unauthorized - PUT https://registry.npmjs.org/@claudexor%2fcore",
    );
    expect(npmFailureText("not an npm failure\nits last line")).toBe("its last line");
    expect(npmFailureText("")).toBe("unknown error");
  });

  it("moves next when the registry allows it and never stops the release when it refuses", () => {
    const packed = [
      { pkg: { name: "@claudexor/core", version } },
      { pkg: { name: "claudexor", version } },
    ];
    const calls: string[][] = [];
    const refuseCore = (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return args[2] === `@claudexor/core@${version}`
        ? {
            status: 1,
            stderr: "npm error code E401\nnpm error A complete log of this run can be found in: x",
          }
        : { status: 0, stderr: "" };
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(moveNextChannel(packed, refuseCore)).toEqual([
        `@claudexor/core@${version}: npm error code E401`,
      ]);
      expect(calls).toEqual([
        ["npm", "dist-tag", "add", `@claudexor/core@${version}`, "next"],
        ["npm", "dist-tag", "add", `claudexor@${version}`, "next"],
      ]);
      expect(log).toHaveBeenCalledWith(`npm next channel now resolves to claudexor@${version}`);
      expect(warn).toHaveBeenCalledTimes(1);

      warn.mockClear();
      expect(moveNextChannel(packed, () => ({ status: 0, stderr: "" }))).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
