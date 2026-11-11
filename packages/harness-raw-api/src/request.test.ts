import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@claudexor/secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@claudexor/secrets")>()),
  resolveSecret: () => null,
}));

import {
  HarnessEvent,
  HarnessRunSpec,
  type HarnessModel,
  type RawContextPacket,
} from "@claudexor/schema";
import { withDispatchModelCatalog, type HarnessAdapter } from "@claudexor/core";
import { createRawApiAdapter } from "./index.js";
import {
  RAW_API_DEFAULT_OUTPUT_ALLOWANCE_TOKENS,
  RAW_API_IMAGE_TOKEN_ESTIMATE,
  estimateFramingTokens,
  estimateMessageTokens,
  rawApiMessages,
} from "./request.js";

const ORIGINAL_ENV = { ...process.env };
const ROUTER = {
  id: "openrouter",
  baseUrl: "https://router.test/api/v1",
  keyEnv: "ROUTER_KEY",
  defaultModel: "vendor/default",
  routingVariants: [
    { suffix: ":nitro", billing: "service_tier" as const },
    { suffix: ":exacto", billing: "base" as const },
  ],
};
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

/** A fake OpenRouter: GET /models answers `catalog`, POST answers `content`. */
function fakeRouter(catalog: unknown, content = "done", finishReason = "stop") {
  const posts: Array<Record<string, any>> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "GET") {
      return catalog instanceof Response
        ? catalog
        : new Response(JSON.stringify(catalog), { status: 200 });
    }
    posts.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        model: "vendor/served",
        choices: [{ message: { content }, finish_reason: finishReason }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    posts,
    gets: () => fetchMock.mock.calls.filter((c) => c[1]?.method === "GET"),
  };
}

function image(): HarnessRunSpec["attachments"][number] {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-raw-image-"));
  dirs.push(dir);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const path = join(dir, "shot.png");
  writeFileSync(path, bytes);
  return {
    resource_id: "res-shot",
    kind: "image",
    mime: "image/png",
    name: "shot.png",
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size_bytes: bytes.length,
    path,
  };
}

function spec(fields: Record<string, unknown>) {
  return HarnessRunSpec.parse({
    session_id: "s-request",
    intent: "explain",
    prompt: "describe it",
    cwd: process.cwd(),
    access: "readonly",
    ...fields,
  });
}

function packet(budget: RawContextPacket["budget"]): RawContextPacket {
  return {
    schema_version: 1,
    packet_hash: "sha256:packet",
    ...(budget ? { budget } : {}),
    base_commit_sha: "commit",
    base_tree_sha: "tree",
    readable_files: [
      {
        path: "a.txt",
        mode: "100644",
        blob_oid: "blob",
        content_hash: "sha256:a",
        content: "old\n",
      },
    ],
    editable_paths: ["a.txt"],
    creatable_roots: ["."],
    file_manifest: [{ path: "a.txt", disposition: "full" }],
    omissions: [],
    evidence_refs: ["git:tree:a.txt:blob"],
  };
}

function budget(overrides: Partial<NonNullable<RawContextPacket["budget"]>> = {}) {
  return {
    estimator: "chars_div_4" as const,
    basis: "model_context_window" as const,
    model: "vendor/small",
    context_window: 100_000,
    output_allowance_tokens: 1_000,
    framing_tokens: 200,
    selection_limit_tokens: 98_800,
    estimated_packet_tokens: 120,
    omitted_for_budget: 2,
    mandatory_paths: ["a.txt"],
    ...overrides,
  };
}

beforeEach(() => {
  process.env.ROUTER_KEY = "sk-env";
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe("declared routing variants (#145)", () => {
  it("surfaces the instance declaration in the manifest and nowhere else", async () => {
    const manifest = await createRawApiAdapter(ROUTER).discover();
    expect(manifest.capabilities.model_routing_variants).toEqual(ROUTER.routingVariants);
    process.env.OPENAI_API_KEY = "sk-generic";
    const generic = await createRawApiAdapter().discover();
    expect(generic.capabilities.model_routing_variants).toBeUndefined();
  });

  it("sends a routing-variant id byte-identical", async () => {
    const router = fakeRouter({ data: [{ id: "vendor/a" }] });
    await collect(createRawApiAdapter(ROUTER).run(spec({ model_hint: "vendor/a:nitro" })));
    expect(router.posts[0]?.model).toBe("vendor/a:nitro");
  });
});

describe("raw request capacity (#147)", () => {
  const row = {
    id: "vendor/small",
    context_length: 32768,
    top_provider: { max_completion_tokens: 4096 },
  };
  /** The rows the dispatch gate hands over: its own typed read of the catalog. */
  async function gateRows(adapter: HarnessAdapter): Promise<HarnessModel[]> {
    const read = await adapter.modelCatalog!();
    return read.status === "listed" ? read.models : [];
  }

  it("takes the window and completion limit from the requested model's row of the gate's read", async () => {
    const router = fakeRouter({ data: [row] });
    const adapter = createRawApiAdapter(ROUTER);
    const run = spec({ intent: "implement", model_hint: "vendor/small", instructions: "be terse" });
    const rows = await gateRows(adapter);
    expect(router.gets()).toHaveLength(1);
    expect(adapter.rawRequestCapacity!(run, rows)).toEqual({
      model: "vendor/small",
      contextWindow: 32768,
      outputAllowance: 4096,
      outputAllowanceSource: "catalog",
      framingTokens: estimateFramingTokens(run),
    });
    // Deriving capacity reads nothing of its own.
    expect(router.gets()).toHaveLength(1);
  });

  it("resolves a routing variant to its listed row and the default model when no hint was given", async () => {
    fakeRouter({ data: [row, { id: "vendor/default", context_length: 8192 }] });
    const adapter = createRawApiAdapter(ROUTER);
    const rows = await gateRows(adapter);
    expect(
      adapter.rawRequestCapacity!(
        spec({ intent: "implement", model_hint: "vendor/small:nitro" }),
        rows,
      ),
    ).toMatchObject({ model: "vendor/small:nitro", contextWindow: 32768, outputAllowance: 4096 });
    // No hint: the adapter default and ITS row; no declared limit -> the
    // documented default, never more than half the window.
    expect(adapter.rawRequestCapacity!(spec({ intent: "implement" }), rows)).toMatchObject({
      model: "vendor/default",
      contextWindow: 8192,
      outputAllowance: Math.min(RAW_API_DEFAULT_OUTPUT_ALLOWANCE_TOKENS, 4096),
      outputAllowanceSource: "default",
    });
  });

  it("leaves the window unknown for an unlisted id, a catalog variant that is not listed, or a failed read", async () => {
    fakeRouter({ data: [row] });
    const adapter = createRawApiAdapter(ROUTER);
    const rows = await gateRows(adapter);
    for (const model of ["vendor/other", "vendor/small:free:nitro", "vendor/small:online"])
      expect(
        adapter.rawRequestCapacity!(spec({ intent: "implement", model_hint: model }), rows),
      ).toMatchObject({
        contextWindow: null,
        outputAllowance: RAW_API_DEFAULT_OUTPUT_ALLOWANCE_TOKENS,
      });
    // A failed gate read hands no rows.
    fakeRouter(new Response("down", { status: 503 }));
    expect(
      adapter.rawRequestCapacity!(
        spec({ intent: "implement", model_hint: "vendor/small" }),
        await gateRows(adapter),
      ),
    ).toMatchObject({ contextWindow: null, outputAllowanceSource: "default" });
  });

  it("caps a declared completion limit that equals the window at half of it", async () => {
    fakeRouter({
      data: [
        {
          id: "vendor/wide",
          context_length: 131072,
          top_provider: { max_completion_tokens: 131072 },
        },
      ],
    });
    const adapter = createRawApiAdapter(ROUTER);
    expect(
      adapter.rawRequestCapacity!(
        spec({ intent: "implement", model_hint: "vendor/wide" }),
        await gateRows(adapter),
      ),
    ).toMatchObject({ outputAllowance: 65536, outputAllowanceSource: "catalog" });
  });

  it("counts instructions, user text, protocol and attachments as framing, never under the final rendering", () => {
    const bare = spec({ intent: "implement", prompt: "x" });
    const rich = spec({
      intent: "implement",
      prompt: "x",
      instructions: "i".repeat(400),
      attachments: [image()],
    });
    expect(estimateFramingTokens(rich) - estimateFramingTokens(bare)).toBe(
      100 + RAW_API_IMAGE_TOKEN_ESTIMATE,
    );
    const withPacket = { ...rich, raw_context_packet: packet(budget()) };
    const packetTokens = Math.ceil(JSON.stringify(withPacket.raw_context_packet).length / 4);
    expect(estimateMessageTokens(rawApiMessages(withPacket))).toBeLessThanOrEqual(
      estimateFramingTokens(rich) + packetTokens,
    );
  });
});

describe("raw request pre-POST checks and disclosures", () => {
  it("refuses a patch request that outgrew its KNOWN window, before sending", async () => {
    const router = fakeRouter({ data: [] });
    const events = await collect(
      createRawApiAdapter(ROUTER).run(
        spec({
          intent: "implement",
          model_hint: "vendor/small",
          prompt: "p".repeat(4000),
          raw_context_packet: packet(
            budget({ context_window: 1500, output_allowance_tokens: 500 }),
          ),
        }),
      ),
    );
    expect(events.map((event) => event.type)).toEqual(["started", "error", "completed"]);
    const error = events[1]!;
    expect(error.refusal_code).toBe("raw_context_exceeds_window");
    expect(error.error).toContain("over its 1500-token context window; this request was not sent");
    expect(router.fetchMock).not.toHaveBeenCalled();
    expect(events.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);
  });

  it("discloses how the packet was sized, then sends", async () => {
    const router = fakeRouter({ data: [] }, JSON.stringify({ patch: "x" }));
    const events = await collect(
      createRawApiAdapter(ROUTER).run(
        spec({
          intent: "implement",
          model_hint: "vendor/small",
          raw_context_packet: packet(budget()),
        }),
      ),
    );
    const sized = events.find((event) => event.type === "status");
    const status = sized?.text ?? "";
    expect(status).toMatch(
      /^raw context sized for "vendor\/small": request estimated at \d+ tokens \(chars\/4\) with 1000 reserved for the answer, within its 100000-token context window; 2 optional file\(s\) omitted for the budget are listed in the packet omissions; mandatory files included complete: a\.txt$/,
    );
    // The same facts ride the event typed (#147): no consumer reads the sentence.
    const estimated = Number(/estimated at (\d+) tokens/.exec(status)?.[1]);
    expect(sized?.raw_context).toEqual({
      model: "vendor/small",
      estimated_request_tokens: estimated,
      budget: budget(),
    });
    expect(HarnessEvent.parse(sized).raw_context).toEqual(sized?.raw_context);
    expect(router.posts).toHaveLength(1);

    const unknown = await collect(
      createRawApiAdapter(ROUTER).run(
        spec({
          intent: "implement",
          model_hint: "vendor/small",
          raw_context_packet: packet(
            budget({
              basis: "assumed_ceiling",
              context_window: null,
              selection_limit_tokens: 200_000,
              omitted_for_budget: 0,
              mandatory_paths: [],
            }),
          ),
        }),
      ),
    );
    expect(unknown.find((event) => event.type === "status")?.text).toMatch(
      /^raw context: no context window is known for "vendor\/small", so optional file contents were selected under an assumed 200000-token ceiling that is not a model fact; request estimated at \d+ tokens \(chars\/4\)$/,
    );
  });

  it("types a patch cut at the provider's output limit as truncation", async () => {
    fakeRouter({ data: [] }, '{"patch":"diff --git a/a.txt b/a.txt\\n--- a/a.txt', "length");
    const events = await collect(
      createRawApiAdapter(ROUTER).run(
        spec({ intent: "implement", raw_context_packet: packet(undefined) }),
      ),
    );
    const error = events.find((event) => event.type === "error");
    expect(error?.refusal_code).toBe("raw_patch_truncated");
    expect(error?.payload).toEqual({ finish_reason: "length" });
    expect(error?.error).toContain("finish_reason length");
    expect(events.some((event) => event.type === "patch_produced")).toBe(false);
  });
});

describe("image attachments and catalog modalities (#146)", () => {
  const disclosure = (events: HarnessEvent[]) =>
    events.filter((event) => event.type === "status").map((event) => event.text);

  it("sends the image and discloses once when the catalog lists modalities without image", async () => {
    const router = fakeRouter({
      data: [{ id: "vendor/text", architecture: { input_modalities: ["text"] } }],
    });
    const events = await collect(
      createRawApiAdapter(ROUTER).run(spec({ model_hint: "vendor/text", attachments: [image()] })),
    );
    expect(disclosure(events)).toEqual([
      'the model catalog does not list image input for "vendor/text" (input modalities: text); the image is sent unchanged and the provider decides',
    ]);
    const parts = router.posts[0]?.messages[0].content as Array<{ type: string }>;
    expect(parts.map((part) => part.type)).toEqual(["text", "image_url"]);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("says nothing when image is listed, when modalities are unknown, or when the catalog is unread", async () => {
    for (const catalog of [
      { data: [{ id: "vendor/m", architecture: { input_modalities: ["text", "image"] } }] },
      { data: [{ id: "vendor/m" }] },
      new Response("down", { status: 500 }),
    ]) {
      const router = fakeRouter(catalog);
      const events = await collect(
        createRawApiAdapter(ROUTER).run(spec({ model_hint: "vendor/m", attachments: [image()] })),
      );
      expect(disclosure(events)).toEqual([]);
      expect(router.posts).toHaveLength(1);
    }
  });

  it("judges the adapter default model and a routing variant by their own listed rows", async () => {
    fakeRouter({
      data: [
        { id: "vendor/default", architecture: { input_modalities: ["text"] } },
        { id: "vendor/vision", architecture: { input_modalities: ["image", "text"] } },
      ],
    });
    const adapter = createRawApiAdapter(ROUTER);
    expect(disclosure(await collect(adapter.run(spec({ attachments: [image()] }))))).toHaveLength(
      1,
    );
    expect(
      disclosure(
        await collect(
          adapter.run(spec({ model_hint: "vendor/vision:nitro", attachments: [image()] })),
        ),
      ),
    ).toEqual([]);
  });

  it("reuses the dispatch gate's read for the disclosure and never reads the catalog again", async () => {
    const textOnly: HarnessModel = {
      id: "vendor/text",
      label: null,
      context_window: null,
      routes: null,
      input_modalities: ["text"],
    };
    const router = fakeRouter({
      data: [{ id: "vendor/text", architecture: { input_modalities: ["image", "text"] } }],
    });
    const adapter = createRawApiAdapter(ROUTER);
    const run = spec({ model_hint: "vendor/text", attachments: [image()] });
    const listed = await collect(
      adapter.run(withDispatchModelCatalog(run, { status: "listed", models: [textOnly] })),
    );
    expect(disclosure(listed)).toEqual([
      'the model catalog does not list image input for "vendor/text" (input modalities: text); the image is sent unchanged and the provider decides',
    ]);
    // A failed gate read stays unknown: nothing is said and the image is still sent.
    const failure = { cause: "http_status" as const, httpStatus: 503, detail: "down" };
    const unread = await collect(
      adapter.run(withDispatchModelCatalog(run, { status: "unavailable", failure })),
    );
    expect(disclosure(unread)).toEqual([]);
    expect(router.gets()).toHaveLength(0);
    expect(router.posts).toHaveLength(2);
  });

  it("does not read the catalog for a request without an image", async () => {
    const router = fakeRouter({
      data: [{ id: "vendor/text", architecture: { input_modalities: ["text"] } }],
    });
    await collect(createRawApiAdapter(ROUTER).run(spec({ model_hint: "vendor/text" })));
    expect(router.gets()).toHaveLength(0);
  });
});

describe("a request whose model changed after its packet was sized", () => {
  it("says the window was not checked for the new model instead of claiming it fits", async () => {
    const router = fakeRouter({ data: [] }, JSON.stringify({ patch: "x" }));
    const events = await collect(
      createRawApiAdapter(ROUTER).run(
        spec({
          intent: "implement",
          model_hint: "vendor/other",
          prompt: "p".repeat(4000),
          raw_context_packet: packet(
            budget({ context_window: 1500, output_allowance_tokens: 500 }),
          ),
        }),
      ),
    );
    expect(events.some((event) => event.refusal_code === "raw_context_exceeds_window")).toBe(false);
    expect(events.find((event) => event.type === "status")?.text).toMatch(
      /^raw context was sized for "vendor\/small" \(1500-token window\), but this request names "vendor\/other", whose window was not checked; request estimated at \d+ tokens \(chars\/4\)/,
    );
    expect(router.posts).toHaveLength(1);
  });
});
