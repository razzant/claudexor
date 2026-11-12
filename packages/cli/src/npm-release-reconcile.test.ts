import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  reconcileNpmPublications,
  type ReconcileIo,
} from "../../../scripts/publish-npm-release.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const publisher = join(repoRoot, "scripts/publish-npm-release.mjs");
const SLSA = "https://slsa.dev/provenance/v1";
const NPM_REGISTRY = "https://registry.npmjs.org/";
/** Every reconcile npm command ends with these: the default registry and the release scope. */
const REGISTRY_PINS = ["--registry", NPM_REGISTRY, `--@claudexor:registry=${NPM_REGISTRY}`];
const version = "4.4.0";
const ref = `refs/tags/v${version}`;
const candidateSha = "a".repeat(40);
const repositoryUrl = "https://github.com/razzant/claudexor";
const workflowPath = ".github/workflows/release.yml";
const WINDOW_MS = 10 * 60_000;

/** One npm-side publication of `name@4.4.0`, internally consistent the way npm serves it. */
function publication(
  name: string,
  tarball = `${name} tarball`,
): {
  integrity: string;
  url: string;
  statement: any;
  metadata: any;
} {
  const digest = createHash("sha512").update(tarball).digest();
  const integrity = `sha512-${digest.toString("base64")}`;
  const url = `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(name)}@${version}`;
  return {
    integrity,
    url,
    statement: {
      _type: "https://in-toto.io/Statement/v1",
      subject: [
        {
          name: `pkg:npm/${name.replace(/^@/, "%40")}@${version}`,
          digest: { sha512: digest.toString("hex") },
        },
      ],
      predicateType: SLSA,
      predicate: {
        buildDefinition: {
          externalParameters: { workflow: { repository: repositoryUrl, path: workflowPath, ref } },
          resolvedDependencies: [
            { uri: `git+${repositoryUrl}@${ref}`, digest: { gitCommit: candidateSha } },
          ],
        },
      },
    },
    metadata: {
      name,
      version,
      "dist-tags": { latest: version },
      dist: { integrity, attestations: { url, provenance: { predicateType: SLSA } } },
    },
  };
}

function attestationDocument(statement: unknown) {
  const payload = Buffer.from(JSON.stringify(statement)).toString("base64");
  return { attestations: [{ predicateType: SLSA, bundle: { dsseEnvelope: { payload } } }] };
}

/** Successive answers per `npm view` spec and per attestation URL; the last one repeats. */
interface Scenario {
  /** Successive answers, or an answer chosen by the virtual time the view starts at. */
  views: Record<string, unknown[] | ((startedAt: number) => unknown)>;
  attestations: Record<string, unknown[]>;
  install?: number;
  /** How long each `npm view` process takes (1 s unless set). */
  viewMs?: number;
}

function has<K extends string>(value: unknown, key: K): value is Record<K, string> {
  return typeof value === "object" && value !== null && key in value;
}

/** Fake process, network, clock and output edges. A process takes 1 s, a request 0.5 s. */
function fakeRegistry(scenario: Scenario) {
  let clock = 0;
  const calls: Array<{
    command: string;
    args: string[];
    options: Record<string, unknown>;
    at: number;
    manifest?: any;
  }> = [];
  const fetches: Array<{
    url: string;
    init: { signal: AbortSignal; method?: string };
    at: number;
  }> = [];
  const sleeps: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const served = new Map<string, number>();
  const answer = (key: string, answers: unknown[] | undefined, fallback: unknown) => {
    const list = answers ?? [fallback];
    const index = served.get(key) ?? 0;
    served.set(key, index + 1);
    return list[Math.min(index, list.length - 1)];
  };
  const io: ReconcileIo = {
    spawn(command, args, options) {
      const call: (typeof calls)[number] = { command, args, options, at: clock };
      calls.push(call);
      clock += args[0] === "view" ? (scenario.viewMs ?? 1_000) : 1_000;
      if (args[0] === "view") {
        const source = scenario.views[args[1]];
        const view =
          typeof source === "function" ? source(call.at) : answer(args[1], source, "missing");
        if (view === "missing") {
          return {
            status: 1,
            stdout: "",
            stderr: "npm error code E404\nnpm error 404 Not Found\n",
          };
        }
        if (has(view, "npmError")) return { status: 1, stdout: "", stderr: view.npmError };
        if (has(view, "spawnError")) {
          const error = Object.assign(new Error(`spawnSync npm ${view.spawnError}`), {
            code: view.spawnError,
          });
          return { status: null, error };
        }
        if (has(view, "stdout")) return { status: 0, stdout: view.stdout, stderr: "" };
        return { status: 0, stdout: JSON.stringify(view), stderr: "" };
      }
      if (args[0] === "install") {
        call.manifest = JSON.parse(readFileSync(join(String(options.cwd), "package.json"), "utf8"));
        const status = scenario.install ?? 0;
        return { status, stdout: "", stderr: status ? "npm error code E500\n" : "" };
      }
      if (args[0] === "audit" && args[1] === "signatures") return { status: 0, stdout: "" };
      return { status: 1, stdout: "", stderr: "npm error the fake registry refuses this\n" };
    },
    async fetch(url, init) {
      fetches.push({ url: String(url), init, at: clock });
      clock += 500;
      const document = answer(String(url), scenario.attestations[String(url)], 404);
      if (typeof document === "number")
        return { status: document, ok: false, json: async () => ({}) };
      if (has(document, "abort"))
        throw Object.assign(new Error("aborted"), { name: document.abort });
      return { status: 200, ok: true, json: async () => document };
    },
    async sleep(ms) {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  };
  return { io, calls, fetches, sleeps, out, err };
}

/** Every npm process was a registry read pinned to npm: no publish, no dist-tag, nothing else. */
function expectOnlyReads(calls: Array<{ args: string[] }>) {
  for (const { args } of calls) {
    const subcommand = args[0] === "audit" ? `audit ${args[1]}` : args[0];
    expect(["view", "install", "audit signatures"]).toContain(subcommand);
    expect(args.slice(-REGISTRY_PINS.length)).toEqual(REGISTRY_PINS);
    expect(args).not.toContain("publish");
    expect(args).not.toContain("dist-tag");
  }
}

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-npm-reconcile-test-"));
  scratchDirs.push(dir);
  return dir;
}

function textFile(text: string) {
  const path = join(scratch(), "selection.json");
  writeFileSync(path, text);
  return path;
}

function selection(packages: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    registry: NPM_REGISTRY,
    repository: "razzant/claudexor",
    workflowPath,
    version,
    ref,
    candidateSha,
    packages,
    ...overrides,
  };
}

const selectionArgs = (value: unknown) => ["--reconcile", textFile(JSON.stringify(value))];
const lineFor = (out: string[], name: string) =>
  out.find((line) => line.startsWith(`npm reconcile: ${name}@${version} `));

describe("npm release reconciliation (--reconcile)", () => {
  it("verifies an accepted version npm exposes late; invisible ones stay unresolved either way", async () => {
    const cli = publication("@claudexor/cli");
    const registry = fakeRegistry({
      views: { "@claudexor/cli@4.4.0": ["missing", "missing", cli.metadata] },
      attestations: { [cli.url]: [404, attestationDocument(cli.statement)] },
    });
    const code = await reconcileNpmPublications(
      selectionArgs(
        selection([
          { name: "@claudexor/cli", prior: "accepted", integrity: cli.integrity },
          { name: "@claudexor/policy", prior: "uncertain" },
          { name: "@claudexor/core", prior: "accepted" },
        ]),
      ),
      registry.io,
    );

    expect(code).toBe(1);
    expect(lineFor(registry.out, "@claudexor/cli")).toBe(
      "npm reconcile: @claudexor/cli@4.4.0 (selected as accepted) verified: the published bytes are the selected original tarball, with matching provenance",
    );
    expect(lineFor(registry.out, "@claudexor/policy")).toBe(
      "npm reconcile: @claudexor/policy@4.4.0 (selected as uncertain) unresolved: npm still did not expose this version when the window closed; whether the stopped run's request reached npm is unknown",
    );
    // Being selected as accepted does not make an invisible version published.
    expect(lineFor(registry.out, "@claudexor/core")).toBe(
      "npm reconcile: @claudexor/core@4.4.0 (selected as accepted) unresolved: npm still did not expose this version when the window closed; selected as accepted: reconcile again later rather than sending it again",
    );
    expect(registry.out).toContain(
      "npm reconcile: signature audit not run while a selected version is unverified",
    );
    expect(registry.err).toEqual([
      "npm reconcile incomplete: 1 of 3 selected version(s) verified; nothing was published and no dist-tag was moved",
    ]);
    expectOnlyReads(registry.calls);
    // Only the selection is read: nothing falls through to the other packages.
    expect(new Set(registry.calls.map(({ args }) => args[1]))).toEqual(
      new Set(["@claudexor/cli@4.4.0", "@claudexor/policy@4.4.0", "@claudexor/core@4.4.0"]),
    );
    // Missing, missing, served without attestations, then verified.
    expect(registry.calls.filter(({ args }) => args[1] === "@claudexor/cli@4.4.0")).toHaveLength(4);
    // Bounded: every read is cut off after a minute, polls are at most 10 s apart,
    // and no read starts once the shared 10-minute window has closed.
    for (const { options } of registry.calls) {
      expect(options).toMatchObject({ timeout: 60_000, killSignal: "SIGKILL" });
    }
    for (const { init } of registry.fetches) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.method).toBeUndefined();
    }
    expect(Math.max(...registry.sleeps)).toBeLessThanOrEqual(10_000);
    expect(registry.sleeps.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(WINDOW_MS);
    expect([...registry.calls, ...registry.fetches].every(({ at }) => at < WINDOW_MS)).toBe(true);
  });

  it("audits the selected versions' signatures and names the narrower claim without a digest", async () => {
    const cli = publication("@claudexor/cli");
    const core = publication("@claudexor/core");
    const registry = fakeRegistry({
      views: { "@claudexor/cli@4.4.0": [cli.metadata], "@claudexor/core@4.4.0": [core.metadata] },
      attestations: {
        [cli.url]: [attestationDocument(cli.statement)],
        [core.url]: [attestationDocument(core.statement)],
      },
    });
    const code = await reconcileNpmPublications(
      selectionArgs(
        selection([
          { name: "@claudexor/cli", prior: "accepted", integrity: cli.integrity },
          { name: "@claudexor/core", prior: "uncertain" },
        ]),
      ),
      registry.io,
    );

    expect(code).toBe(0);
    expect(registry.out).toEqual([
      "npm reconcile: @claudexor/cli@4.4.0 (selected as accepted) verified: the published bytes are the selected original tarball, with matching provenance",
      "npm reconcile: @claudexor/core@4.4.0 (selected as uncertain) verified: same-source provenance only; no original tarball digest was selected",
      "npm reconcile: signature audit passed",
      "npm reconcile complete: 2 of 2 selected version(s) verified; nothing was published and no dist-tag was moved",
    ]);
    expect(registry.err).toEqual([]);
    expectOnlyReads(registry.calls);
    const [install, audit] = registry.calls.slice(2);
    expect(install.args).toEqual([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--legacy-peer-deps",
      ...REGISTRY_PINS,
    ]);
    expect(install.manifest.dependencies).toEqual({
      "@claudexor/cli": "=4.4.0",
      "@claudexor/core": "=4.4.0",
    });
    expect(audit.args).toEqual(["audit", "signatures", ...REGISTRY_PINS]);
    for (const { options } of [install, audit]) {
      expect(options).toMatchObject({ timeout: 600_000, killSignal: "SIGKILL" });
    }
    expect(existsSync(String(install.options.cwd))).toBe(false);
  });

  it("reports a failed signature audit as incomplete", async () => {
    const cli = publication("@claudexor/cli");
    const registry = fakeRegistry({
      views: { "@claudexor/cli@4.4.0": [cli.metadata] },
      attestations: { [cli.url]: [attestationDocument(cli.statement)] },
      install: 1,
    });
    const code = await reconcileNpmPublications(
      selectionArgs(selection([{ name: "@claudexor/cli", prior: "accepted" }])),
      registry.io,
    );
    expect(code).toBe(1);
    expect(registry.out).toContain(
      "npm reconcile: signature audit failed: npm install: npm error code E500",
    );
    expect(registry.err).toEqual([
      "npm reconcile incomplete: 1 of 1 selected version(s) verified; nothing was published and no dist-tag was moved",
    ]);
    expectOnlyReads(registry.calls);
  });

  const mismatches: Array<
    [string, (cli: ReturnType<typeof publication>) => void, Record<string, unknown>, string]
  > = [
    [
      "a different candidate commit",
      (cli) => {
        cli.statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
          "d".repeat(40);
      },
      {},
      "SLSA source commit mismatch",
    ],
    [
      "a different workflow",
      (cli) => {
        cli.statement.predicate.buildDefinition.externalParameters.workflow.path =
          ".github/workflows/other.yml";
      },
      {},
      "SLSA workflow identity mismatch",
    ],
    [
      "a different source repository",
      (cli) => {
        cli.statement.predicate.buildDefinition.externalParameters.workflow.repository =
          "https://github.com/example/claudexor";
      },
      {},
      "SLSA workflow identity mismatch",
    ],
    [
      "bytes other than the selected original tarball",
      () => {},
      { integrity: publication("@claudexor/cli", "other bytes").integrity },
      "tarball integrity mismatch",
    ],
    [
      "an attestation that does not cover the published bytes",
      (cli) => {
        cli.statement.subject[0].digest.sha512 = "f".repeat(128);
      },
      { integrity: undefined },
      "SLSA subject does not match the published tarball",
    ],
    [
      "attestations from another host",
      (cli) => {
        cli.metadata.dist.attestations.url = "https://registry.example.com/-/npm/v1/attestations/x";
      },
      {},
      "npm provenance URL is untrusted",
    ],
    [
      "no provenance",
      (cli) => {
        delete cli.metadata.dist.attestations;
      },
      {},
      "npm provenance is missing",
    ],
    [
      "latest still on an older version",
      (cli) => {
        cli.metadata["dist-tags"].latest = "4.3.0";
      },
      {},
      "latest dist-tag mismatch",
    ],
  ];

  it.each(mismatches)("refuses %s as a mismatch", async (_label, mutate, entry, reason) => {
    const cli = publication("@claudexor/cli");
    mutate(cli);
    const registry = fakeRegistry({
      views: { "@claudexor/cli@4.4.0": [cli.metadata] },
      attestations: { [cli.url]: [attestationDocument(cli.statement)] },
    });
    const code = await reconcileNpmPublications(
      selectionArgs(
        selection([
          { name: "@claudexor/cli", prior: "accepted", integrity: cli.integrity, ...entry },
        ]),
      ),
      registry.io,
    );
    expect(code).toBe(1);
    const line = lineFor(registry.out, "@claudexor/cli");
    expect(line).toMatch(
      /^npm reconcile: @claudexor\/cli@4\.4\.0 \(selected as accepted\) mismatch: /,
    );
    expect(line).toContain(reason);
    expect(registry.out).toContain(
      "npm reconcile: signature audit not run while a selected version is unverified",
    );
    expectOnlyReads(registry.calls);
    for (const { url } of registry.fetches) expect(url).toBe(cli.url);
  });

  const unknowns: Array<[string, Partial<Record<"views" | "attestations", unknown[]>>, string]> = [
    [
      "a failing npm view",
      { views: [{ npmError: "npm error code E500" }] },
      "npm view failed: npm error code E500",
    ],
    [
      "an npm view that times out",
      { views: [{ spawnError: "ETIMEDOUT" }] },
      "npm view did not finish (ETIMEDOUT)",
    ],
    [
      "an npm view without metadata",
      { views: [{ stdout: "" }] },
      "npm view answered without readable metadata",
    ],
    [
      "a failing attestation request",
      { attestations: [500] },
      "npm attestations answered HTTP 500",
    ],
    [
      "an attestation request that times out",
      { attestations: [{ abort: "TimeoutError" }] },
      "npm attestations were not read (TimeoutError)",
    ],
    [
      "attestations that never appear",
      { attestations: [404] },
      "npm served this version but not its attestations when the window closed; selected as accepted: reconcile again later rather than sending it again",
    ],
    [
      "a version that never appears",
      { views: ["missing"] },
      "npm still did not expose this version when the window closed; selected as accepted: reconcile again later rather than sending it again",
    ],
  ];

  it.each(unknowns)(
    "keeps %s unresolved even when selected as accepted",
    async (_label, answers, detail) => {
      const cli = publication("@claudexor/cli");
      const registry = fakeRegistry({
        views: { "@claudexor/cli@4.4.0": answers.views ?? [cli.metadata] },
        attestations: { [cli.url]: answers.attestations ?? [attestationDocument(cli.statement)] },
      });
      const code = await reconcileNpmPublications(
        selectionArgs(
          selection([{ name: "@claudexor/cli", prior: "accepted", integrity: cli.integrity }]),
        ),
        registry.io,
      );
      expect(code).toBe(1);
      expect(lineFor(registry.out, "@claudexor/cli")).toBe(
        `npm reconcile: @claudexor/cli@4.4.0 (selected as accepted) unresolved: ${detail}`,
      );
      expect(registry.err).toEqual([
        "npm reconcile incomplete: 0 of 1 selected version(s) verified; nothing was published and no dist-tag was moved",
      ]);
      expectOnlyReads(registry.calls);
    },
  );

  it("starts no attestation read once a slow npm view has run past the window", async () => {
    const cli = publication("@claudexor/cli");
    // Every npm view takes 59 s, and npm serves the version only to the view
    // that starts before the window closes and finishes after it.
    const viewMs = 59_000;
    const registry = fakeRegistry({
      views: {
        "@claudexor/cli@4.4.0": (startedAt) =>
          startedAt + viewMs > WINDOW_MS ? cli.metadata : "missing",
      },
      attestations: { [cli.url]: [attestationDocument(cli.statement)] },
      viewMs,
    });
    const code = await reconcileNpmPublications(
      selectionArgs(
        selection([{ name: "@claudexor/cli", prior: "accepted", integrity: cli.integrity }]),
      ),
      registry.io,
    );

    expect(code).toBe(1);
    const crossing = registry.calls.at(-1)!;
    expect(crossing.at).toBeLessThan(WINDOW_MS);
    expect(crossing.at + viewMs).toBeGreaterThan(WINDOW_MS);
    expect(crossing.options).toMatchObject({ timeout: 60_000, killSignal: "SIGKILL" });
    expect(registry.calls.every(({ at }) => at < WINDOW_MS)).toBe(true);
    expect(registry.fetches).toEqual([]);
    expect(lineFor(registry.out, "@claudexor/cli")).toBe(
      "npm reconcile: @claudexor/cli@4.4.0 (selected as accepted) unresolved: npm served this version, but the window closed before its attestations were read; selected as accepted: reconcile again later rather than sending it again",
    );
    expectOnlyReads(registry.calls);
  });

  const cliEntry = { name: "@claudexor/cli", prior: "accepted" };
  const refusals: Array<[string, () => string[], string]> = [
    ["no selection file", () => ["--reconcile"], "--reconcile takes exactly one selection file"],
    [
      "an inline selection",
      () => [`--reconcile=${textFile(JSON.stringify(selection([cliEntry])))}`],
      "--reconcile takes exactly one selection file",
    ],
    [
      "an extra publishing flag",
      () => [...selectionArgs(selection([cliEntry])), "--provenance"],
      "--reconcile takes exactly one selection file",
    ],
    ["a missing file", () => ["--reconcile", join(scratch(), "absent.json")], "ENOENT"],
    [
      "a file that is not JSON",
      () => ["--reconcile", textFile("{")],
      "the selection file is not JSON",
    ],
    ["a list", () => ["--reconcile", textFile("[]")], "selection must be a JSON object"],
    [
      "another registry",
      () => selectionArgs(selection([cliEntry], { registry: "https://npm.example.com/" })),
      `selection registry must be ${NPM_REGISTRY}`,
    ],
    [
      "another repository",
      () => selectionArgs(selection([cliEntry], { repository: "example/claudexor" })),
      "selection repository must be razzant/claudexor",
    ],
    [
      "another workflow",
      () => selectionArgs(selection([cliEntry], { workflowPath: ".github/workflows/ci.yml" })),
      `selection workflowPath must be ${workflowPath}`,
    ],
    [
      "a version range",
      () => selectionArgs(selection([cliEntry], { version: "^4.4.0", ref: "refs/tags/v^4.4.0" })),
      "selection version must be an exact release version",
    ],
    [
      "the tag of another version",
      () => selectionArgs(selection([cliEntry], { ref: "refs/tags/v4.3.0" })),
      "selection ref must be the version's release tag",
    ],
    [
      "no candidate commit",
      () => selectionArgs(selection([cliEntry], { candidateSha: undefined })),
      "selection candidateSha must be an exact commit SHA",
    ],
    [
      "an abbreviated candidate commit",
      () => selectionArgs(selection([cliEntry], { candidateSha: "abc1234" })),
      "selection candidateSha must be an exact commit SHA",
    ],
    [
      "no packages",
      () => selectionArgs(selection([])),
      "selection packages must list at least one package",
    ],
    [
      "an unknown field",
      () => selectionArgs(selection([cliEntry], { candidateSHA: candidateSha })),
      'selection has unknown field "candidateSHA"',
    ],
    [
      "a misspelled digest field",
      () => selectionArgs(selection([{ ...cliEntry, sha512: "b".repeat(128) }])),
      'selection packages[0] has unknown field "sha512"',
    ],
    [
      "a package this checkout does not publish",
      () => selectionArgs(selection([{ name: "@claudexor/clii", prior: "accepted" }])),
      "selection packages[0].name is not a published package of this checkout",
    ],
    [
      "a repeated package",
      () => selectionArgs(selection([cliEntry, { ...cliEntry, prior: "uncertain" }])),
      "selection packages[1].name repeats an earlier package",
    ],
    [
      "an unknown prior outcome",
      () => selectionArgs(selection([{ ...cliEntry, prior: "published" }])),
      'selection packages[0].prior must be "accepted" or "uncertain"',
    ],
    [
      "a truncated digest",
      () => selectionArgs(selection([{ ...cliEntry, integrity: "sha512-abc" }])),
      "selection packages[0].integrity must be the original tarball's sha512 integrity",
    ],
  ];

  it.each(refusals)("refuses %s before any registry read", async (_label, args, message) => {
    const registry = fakeRegistry({ views: {}, attestations: {} });
    expect(await reconcileNpmPublications(args(), registry.io)).toBe(1);
    expect(registry.err).toHaveLength(1);
    expect(registry.err[0]).toMatch(/^npm reconcile refused: /);
    expect(registry.err[0]).toContain(message);
    expect(registry.out).toEqual([]);
    expect(registry.calls).toEqual([]);
    expect(registry.fetches).toEqual([]);
  });
});

// The fake npm CLI the publisher finds on PATH: it logs every invocation, answers
// `npm view` from the scenario and accepts only the signature-audit commands.
const FAKE_NPM = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const registry = JSON.parse(readFileSync(process.env.FAKE_REGISTRY, "utf8"));
const call = { args };
if (args[0] === "install") call.manifest = JSON.parse(readFileSync("package.json", "utf8"));
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(call) + "\\n");
if (args[0] === "view") {
  const answers = registry.views[args[1]] ?? ["missing"];
  const counter = join(process.env.FAKE_REGISTRY_STATE, encodeURIComponent(args[1]));
  const served = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(served + 1));
  const answer = answers[Math.min(served, answers.length - 1)];
  if (answer === "missing") {
    process.stderr.write("npm error code E404\\nnpm error 404 Not Found\\n");
    process.exit(1);
  }
  if (answer.npmError) {
    process.stderr.write(answer.npmError + "\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(answer));
  process.exit(0);
}
if (args[0] === "install" || (args[0] === "audit" && args[1] === "signatures")) process.exit(0);
process.stderr.write("npm error the fake registry refuses " + args[0] + "\\n");
process.exit(1);
`;

// Preloaded into the publisher: attestation requests are answered from the
// scenario, and sleeping advances a virtual clock instead of spending real time.
const FAKE_NETWORK_AND_CLOCK = `
import { appendFileSync, readFileSync } from "node:fs";
const registry = JSON.parse(readFileSync(process.env.FAKE_REGISTRY, "utf8"));
const served = new Map();
globalThis.fetch = async (url, init = {}) => {
  const key = String(url);
  appendFileSync(process.env.FAKE_FETCH_LOG, JSON.stringify({ url: key, method: init.method ?? "GET" }) + "\\n");
  const answers = registry.attestations[key] ?? [404];
  const index = served.get(key) ?? 0;
  served.set(key, index + 1);
  const answer = answers[Math.min(index, answers.length - 1)];
  return typeof answer === "number" ? new Response(null, { status: answer }) : Response.json(answer);
};
let offset = 0;
const realNow = performance.now.bind(performance);
performance.now = () => realNow() + offset;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms = 0, ...rest) => {
  offset += ms;
  appendFileSync(process.env.FAKE_SLEEP_LOG, ms + "\\n");
  return realSetTimeout(callback, 0, ...rest);
};
`;

// `#!/bin/sh` fakes stay on the POSIX legs (see the Windows test step in ci.yml).
describe.skipIf(process.platform === "win32")("npm release reconciliation CLI", () => {
  const rootVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

  /** Runs the real publisher script with only the fake npm on PATH and no network. */
  function runPublisher(args: string[], scenario: Scenario) {
    const dir = scratch();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    mkdirSync(join(dir, "state"));
    mkdirSync(join(dir, "runner-temp"));
    writeFileSync(join(dir, "fake-npm.mjs"), FAKE_NPM);
    writeFileSync(join(dir, "fake-network-and-clock.mjs"), FAKE_NETWORK_AND_CLOCK);
    writeFileSync(join(dir, "registry.json"), JSON.stringify(scenario));
    writeFileSync(join(bin, "npm"), '#!/bin/sh\nexec "$FAKE_NODE" "$FAKE_NPM_SCRIPT" "$@"\n');
    chmodSync(join(bin, "npm"), 0o755);
    const preload = pathToFileURL(join(dir, "fake-network-and-clock.mjs")).href;
    const result = spawnSync(process.execPath, ["--import", preload, publisher, ...args], {
      encoding: "utf8",
      env: {
        PATH: bin,
        HOME: join(dir, "home"),
        RUNNER_TEMP: join(dir, "runner-temp"),
        // Enough publishing identity that a fall-through to publish mode would
        // get past its checks and create its release output.
        GITHUB_SHA: candidateSha,
        GITHUB_REPOSITORY: "razzant/claudexor",
        GITHUB_REF: `refs/tags/v${rootVersion}`,
        CLAUDEXOR_WIN32_CONPTY_SHA256: "c".repeat(64),
        FAKE_NODE: process.execPath,
        FAKE_NPM_SCRIPT: join(dir, "fake-npm.mjs"),
        FAKE_REGISTRY: join(dir, "registry.json"),
        FAKE_REGISTRY_STATE: join(dir, "state"),
        FAKE_NPM_LOG: join(dir, "npm.log"),
        FAKE_FETCH_LOG: join(dir, "fetch.log"),
        FAKE_SLEEP_LOG: join(dir, "sleep.log"),
      },
    });
    const lines = (name: string) =>
      existsSync(join(dir, name))
        ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)
        : [];
    return {
      ...result,
      npm: lines("npm.log").map((line) => JSON.parse(line) as { args: string[]; manifest?: any }),
      fetches: lines("fetch.log").map(
        (line) => JSON.parse(line) as { url: string; method: string },
      ),
      sleeps: lines("sleep.log").map(Number),
      releaseOutput: existsSync(join(dir, "runner-temp", "claudexor-npm-release")),
    };
  }

  it("continues a late accepted version through the real entry point with registry reads only", () => {
    const cli = publication("@claudexor/cli");
    const core = publication("@claudexor/core");
    const run = runPublisher(
      selectionArgs(
        selection([
          { name: "@claudexor/cli", prior: "accepted", integrity: cli.integrity },
          { name: "@claudexor/core", prior: "uncertain" },
        ]),
      ),
      {
        views: {
          "@claudexor/cli@4.4.0": ["missing", cli.metadata],
          "@claudexor/core@4.4.0": [core.metadata],
        },
        attestations: {
          [cli.url]: [404, attestationDocument(cli.statement)],
          [core.url]: [attestationDocument(core.statement)],
        },
      },
    );

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      "npm reconcile: @claudexor/cli@4.4.0 (selected as accepted) verified: the published bytes are the selected original tarball, with matching provenance",
    );
    expect(run.stdout).toContain(
      "npm reconcile: @claudexor/core@4.4.0 (selected as uncertain) verified: same-source provenance only",
    );
    expect(run.stdout).toContain(
      "npm reconcile complete: 2 of 2 selected version(s) verified; nothing was published and no dist-tag was moved",
    );
    expect(run.npm.map(({ args }) => args.slice(0, 2))).toEqual([
      ["view", "@claudexor/cli@4.4.0"],
      ["view", "@claudexor/core@4.4.0"],
      ["view", "@claudexor/cli@4.4.0"],
      ["view", "@claudexor/cli@4.4.0"],
      ["install", "--ignore-scripts"],
      ["audit", "signatures"],
    ]);
    expectOnlyReads(run.npm);
    expect(run.npm[4].manifest.dependencies).toEqual({
      "@claudexor/cli": "=4.4.0",
      "@claudexor/core": "=4.4.0",
    });
    expect(run.fetches).toEqual([
      { url: core.url, method: "GET" },
      { url: cli.url, method: "GET" },
      { url: cli.url, method: "GET" },
    ]);
    expect(run.sleeps).toEqual([10_000, 10_000]);
    expect(run.releaseOutput).toBe(false);
  });

  it("exits 1 with registry reads only when a selected version mismatches or stays unknown", () => {
    const cli = publication("@claudexor/cli");
    cli.statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "d".repeat(
      40,
    );
    const run = runPublisher(
      selectionArgs(
        selection([
          { name: "@claudexor/cli", prior: "accepted" },
          { name: "@claudexor/policy", prior: "uncertain" },
        ]),
      ),
      {
        views: {
          "@claudexor/cli@4.4.0": [cli.metadata],
          "@claudexor/policy@4.4.0": [{ npmError: "npm error code E500" }],
        },
        attestations: { [cli.url]: [attestationDocument(cli.statement)] },
      },
    );

    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      "npm reconcile: @claudexor/cli@4.4.0 (selected as accepted) mismatch: SLSA source commit mismatch",
    );
    expect(run.stdout).toContain(
      "npm reconcile: @claudexor/policy@4.4.0 (selected as uncertain) unresolved: npm view failed: npm error code E500",
    );
    expect(run.stderr).toContain(
      "npm reconcile incomplete: 0 of 2 selected version(s) verified; nothing was published and no dist-tag was moved",
    );
    expect(run.npm.map(({ args }) => args.slice(0, 2))).toEqual([
      ["view", "@claudexor/cli@4.4.0"],
      ["view", "@claudexor/policy@4.4.0"],
    ]);
    expectOnlyReads(run.npm);
    expect(run.releaseOutput).toBe(false);
  });

  it.each([
    ["--provenance --reconcile=<file>", (file: string) => ["--provenance", `--reconcile=${file}`]],
    ["--reconcile <file> --provenance", (file: string) => ["--reconcile", file, "--provenance"]],
  ])("never falls through to publishing for %s", (_label, args) => {
    const file = textFile(
      JSON.stringify(selection([{ name: "@claudexor/cli", prior: "accepted" }])),
    );
    const run = runPublisher(args(file), { views: {}, attestations: {} });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "npm reconcile refused: --reconcile takes exactly one selection file and no other argument",
    );
    expect(run.npm).toEqual([]);
    expect(run.fetches).toEqual([]);
    expect(run.releaseOutput).toBe(false);
  });

  it("keeps publish mode behind --provenance", () => {
    const run = runPublisher([], { views: {}, attestations: {} });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("npm release failed: --provenance is mandatory");
    expect(run.npm).toEqual([]);
    expect(run.releaseOutput).toBe(false);
  });
});

// npm's own registry resolution, offline: the npm installed beside this Node
// (where setup-node and the official distributions put it) answers from an
// empty cache only, so its error names the registry it would have asked and
// no request leaves the machine. Toolchains without that npm skip this suite.
// This release-packaging integration fixture uses the toolchain's npm, never a
// harness installation path or a production engine capability.
const realNpmCli =
  process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");

describe.skipIf(process.platform === "win32" || !existsSync(realNpmCli))(
  "npm release reconciliation with the real npm CLI, offline",
  () => {
    it("reads the selected registry although an npmrc sends the release scope elsewhere", () => {
      const dir = scratch();
      const elsewhere = "https://npm-mirror.invalid/";
      const bin = join(dir, "bin");
      mkdirSync(bin);
      mkdirSync(join(dir, "home"));
      writeFileSync(join(bin, "npm"), '#!/bin/sh\nexec "$REAL_NODE" "$REAL_NPM_CLI" "$@"\n');
      chmodSync(join(bin, "npm"), 0o755);
      writeFileSync(
        join(dir, "npmrc"),
        `registry=${elsewhere}\n@claudexor:registry=${elsewhere}\n`,
      );
      writeFileSync(join(dir, "global-npmrc"), "");
      const env = {
        PATH: bin,
        HOME: join(dir, "home"),
        REAL_NODE: process.execPath,
        REAL_NPM_CLI: realNpmCli,
        npm_config_userconfig: join(dir, "npmrc"),
        npm_config_globalconfig: join(dir, "global-npmrc"),
        npm_config_cache: join(dir, "cache"),
        npm_config_offline: "true",
        npm_config_update_notifier: "false",
      };

      // Control: pinning only the default registry, npm follows the scope override.
      const unpinned = spawnSync(
        join(bin, "npm"),
        ["view", "@claudexor/cli@4.4.0", "--json", "--registry", NPM_REGISTRY],
        { cwd: dir, encoding: "utf8", env },
      );
      expect(unpinned.status).not.toBe(0);
      expect(unpinned.stderr).toMatch(/npm-mirror\.invalid\/@claudexor%2fcli/i);

      const run = spawnSync(
        process.execPath,
        [publisher, ...selectionArgs(selection([{ name: "@claudexor/cli", prior: "accepted" }]))],
        { encoding: "utf8", env },
      );
      expect(run.status).toBe(1);
      // npm's error lines follow the outcome line, so match across lines.
      expect(run.stdout).toMatch(
        /@claudexor\/cli@4\.4\.0 \(selected as accepted\) unresolved: npm view failed: [\s\S]*registry\.npmjs\.org\/@claudexor%2fcli/i,
      );
      expect(`${run.stdout}${run.stderr}`).not.toContain("npm-mirror.invalid");
    });
  },
);
