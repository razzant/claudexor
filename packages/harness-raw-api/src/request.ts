import type {
  HarnessModel,
  HarnessRunSpec,
  ModelRoutingVariant,
  RawContextBudget,
} from "@claudexor/schema";
import type { RawRequestCapacity } from "@claudexor/core";
import { catalogRowFor, readVerifiedAttachmentBytes } from "@claudexor/core";

/** Tokens kept free for the answer when the catalog declares no completion
 * limit (#147). No `max_tokens` is sent: this only reserves room in the window. */
export const RAW_API_DEFAULT_OUTPUT_ALLOWANCE_TOKENS = 16_384;
/** Estimated tokens per inline image part. Images are not chars/4 text; this
 * is an approximate, disclosed figure, never a provider's tokenizer count. */
export const RAW_API_IMAGE_TOKEN_ESTIMATE = 1_600;

type Content = string | Array<Record<string, unknown>>;
type Message = { role: "system" | "user"; content: Content };

export function patchIntent(spec: Pick<HarnessRunSpec, "intent">): boolean {
  return spec.intent === "implement" || spec.intent === "synthesize";
}

/** The patch protocol around the packet; `packetJson` is the packet as sent. */
function patchPrompt(prompt: string, packetJson: string): string {
  return [
    prompt,
    "",
    'Produce the requested change only by returning one JSON object: {"patch":"<complete textual git unified diff>"}.',
    "The patch applies to readable_files exactly as given here: they are the candidate as it stands now, including any earlier revision.",
    "Touch existing files only from editable_paths. New paths are allowed only below creatable_roots.",
    "Do not calculate hashes or preimage evidence; the trusted local adapter derives them. Do not use Markdown fences or add prose. Binary patches are unsupported.",
    "RAW_CONTEXT_PACKET:",
    packetJson,
  ].join("\n");
}

function attachmentHeader(a: HarnessRunSpec["attachments"][number]): string {
  return `Attached file ${a.name || a.resource_id} (${a.mime}, ${a.sha256}):\n`;
}

/** Build the chat-completions content from digest-bound immutable resources. */
function rawApiUserContent(spec: HarnessRunSpec): Content {
  const prompt =
    patchIntent(spec) && spec.raw_context_packet
      ? patchPrompt(spec.prompt, JSON.stringify(spec.raw_context_packet))
      : spec.prompt;
  const attachments = spec.attachments ?? [];
  if (attachments.length === 0) return prompt;
  const parts: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const a of attachments) {
    const bytes = readVerifiedAttachmentBytes(a);
    parts.push(
      a.kind === "image"
        ? {
            type: "image_url",
            image_url: { url: `data:${a.mime};base64,${bytes.toString("base64")}` },
          }
        : { type: "text", text: `${attachmentHeader(a)}${bytes.toString("utf8")}` },
    );
  }
  return parts.length > 1 ? parts : prompt;
}

/** The exact messages the request sends: one renderer for POST and estimates. */
export function rawApiMessages(spec: HarnessRunSpec): Message[] {
  return [
    // Per-run instructions ride the OpenAI-style `system` role (the engine
    // already withheld them from synthesis/reviewers).
    ...(spec.instructions && spec.instructions.trim()
      ? [{ role: "system" as const, content: spec.instructions }]
      : []),
    { role: "user", content: rawApiUserContent(spec) },
  ];
}

function estimate(chars: number, images: number): number {
  return Math.ceil(chars / 4) + images * RAW_API_IMAGE_TOKEN_ESTIMATE;
}

/** Estimated tokens of the text the model receives (chars/4) plus images. */
export function estimateMessageTokens(messages: readonly Message[]): number {
  let chars = 0;
  let images = 0;
  for (const { content } of messages) {
    if (typeof content === "string") chars += content.length;
    else
      for (const part of content) {
        if (typeof part["text"] === "string") chars += part["text"].length;
        else images += 1;
      }
  }
  return estimate(chars, images);
}

/** Estimated tokens the request spends outside its packet, read from the spec
 * without the packet or attachment bytes: a text attachment's byte length bounds
 * its decoded characters, so this never undercounts the final rendering. */
export function estimateFramingTokens(spec: HarnessRunSpec): number {
  const instructions = spec.instructions?.trim() ? spec.instructions.length : 0;
  const prompt = patchIntent(spec) ? patchPrompt(spec.prompt, "").length : spec.prompt.length;
  let chars = instructions + prompt;
  let images = 0;
  for (const a of spec.attachments ?? []) {
    if (a.kind === "image") images += 1;
    else chars += attachmentHeader(a).length + a.size_bytes;
  }
  return estimate(chars, images);
}

/** #147 output allowance: the catalog's declared completion limit when known,
 * else the documented default, and never more than half a known window — a
 * catalog that declares a completion limit equal to the window would otherwise
 * leave no room for any input. */
export function rawApiOutputAllowance(
  row: HarnessModel | null,
  contextWindow: number | null,
): { tokens: number; source: "catalog" | "default" } {
  const declared = row?.max_output_tokens ?? null;
  const wanted = declared ?? RAW_API_DEFAULT_OUTPUT_ALLOWANCE_TOKENS;
  return {
    tokens: contextWindow === null ? wanted : Math.min(wanted, Math.floor(contextWindow / 2)),
    source: declared === null ? "default" : "catalog",
  };
}

/** Capacity of `spec`'s request from `catalog`, the rows the dispatch gate
 * read under the credential identity `run()` uses. A failed read ([]) or a
 * missing row leaves the window unknown; it never refuses anything by itself. */
export function rawApiRequestCapacity(
  spec: HarnessRunSpec,
  model: string,
  routingVariants: readonly ModelRoutingVariant[],
  catalog: readonly HarnessModel[],
): RawRequestCapacity {
  const row = catalogRowFor(model, catalog, routingVariants);
  const contextWindow = row?.context_window ?? null;
  const allowance = rawApiOutputAllowance(row, contextWindow);
  return {
    model,
    contextWindow,
    outputAllowance: allowance.tokens,
    outputAllowanceSource: allowance.source,
    framingTokens: estimateFramingTokens(spec),
  };
}

/**
 * Catalog input modalities are declared metadata that refuse no request,
 * consistent with the #435 rule for model-operation catalogs (#146). When a
 * successful catalog lists this model's modalities without "image" and an
 * image is attached, the run says so once and the provider decides; unknown
 * modalities say nothing. Refusing on an explicitly listed exclusion would be
 * a change of this one function's verdict and its call site in `run()`.
 */
export function imageInputDisclosure(model: string, row: HarnessModel | null): string | null {
  const modalities = row?.input_modalities;
  if (!modalities || modalities.includes("image")) return null;
  return `the model catalog does not list image input for "${model}" (input modalities: ${modalities.join(", ")}); the image is sent unchanged and the provider decides`;
}

/** The pre-POST window check against the budget the packet was sized under:
 * a refusal text when the final rendering cannot fit that KNOWN window. */
export function finalWindowRefusal(
  budget: RawContextBudget | undefined,
  model: string,
  estimatedTokens: number,
): string | null {
  if (budget?.basis !== "model_context_window" || budget.model !== model) return null;
  const window = budget.context_window;
  const allowance = budget.output_allowance_tokens;
  if (window === null || allowance === null || estimatedTokens + allowance <= window) return null;
  return `raw_context_exceeds_window: the request for "${model}" is estimated at ${estimatedTokens} tokens (chars/4) and ${allowance} more are reserved for the answer, over its ${window}-token context window; this request was not sent`;
}

/** One status line saying how the packet was sized (estimates disclosed). */
export function rawContextDisclosure(
  budget: RawContextBudget,
  model: string,
  estimatedTokens: number,
): string {
  const omitted =
    budget.omitted_for_budget > 0
      ? `; ${budget.omitted_for_budget} optional file(s) omitted for the budget are listed in the packet omissions`
      : "";
  const mandatory =
    budget.mandatory_paths.length > 0
      ? `; mandatory files included complete: ${budget.mandatory_paths.join(", ")}`
      : "";
  if (budget.basis === "model_context_window" && budget.model !== model)
    return `raw context was sized for "${budget.model}" (${budget.context_window}-token window), but this request names "${model}", whose window was not checked; request estimated at ${estimatedTokens} tokens (chars/4)${omitted}${mandatory}`;
  return budget.basis === "model_context_window"
    ? `raw context sized for "${budget.model}": request estimated at ${estimatedTokens} tokens (chars/4) with ${budget.output_allowance_tokens} reserved for the answer, within its ${budget.context_window}-token context window${omitted}${mandatory}`
    : `raw context: no context window is known for ${budget.model ? `"${budget.model}"` : "this request"}, so optional file contents were selected under an assumed ${budget.selection_limit_tokens}-token ceiling that is not a model fact; request estimated at ${estimatedTokens} tokens (chars/4)${omitted}${mandatory}`;
}
