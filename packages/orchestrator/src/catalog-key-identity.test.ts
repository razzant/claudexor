/**
 * #393 x #147: which earlier catalog read may answer a failed dispatch read.
 * The real raw-api adapter reads a LOCAL fake OpenRouter (127.0.0.1) whose
 * answers depend on the bearer key, and resolves its key from the real file
 * secret store in this suite's scratch CLAUDEXOR_CONFIG_DIR. A synthetic key
 * replaced between admission and dispatch keeps the same profile id (or the
 * default slot), so only the key itself can tell the two reads apart.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ModelCatalogUnavailableError, type RawRequestCapacity } from "@claudexor/core";
import { CredentialProfile, HarnessRunSpec, type RawContextPacket } from "@claudexor/schema";
import { createRawApiAdapter } from "../../harness-raw-api/src/index.js";
import { SecretStore } from "../../secrets/src/index.js";
import {
  assertRouteModelsAllowed,
  runModelGovernedRoute,
  type ModelGovernedRoute,
} from "./modelGovernance.js";

const KEY_ENV = "CLAUDEXOR_TEST_CATALOG_IDENTITY_KEY";
const PACKET = { packet_hash: "sha256:sized" } as RawContextPacket;
/** Per key: what each successive GET /models answers (a window lists the
 * model with it, a number is that HTTP status); the last answer repeats. */
let answers = new Map<string, Array<number | { window: number }>>();
const seen = { gets: [] as string[], posts: [] as string[] };
/** Runs while a GET /models is being answered, after its key is recorded. */
let duringGet: ((key: string) => void) | null = null;
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const key = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/api/v1/models") {
        seen.gets.push(key);
        duringGet?.(key);
        const script = answers.get(key) ?? [];
        const answer = (script.length > 1 ? script.shift() : script[0]) ?? 404;
        if (typeof answer === "number") {
          res.statusCode = answer;
          res.end("upstream down");
          return;
        }
        res.end(JSON.stringify({ data: [{ id: "vendor/m", context_length: answer.window }] }));
        return;
      }
      seen.posts.push(key);
      res.end(
        JSON.stringify({
          model: "vendor/m",
          choices: [{ message: { content: "4" }, finish_reason: "stop" }],
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
  answers = new Map();
  seen.gets.length = 0;
  seen.posts.length = 0;
  duringGet = null;
  delete process.env[KEY_ENV];
});

const store = new SecretStore();
const accountA = CredentialProfile.parse({
  profile_id: "acct-a",
  harness_id: "openrouter",
  display_name: "Account A",
  credential_kind: "api_key",
  secret_ref: "openrouter:acct-a",
  enabled: true,
});

/** Admission, then the per-spawn gate, on one route, as a run uses them. */
function route(profile: CredentialProfile | null) {
  const adapter = createRawApiAdapter({
    id: "openrouter",
    providerFamily: "unknown",
    baseUrl,
    keyEnv: KEY_ENV,
  });
  const routed: ModelGovernedRoute = {
    adapter,
    knownModels: [],
    authRouteEstimate: "api_key",
    quotaAdmission: { profile },
    settings: null,
  };
  const sized: Array<RawRequestCapacity | null> = [];
  const notes: string[] = [];
  return {
    sized,
    notes,
    admit: () => assertRouteModelsAllowed([routed], { openrouter: "vendor/m" }, "/repo"),
    /** One spawn; `duringPacket` runs while its packet is prepared. */
    dispatch: async (duringPacket?: () => void) => {
      const spec = HarnessRunSpec.parse({
        session_id: "ses-key",
        intent: "explain",
        prompt: "2+2?",
        cwd: "/repo",
        model_hint: "vendor/m",
        ...(profile ? { credential_profile: profile } : {}),
      });
      const rawContext = async (capacity: RawRequestCapacity | null) => {
        sized.push(capacity);
        duringPacket?.();
        return PACKET;
      };
      for await (const event of runModelGovernedRoute(routed, spec, { rawContext }))
        if (event.type === "status" && event.text) notes.push(event.text);
    },
  };
}

const EARLIER = "this run's earlier catalog read with the same credentials";
const UNVERIFIED = 'model "vendor/m" could not be verified; it is sent unchanged on the same key';

describe("a failed dispatch read borrows an earlier read only under the same key (#393 x #147)", () => {
  it("a NAMED key replaced after admission: its window is unknown, never the old key's 50k", async () => {
    store.set("openrouter:acct-a", "sk-synthetic-a1");
    answers.set("sk-synthetic-a1", [{ window: 50_000 }]);
    answers.set("sk-synthetic-a2", [503]);
    const r = route(accountA);
    await r.admit();
    store.set("openrouter:acct-a", "sk-synthetic-a2"); // same profile id, another key
    await r.dispatch();
    expect(seen.gets).toEqual(["sk-synthetic-a1", "sk-synthetic-a2"]);
    expect(seen.posts).toEqual(["sk-synthetic-a2"]);
    expect(r.sized).toEqual([expect.objectContaining({ contextWindow: null })]);
    expect(r.notes.join("\n")).toContain(UNVERIFIED);
    expect(r.notes.join("\n")).not.toContain(EARLIER);
  });

  it("the DEFAULT key replaced after admission: the same, for the profile-less slot", async () => {
    store.set("openrouter", "sk-synthetic-d1");
    answers.set("sk-synthetic-d1", [{ window: 50_000 }]);
    answers.set("sk-synthetic-d2", [503]);
    const r = route(null);
    await r.admit();
    store.set("openrouter", "sk-synthetic-d2");
    await r.dispatch();
    expect(seen.gets).toEqual(["sk-synthetic-d1", "sk-synthetic-d2"]);
    expect(seen.posts).toEqual(["sk-synthetic-d2"]);
    expect(r.sized).toEqual([expect.objectContaining({ contextWindow: null })]);
    expect(r.notes.join("\n")).not.toContain(EARLIER);
  });

  it("the genuinely same key keeps admission's 50k window through a 503, saying so", async () => {
    store.set("openrouter:acct-a", "sk-synthetic-a1");
    answers.set("sk-synthetic-a1", [{ window: 50_000 }, 503]);
    const r = route(accountA);
    await r.admit();
    await r.dispatch();
    expect(seen.gets).toEqual(["sk-synthetic-a1", "sk-synthetic-a1"]); // no extra read
    expect(r.sized).toEqual([expect.objectContaining({ contextWindow: 50_000 })]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain(`at dispatch; ${EARLIER}`);
  });

  it("a successful read under the new key answers for itself", async () => {
    store.set("openrouter:acct-a", "sk-synthetic-a1");
    answers.set("sk-synthetic-a1", [{ window: 50_000 }]);
    answers.set("sk-synthetic-a2", [{ window: 64_000 }]);
    const r = route(accountA);
    await r.admit();
    store.set("openrouter:acct-a", "sk-synthetic-a2");
    await r.dispatch();
    expect(r.sized).toEqual([expect.objectContaining({ contextWindow: 64_000 })]);
    expect(r.notes).toEqual([]);
  });

  it("a new key the endpoint rejects refuses before sizing or sending", async () => {
    store.set("openrouter:acct-a", "sk-synthetic-a1");
    answers.set("sk-synthetic-a1", [{ window: 50_000 }]);
    answers.set("sk-synthetic-a2", [401]);
    const r = route(accountA);
    await r.admit();
    store.set("openrouter:acct-a", "sk-synthetic-a2");
    await expect(r.dispatch()).rejects.toBeInstanceOf(ModelCatalogUnavailableError);
    expect(r.sized).toEqual([]);
    expect(seen.posts).toEqual([]);
  });
});

describe("one spawn sends the key its dispatch read checked (#393 x #147)", () => {
  it("a NAMED key replaced while the packet is prepared: this request keeps the checked key, the next spawn reads the new one", async () => {
    store.set("openrouter:acct-a", "sk-synthetic-a1");
    answers.set("sk-synthetic-a1", [{ window: 50_000 }]);
    answers.set("sk-synthetic-a2", [{ window: 64_000 }]);
    const r = route(accountA);
    await r.admit();
    await r.dispatch(() => store.set("openrouter:acct-a", "sk-synthetic-a2"));
    expect(seen.gets).toEqual(["sk-synthetic-a1", "sk-synthetic-a1"]);
    expect(seen.posts).toEqual(["sk-synthetic-a1"]);
    expect(r.sized).toEqual([expect.objectContaining({ contextWindow: 50_000 })]);
    await r.dispatch();
    expect(seen.gets.at(-1)).toBe("sk-synthetic-a2");
    expect(seen.posts).toEqual(["sk-synthetic-a1", "sk-synthetic-a2"]);
    expect(r.sized.at(-1)).toEqual(expect.objectContaining({ contextWindow: 64_000 }));
  });

  it("the DEFAULT key replaced during the dispatch GET: the request carries the key that GET checked", async () => {
    process.env[KEY_ENV] = "sk-synthetic-d1";
    answers.set("sk-synthetic-d1", [{ window: 50_000 }]);
    duringGet = () => {
      if (seen.gets.length === 2) process.env[KEY_ENV] = "sk-synthetic-d2";
    };
    const r = route(null);
    await r.admit();
    await r.dispatch();
    expect(seen.gets).toEqual(["sk-synthetic-d1", "sk-synthetic-d1"]);
    expect(seen.posts).toEqual(["sk-synthetic-d1"]);
  });

  it("a failed dispatch read answered by the same key's earlier read keeps that key for the request", async () => {
    store.set("openrouter:acct-a", "sk-synthetic-a1");
    answers.set("sk-synthetic-a1", [{ window: 50_000 }, 503]);
    const r = route(accountA);
    await r.admit();
    await r.dispatch(() => store.set("openrouter:acct-a", "sk-synthetic-a2"));
    expect(r.sized).toEqual([expect.objectContaining({ contextWindow: 50_000 })]);
    expect(r.notes[0]).toContain(`at dispatch; ${EARLIER}`);
    expect(seen.posts).toEqual(["sk-synthetic-a1"]);
  });
});
