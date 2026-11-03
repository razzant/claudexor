/**
 * #393 x #147 for the reviewer pipelines: a panel reads the reviewer's catalog
 * under its credential (the read that admits the requested model), and the
 * review request must send the key that read checked. The real explicit and
 * automatic panels and review engine drive the real raw-api adapter against a LOCAL fake
 * OpenRouter (127.0.0.1) whose answers depend on the bearer key; keys resolve
 * from the real file secret store in this suite's scratch CLAUDEXOR_CONFIG_DIR.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ModelCatalogUnavailableError } from "@claudexor/core";
import { reviewCandidate } from "@claudexor/review";
import { CredentialProfile } from "@claudexor/schema";
import { createRawApiAdapter } from "../../harness-raw-api/src/index.js";
import { SecretStore } from "../../secrets/src/index.js";
import { resolveAutoReviewerPanel, resolveExplicitReviewerPanel } from "./reviewerPanel.js";

const KEY_ENV = "CLAUDEXOR_TEST_REVIEWER_KEY";
/** Per key: the status each GET /models answers; 200 lists the reviewer model. */
let catalogStatus = new Map<string, number>();
const seen = { gets: [] as string[], posts: [] as string[] };
let server: Server;
let baseUrl = "";
const roots: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const key = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/api/v1/models") {
        seen.gets.push(key);
        res.statusCode = catalogStatus.get(key) ?? 200;
        res.end(
          res.statusCode === 200
            ? JSON.stringify({ data: [{ id: "vendor/reviewer", context_length: 50_000 }] })
            : "upstream down",
        );
        return;
      }
      seen.posts.push(key);
      res.end(
        JSON.stringify({
          model: "vendor/reviewer",
          choices: [{ message: { content: "[]" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  catalogStatus = new Map();
  seen.gets.length = 0;
  seen.posts.length = 0;
  delete process.env[KEY_ENV];
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const store = new SecretStore();
const work = CredentialProfile.parse({
  profile_id: "work",
  harness_id: "openrouter",
  display_name: "Work",
  credential_kind: "api_key",
  secret_ref: "openrouter:work",
  enabled: true,
});

/** The panel's resolution, then the review: `between` runs after the panel's
 * catalog check and before the review request, as a replaced key would. The
 * explicit panel names the reviewer; `auto` lets the automatic panel pick it. */
async function review(
  entry: { credentialProfileId?: string } | "auto",
  profile: CredentialProfile | null,
  between: () => void = () => {},
) {
  const root = mkdtempSync(join(tmpdir(), "claudexor-reviewer-key-"));
  roots.push(root);
  const evidenceDir = join(root, "evidence");
  const candidate = join(root, "candidate");
  mkdirSync(evidenceDir);
  mkdirSync(candidate);
  for (const file of [
    "USER_INTENT.md",
    "FORBIDDEN_FINDINGS.md",
    "PLAN_ACCEPTED.md",
    "TESTS.txt",
    "DECIDED_TRADEOFFS.md",
  ])
    writeFileSync(join(evidenceDir, file), "(synthetic)\n");
  writeFileSync(join(candidate, "README.md"), "new\n");
  const adapter = createRawApiAdapter({
    id: "openrouter",
    providerFamily: "openai", // a known family: review health counts only those
    baseUrl,
    keyEnv: KEY_ENV,
    defaultModel: "vendor/reviewer",
  });
  const deps = {
    cwd: candidate,
    registry: new Map([["openrouter", adapter]]),
    harnessSettings: {},
    authPreferenceFor: () => "api_key" as const,
    resolveReviewerProfile: async () => profile,
  };
  const reviewers =
    entry === "auto"
      ? await resolveAutoReviewerPanel(deps, { reviewerModels: { openai: "vendor/reviewer" } })
      : await resolveExplicitReviewerPanel(deps, [
          { harness: "openrouter", model: "vendor/reviewer", ...entry },
        ]);
  between();
  return reviewCandidate({
    candidateLabel: "fixture",
    cwd: candidate,
    evidenceDir,
    diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
    reviewers,
    transientRetryPolicy: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 },
    envInheritance: "clean",
  });
}

describe("a reviewer sends the key its panel's catalog read checked (#393 x #147)", () => {
  const replace = () => store.set("openrouter:work", "fixture-review-replaced");
  beforeEach(() => {
    store.set("openrouter:work", "fixture-review-checked");
    // The harness discovers only with its own default key present (never sent here).
    store.set("openrouter", "fixture-review-default");
  });

  it("a PINNED named key replaced after the panel's check: the review POST keeps the checked key", async () => {
    const result = await review({ credentialProfileId: "work" }, work, replace);
    expect(seen.gets).toEqual(["fixture-review-checked"]); // one read, no extra GET
    expect(seen.posts).toEqual(["fixture-review-checked"]);
    expect(result.healthyProviders).toEqual(["openai"]); // the review completed on that key
  });

  it("a POOL-chosen named key replaced after the panel's check: the same", async () => {
    await review({}, work, replace);
    expect(seen.gets).toEqual(["fixture-review-checked"]);
    expect(seen.posts).toEqual(["fixture-review-checked"]);
  });

  it("a panel read that could not list the catalog (503) still binds the key it was made with", async () => {
    catalogStatus.set("fixture-review-checked", 503);
    await review({ credentialProfileId: "work" }, work, replace);
    expect(seen.gets).toEqual(["fixture-review-checked", "fixture-review-checked"]);
    expect(seen.posts).toEqual(["fixture-review-checked"]);
  });

  it("the same key, never replaced, is sent as before", async () => {
    await review({ credentialProfileId: "work" }, work);
    expect(seen.posts).toEqual(["fixture-review-checked"]);
  });

  it("a key the endpoint rejects still refuses at the panel, before any review request", async () => {
    catalogStatus.set("fixture-review-checked", 401);
    await expect(review({ credentialProfileId: "work" }, work, replace)).rejects.toBeInstanceOf(
      ModelCatalogUnavailableError,
    );
    expect(seen.posts).toEqual([]);
  });

  it("an AUTOMATIC panel's pool-chosen key replaced after its check: the review POST keeps the checked key", async () => {
    const result = await review("auto", work, replace);
    expect(seen.gets).toEqual(["fixture-review-checked"]);
    expect(seen.posts).toEqual(["fixture-review-checked"]);
    expect(result.healthyProviders).toEqual(["openai"]);
  });

  it("the DEFAULT slot is no explicit raw reviewer: refused before any catalog read or request", async () => {
    process.env[KEY_ENV] = "fixture-review-default";
    await expect(review({}, null)).rejects.toThrow(
      "reviewer harness 'openrouter' is not doctor-ok",
    );
    expect(seen.gets).toEqual([]);
    expect(seen.posts).toEqual([]);
  });
});
