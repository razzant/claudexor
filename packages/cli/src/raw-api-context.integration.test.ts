/**
 * #147 through the production path: the real Orchestrator builds the raw
 * packet from the project's `context.mandatory_files`, sized from the catalog
 * read the dispatch gate makes under the run's own key, and the real raw-api
 * adapter sends it to a LOCAL fake OpenRouter (127.0.0.1) whose received bytes
 * are asserted here.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { createRawApiAdapter } from "@claudexor/harness-raw-api";
import { Orchestrator } from "@claudexor/orchestrator";
import {
  RunFailure,
  RunTelemetry,
  type HarnessEvent,
  type RawContextPacket,
} from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { OPENROUTER_ROUTING_VARIANTS } from "./registry.js";

const KEY_ENV = "CLAUDEXOR_TEST_RAW_CONTEXT_KEY";
const BIG = `${"q".repeat(99)}\n`.repeat(2_700); // 270 KB: above the 256 KiB ordinary limit
const roots: string[] = [];
const seen = { gets: [] as string[], posts: [] as Array<{ auth: string; body: any }> };
let window = 1_000_000;
/** What each successive GET /models answers: the catalog, or an HTTP error
 * status; an exhausted script answers the catalog. */
let catalogAnswers: Array<"listed" | number> = [];
/** Called after each GET /models is answered, with that read's bearer. */
let afterCatalogRead: ((auth: string) => void) | null = null;
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const auth = String(req.headers.authorization ?? "");
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/api/v1/models") {
        seen.gets.push(auth);
        afterCatalogRead?.(auth);
        const answer = catalogAnswers.shift() ?? "listed";
        if (answer !== "listed") {
          res.statusCode = answer;
          res.end("upstream down");
          return;
        }
        res.end(
          JSON.stringify({
            data: [
              {
                id: "vendor/big",
                context_length: window,
                top_provider: { max_completion_tokens: 4_096 },
              },
            ],
          }),
        );
        return;
      }
      seen.posts.push({ auth, body: JSON.parse(raw) });
      const patch =
        "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# repo\n+# raw implemented\n";
      res.end(
        JSON.stringify({
          model: "vendor/big",
          choices: [{ message: { content: JSON.stringify({ patch }) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  process.env[KEY_ENV] = "sk-e2e";
});
let serverClosed = false;
// Registered before the close hook on purpose: Vitest's default
// `sequence.hooks: "stack"` runs after-hooks in reverse, so the removal starts
// only after the server closed, and a close that fails or times out stops the
// chain and keeps the directories. The flag keeps that true under any order.
afterAll(() => {
  if (!serverClosed) throw new Error("temp dirs retained: the server did not close first");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
// Closing the server keeps the default hook deadline.
afterAll(async () => {
  delete process.env[KEY_ENV];
  await new Promise((resolve) => server.close(resolve));
  serverClosed = true;
});
beforeEach(() => {
  seen.gets.length = 0;
  seen.posts.length = 0;
  catalogAnswers = [];
  afterCatalogRead = null;
  process.env[KEY_ENV] = "sk-e2e";
});

/** A committed project: `files` beside the README, `config` as its
 * `.claudexor/config.yaml` when given. */
function committed(files: Record<string, string>, config?: string): string {
  const root = mkdtempSync(join(tmpdir(), "claudexor-raw-e2e-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  writeFileSync(join(root, "README.md"), "# repo\n");
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  if (config !== undefined) {
    mkdirSync(join(root, ".claudexor"));
    writeFileSync(join(root, ".claudexor", "config.yaml"), config);
  }
  git("add", ".");
  git("commit", "-q", "-m", "base");
  return root;
}

const project = () =>
  committed({ "BIG.md": BIG }, "version: 1\ncontext:\n  mandatory_files: [BIG.md]\n");

/** Four optional files of ~17.7k estimated tokens each (~70k together): all of
 * them fit the assumed ceiling, about half of them a known 50k window. */
const OPTIONAL = `${"o".repeat(99)}\n`.repeat(700);
const optionalProject = () =>
  committed(Object.fromEntries([1, 2, 3, 4].map((n) => [`OPT-${n}.md`, OPTIONAL])));

/** One Agent run: a single attempt (`n: 1`), or the convergence loop when
 * `attempts` is given (no review: no reviewer families exist here). */
async function runAgent(
  repoRoot: string,
  model = "vendor/big:nitro",
  options: {
    url?: string;
    onHarnessEvent?: (event: HarnessEvent) => void;
    attempts?: number;
  } = {},
) {
  const adapter = createRawApiAdapter({
    id: "openrouter",
    providerFamily: "unknown",
    baseUrl: options.url ?? baseUrl,
    keyEnv: KEY_ENV,
    defaultModel: "vendor/big",
    routingVariants: OPENROUTER_ROUTING_VARIANTS,
  });
  return new Orchestrator({ registry: new Map([[adapter.id, adapter]]), reviewers: [] }).run({
    repoRoot,
    prompt: "Update the README heading.",
    mode: "agent",
    harnesses: [adapter.id],
    models: { openrouter: model },
    ...(options.attempts ? { attempts: options.attempts, review: false } : { n: 1 }),
    ...(options.onHarnessEvent ? { onHarnessEvent: options.onHarnessEvent } : {}),
  });
}

/** An Ask without a project (#133: a raw API reads no project files). */
async function runAsk(model = "vendor/big") {
  const adapter = createRawApiAdapter({
    id: "openrouter",
    providerFamily: "unknown",
    baseUrl,
    keyEnv: KEY_ENV,
  });
  const repoRoot = noProjectRepoRoot();
  mkdirSync(repoRoot, { recursive: true });
  return new Orchestrator({ registry: new Map([[adapter.id, adapter]]), reviewers: [] }).run({
    repoRoot,
    prompt: "2+2?",
    mode: "ask",
    contextMode: "off",
    harnesses: [adapter.id],
    models: { openrouter: model },
  });
}

const failureRecord = (runDir: string) =>
  readFileSync(join(runDir, "final", "failure.yaml"), "utf8");
/** The persisted records parsed through their schemas, as projections read them. */
const typedFailure = (runDir: string) =>
  RunFailure.parse(new ArtifactStore(runDir).readYaml(join(runDir, "final", "failure.yaml")));
const typedTelemetry = (runDir: string) =>
  RunTelemetry.parse(new ArtifactStore(runDir).readYaml(join(runDir, "final", "telemetry.yaml")));
const attemptRecord = (runDir: string) =>
  readFileSync(join(runDir, "attempts", "a01", "attempt.yaml"), "utf8");

function sentPacket(index = 0): RawContextPacket {
  const content = seen.posts[index]!.body.messages.at(-1).content as string;
  return JSON.parse(content.slice(content.indexOf("RAW_CONTEXT_PACKET:\n") + 20));
}

describe("raw-api production packet (#147, end to end)", () => {
  it("POSTs the committed 270 KB mandatory file complete, sized for the selected model's window", async () => {
    window = 1_000_000;
    const repo = project();
    const result = await runAgent(repo);
    expect(seen.posts, result.summary).toHaveLength(1);
    expect(result.lifecycle).toBe("succeeded");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# repo\n"); // isolated envelope
    const post = seen.posts[0]!;
    // The routing-variant id travels byte-identical; every request used the run's key.
    expect(post.body.model).toBe("vendor/big:nitro");
    expect([...seen.gets, post.auth].every((auth) => auth === "Bearer sk-e2e")).toBe(true);
    const packet = sentPacket();
    expect(packet.readable_files.find((file) => file.path === "BIG.md")?.content).toBe(BIG);
    expect(packet.budget).toMatchObject({
      basis: "model_context_window",
      model: "vendor/big:nitro",
      context_window: 1_000_000,
      output_allowance_tokens: 4_096,
      mandatory_paths: ["BIG.md"],
    });
    const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('raw context sized for \\"vendor/big:nitro\\"');
    expect(events).toContain("routing variant :nitro");
    // #147: the attempt keeps the prepared request's size typed (this one was
    // POSTed), beside the packet's budget.
    const telemetry = typedTelemetry(result.runDir);
    const receipt = telemetry.attempts.find(
      (attempt) => attempt.attempt_id === telemetry.final_attempt_id,
    )?.raw_context;
    expect(receipt).toEqual({
      model: "vendor/big:nitro",
      estimated_request_tokens: expect.any(Number),
      budget: packet.budget,
    });
    // The whole request is at least the packet plus its framing as sized.
    expect(receipt!.estimated_request_tokens).toBeGreaterThanOrEqual(
      packet.budget!.estimated_packet_tokens,
    );
  });

  it("refuses mandatory content over a KNOWN small window before any POST, typed", async () => {
    window = 50_000;
    const repo = project();
    const result = await runAgent(repo);
    expect(seen.posts).toHaveLength(0);
    expect(result.lifecycle).toBe("failed");
    const attempt = readFileSync(join(result.runDir, "attempts", "a01", "attempt.yaml"), "utf8");
    expect(attempt).toContain("raw_context_exceeds_window");
    expect(attempt).toContain("50000-token context window");
    expect(attempt).toContain("BIG.md (~");
    // The estimated pre-send refusal stays typed in the persisted terminal.
    const failure = failureRecord(result.runDir);
    expect(failure).toContain("code: raw_context_exceeds_window");
    expect(failure).toContain("category: validation");
    expect(`${failure}${attempt}`).not.toContain("process_crash");
    // #147: the sizes behind it are typed, add up, and match the message's figures.
    const typed = typedFailure(result.runDir);
    const shortfall = typed.rawContextShortfall!;
    expect(shortfall).toMatchObject({
      model: "vendor/big:nitro",
      context_window: 50_000,
      output_allowance_tokens: 4_096,
      mandatory_files: [{ path: "BIG.md", estimated_tokens: expect.any(Number) }],
    });
    const needed =
      shortfall.packet_tokens + shortfall.framing_tokens + shortfall.output_allowance_tokens;
    expect(needed).toBeGreaterThan(shortfall.context_window);
    expect(shortfall.mandatory_files[0]!.estimated_tokens).toBeLessThanOrEqual(
      shortfall.packet_tokens,
    );
    expect(typed.safeMessage).toContain(
      `needs ~${shortfall.packet_tokens} tokens with every optional file omitted (mandatory: BIG.md (~${shortfall.mandatory_files[0]!.estimated_tokens} tokens))`,
    );
    expect(typed.nextActions).toEqual([
      "Choose a model with a larger context window",
      "Reduce context.mandatory_files in the project's .claudexor/config.yaml",
      "Or use a harness that reads project files itself",
    ]);
  });

  it("sizes the POSTed packet from the dispatch gate's own catalog read, with no other read", async () => {
    window = 50_000;
    const result = await runAgent(optionalProject(), "vendor/big");
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(seen.posts).toHaveLength(1);
    // Admission and the dispatch gate read the catalog; nothing reads it again.
    expect(seen.gets).toHaveLength(2);
    const { budget } = sentPacket();
    expect(budget).toMatchObject({
      basis: "model_context_window",
      model: "vendor/big",
      context_window: 50_000,
      output_allowance_tokens: 4_096,
    });
    expect(budget!.omitted_for_budget).toBeGreaterThan(0);
    expect(
      budget!.estimated_packet_tokens + budget!.framing_tokens! + budget!.output_allowance_tokens!,
    ).toBeLessThanOrEqual(50_000);
    const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('raw context sized for \\"vendor/big\\"');
  });

  it("keeps the admission read's 50k window when the dispatch read fails, never the assumed ceiling", async () => {
    // Admission reads the catalog under the run's key and knows the 50k window;
    // the dispatch read under the same key then fails temporarily (decision A
    // forwards the explicit model). The request must still be sized to 50k.
    window = 50_000;
    catalogAnswers = ["listed", 503];
    const result = await runAgent(optionalProject(), "vendor/big");
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(seen.gets).toHaveLength(2); // no extra read for the fallback
    expect(seen.posts).toHaveLength(1);
    expect(seen.posts[0]!.body.model).toBe("vendor/big");
    const { budget } = sentPacket();
    expect(budget).toMatchObject({ basis: "model_context_window", context_window: 50_000 });
    expect(budget!.omitted_for_budget).toBeGreaterThan(0);
    expect(
      budget!.estimated_packet_tokens + budget!.framing_tokens! + budget!.output_allowance_tokens!,
    ).toBeLessThanOrEqual(50_000);
    const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8");
    expect(events).toContain(
      "could not be read (http_status; HTTP 503: upstream down) at dispatch; this run's earlier catalog read with the same credentials",
    );
  });

  it("a key replaced after admission is another credential: its failed dispatch read leaves the window unknown", async () => {
    // The default slot keeps its name while its key changes between the
    // admission read (50k under sk-e2e) and the dispatch read (503).
    window = 50_000;
    catalogAnswers = ["listed", 503];
    afterCatalogRead = () => {
      process.env[KEY_ENV] = "sk-e2e-replaced";
      afterCatalogRead = null;
    };
    const result = await runAgent(optionalProject(), "vendor/big");
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(seen.gets).toEqual(["Bearer sk-e2e", "Bearer sk-e2e-replaced"]);
    expect(seen.posts.map((post) => post.auth)).toEqual(["Bearer sk-e2e-replaced"]);
    expect(sentPacket().budget).toMatchObject({ basis: "assumed_ceiling", context_window: null });
    const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8");
    expect(events).not.toContain("earlier catalog read with the same credentials");
    expect(events).toContain('so model \\"vendor/big\\" could not be verified');
  });

  it("a key replaced while the dispatch read is answered: that spawn's POST carries the key the read checked", async () => {
    window = 50_000;
    let reads = 0;
    afterCatalogRead = () => {
      reads += 1;
      if (reads === 2) process.env[KEY_ENV] = "sk-e2e-replaced"; // during the dispatch GET
    };
    const result = await runAgent(optionalProject(), "vendor/big");
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(seen.gets).toEqual(["Bearer sk-e2e", "Bearer sk-e2e"]);
    expect(seen.posts.map((post) => post.auth)).toEqual(["Bearer sk-e2e"]);
    expect(sentPacket().budget).toMatchObject({ context_window: 50_000 });
  });
});

describe("the convergence loop sends a raw producer the same packet as one attempt (#147)", () => {
  it.each([
    ["a single attempt (n: 1)", undefined],
    ["the convergence loop (attempts: 1)", 1],
  ] as const)(
    "%s: the mandatory file and the patch protocol reach the POST, and the patch applies",
    async (_loop, attempts) => {
      window = 1_000_000;
      const result = await runAgent(project(), "vendor/big", attempts ? { attempts } : {});
      expect(result.lifecycle, result.summary).toBe("succeeded");
      expect(seen.posts).toHaveLength(1);
      expect(seen.posts[0]!.body.messages.at(-1).content).toContain("RAW_CONTEXT_PACKET:");
      const packet = sentPacket();
      expect(packet.readable_files.find((file) => file.path === "BIG.md")?.content).toBe(BIG);
      expect(packet.budget).toMatchObject({
        mandatory_paths: ["BIG.md"],
        context_window: 1_000_000,
      });
      const telemetry = typedTelemetry(result.runDir);
      expect(telemetry.attempts.find((a) => a.attempt_id === "a01")?.raw_context?.budget).toEqual(
        packet.budget,
      );
    },
  );
});

describe("a catalog read that fails at dispatch (#393, decision A)", () => {
  it("in the agent attempt loop: a REJECTED key is a typed refusal, nothing sent, never a crash", async () => {
    window = 50_000;
    catalogAnswers = ["listed", 401];
    const result = await runAgent(optionalProject(), "vendor/big");
    expect(seen.posts).toHaveLength(0);
    expect(result.lifecycle).toBe("failed");
    const failure = failureRecord(result.runDir);
    expect(failure).toContain("code: model_catalog_unavailable");
    expect(failure).toContain("category: auth");
    expect(failure.replace(/\s+/g, " ")).toContain(
      "could not be read (auth_rejected; HTTP 401: upstream down)",
    );
    const recorded = `${failure}${attemptRecord(result.runDir)}`;
    expect(recorded).not.toContain("process_crash");
    expect(recorded).not.toContain("crashed");
  });

  it("in the read-only attempt loop (Ask): a rejected key refuses the same way", async () => {
    catalogAnswers = ["listed", 401];
    const result = await runAsk("vendor/big");
    expect(seen.posts).toHaveLength(0);
    expect(result.lifecycle).toBe("failed");
    const failure = failureRecord(result.runDir);
    expect(failure).toContain("code: model_catalog_unavailable");
    expect(failure).toContain("category: auth");
    expect(failure).not.toContain("process_crash");
    expect(failure).not.toContain("crashed");
  });

  it("an Ask whose catalog never answered sends the explicit model byte-identical on the same key, saying so", async () => {
    catalogAnswers = [503, 503];
    const result = await runAsk("vendor/big");
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(seen.gets).toHaveLength(2);
    expect(seen.posts).toHaveLength(1);
    expect(seen.posts[0]!.body.model).toBe("vendor/big");
    expect([...seen.gets, seen.posts[0]!.auth].every((auth) => auth === "Bearer sk-e2e")).toBe(
      true,
    );
    const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8");
    expect(events).toContain(
      'so model \\"vendor/big\\" could not be verified; it is sent unchanged on the same key',
    );
  });
});

describe("a try whose POST never reached the endpoint (#147 receipts)", () => {
  it("keeps that try's prepared-request receipt and its failed-try row, though no POST arrived", async () => {
    // A dedicated endpoint answers the admission and try-1 dispatch reads with a
    // 1M window, is gone before try 1's POST, and is back with a 50k window for
    // the retry once try 1 has reported its transport error.
    const posts: string[] = [];
    let gets = 0;
    const listener: Parameters<typeof createServer>[1] = (req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.method !== "GET") {
          posts.push(String(req.url));
          res.statusCode = 500;
          res.end();
          return;
        }
        gets += 1;
        const contextWindow = gets <= 2 ? 1_000_000 : 50_000;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ data: [{ id: "vendor/big", context_length: contextWindow }] }),
          () => {
            if (gets !== 2) return;
            endpoint.close();
            endpoint.closeAllConnections();
          },
        );
      });
    };
    let endpoint = createServer(listener);
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const port = (endpoint.address() as AddressInfo).port;
    let restored = false;
    const result = await runAgent(project(), "vendor/big", {
      url: `http://127.0.0.1:${port}/api/v1`,
      onHarnessEvent: (event) => {
        if (event.type !== "error" || restored) return;
        restored = true;
        endpoint = createServer(listener);
        endpoint.listen(port, "127.0.0.1");
      },
    });
    await new Promise((resolve) => {
      endpoint.close(resolve);
      endpoint.closeAllConnections();
    });
    expect(posts).toEqual([]); // nothing ever reached the endpoint as a POST
    expect(gets).toBe(3);
    expect(result.lifecycle).toBe("failed");
    const failure = typedFailure(result.runDir);
    expect(failure.code).toBe("raw_context_exceeds_window");
    // The failed-try row is dispatch evidence, not proof that a request was sent.
    expect(failure.poolAttempts).toMatchObject([
      { attemptId: "a01", tryIndex: 0, error: "fetch failed" },
    ]);
    // The receipt is the request as prepared just before the POST that never connected.
    const attempt = typedTelemetry(result.runDir).attempts.find((a) => a.attempt_id === "a01");
    expect(attempt?.raw_context).toMatchObject({
      model: "vendor/big",
      budget: { basis: "model_context_window", context_window: 1_000_000 },
    });
  });
});
