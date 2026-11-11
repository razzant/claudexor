import { z } from "zod/v3";
import { AccessProfile, ExternalContextPolicy } from "./primitives.js";
import { RouteAccessMechanism, WebPolicySupport } from "./route-controls.js";
import { WebObservation } from "./web-evidence.js";

export const ControlWebEvidence = z
  .object({
    required: z.boolean().default(false).describe("Explicit stored web requirement."),
    /** Requested external-context policy for the run. */
    mode: ExternalContextPolicy.default("auto").describe(
      "Requested external-context policy for the run.",
    ),
    /** Mode given to the selected route (disclosed upgrades, e.g. claude cached->live). */
    effectiveMode: ExternalContextPolicy.default("auto").describe(
      "Policy given to the selected route, after disclosed upgrades (e.g. cached to live); not proof that a native session ran.",
    ),
    attempted: z
      .boolean()
      .default(false)
      .describe(
        "Whether a web tool call or engine Browser call was observed; not a network measurement.",
      ),
    satisfied: z
      .boolean()
      .default(false)
      .describe("Completed without a typed failure; retrieved content is not necessarily proven."),
    status: z
      .enum(["none", "attempted", "satisfied", "failed", "unverified"])
      .default("none")
      .describe("Observed web status; satisfied does not prove retrieved content was verified."),
    verification: z
      .enum(["verified", "dispatched", "none"])
      .default("none")
      .describe(
        "Retrieval-proof strength: verified when a typed result shows a retrieval (verifiedContent says of what); dispatched when a web call completed without one; none when no search or page retrieval was observed, though a Browser action may have completed.",
      ),
    verifiedContent: z
      .enum(["page", "search_results"])
      .nullable()
      .default(null)
      .describe(
        "What the verified retrieval returned: page (a fetched or loaded page) or search_results (a web search's results, not a fetched page); null when nothing was verified or the engine did not record it.",
      ),
    observation: WebObservation.nullable()
      .default(null)
      .describe(
        "What the evidence covers (tool calls; network not measured); null when no telemetry was recorded.",
      ),
    tool: z
      .string()
      .nullable()
      .default(null)
      .describe("Web tool that produced the evidence, when any."),
    target: z
      .string()
      .nullable()
      .default(null)
      .describe("Target (query/url) of the web activity as issued, when any."),
    errorSummary: z
      .string()
      .nullable()
      .default(null)
      .describe("Redacted error detail when web activity failed."),
    rawDetailRef: z
      .string()
      .nullable()
      .default(null)
      .describe("Artifact path holding the full evidence record."),
    /** False when the run predates telemetry.yaml; surfaces must render "telemetry unavailable". */
    available: z
      .boolean()
      .default(true)
      .describe(
        'False when the run predates the telemetry artifact; surfaces must render "telemetry unavailable".',
      ),
  })
  .describe("Web evidence projected onto a run summary from the telemetry artifact.");
export type ControlWebEvidence = z.infer<typeof ControlWebEvidence>;

/** The selected Browser's startup on a route, as its adapter reported it (#215). */
const ControlBrowserStartup = z
  .object({
    status: z
      .enum(["ready", "failed", "cancelled", "starting", "not_observed"])
      .describe(
        "Startup state when the first model request was allowed: ready (Codex reported the server started), failed, cancelled, starting (still starting when the hold ended: Codex's 90 s limit plus a 5 s grace for its status), or not_observed (no startup status at all).",
      ),
    waitedMs: z
      .number()
      .int()
      .nonnegative()
      .describe("How long the first model request was held for this outcome."),
    error: z
      .string()
      .nullable()
      .describe("The vendor's own reason for a failed or cancelled startup, masked."),
  })
  .describe("The selected Browser's reported startup outcome on one route (#215).");

/** One distinct route of a run: the native controls prepared for its spawns and
 * whether a native session was reported started (#118, #413), projected from
 * telemetry and never inferred for older records. */
export const ControlRouteControl = z
  .object({
    harnessId: z.string().describe("Harness of the route."),
    webMode: ExternalContextPolicy.describe("Web policy given to the route."),
    webMechanism: WebPolicySupport.describe("How the route's own web tools are switched."),
    browser: z
      .boolean()
      .describe(
        "Whether the engine Browser MCP was handed to the route (prepared; not a connection).",
      ),
    browserStartup: ControlBrowserStartup.nullable()
      .default(null)
      .describe(
        "The Browser's startup as the route reported it before the first model request; null when it reported none, so an armed Browser was only prepared.",
      ),
    access: AccessProfile.describe("Access profile handed to the route."),
    nativeAccess: z
      .string()
      .nullable()
      .describe("The vendor access setting prepared for the route; null when none or undisclosed."),
    accessMechanism: RouteAccessMechanism,
    nativeSessionStarted: z
      .boolean()
      .describe(
        "Whether an adapter reported a native session started under these controls. False means none was observed (refused before launch, or stopped or ended before a start was reported); it does not prove that no process ran.",
      ),
    homeScoped: z
      .boolean()
      .nullable()
      .describe(
        "Applied HOME fact: true when the engine assigned the child a Claudexor-owned HOME, false when the engine did not replace HOME, so the child inherits the engine's own environment; null when the route recorded none.",
      ),
  })
  .describe(
    "Native web and access controls prepared for one route of the run; Claudexor adds no outer boundary.",
  );
export type ControlRouteControl = z.infer<typeof ControlRouteControl>;
