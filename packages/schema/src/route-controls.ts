import { z } from "zod/v3";
import { AccessProfile } from "./primitives.js";

/**
 * How a harness can honor the external web policy:
 * - `native`: web modes are a native config surface (codex web_search).
 * - `tools`: web runs through permissioned tools the adapter can allow/deny (claude).
 * - `uncontrolled`: the harness CAN reach the web but exposes no enforceable
 *   switch — incompatible only with strict `off`. cursor/opencode today.
 * - `none`: the harness has NO web access at all — trivially satisfies `off`,
 *   while non-off policies remain optional preferences. raw-api/fake.
 * None of them is a network switch: vendor API traffic always flows, and an
 * allowed shell command can still reach the network.
 */
export const WebPolicySupport = z
  .enum(["native", "tools", "uncontrolled", "none"])
  .describe(
    "How a harness can honor the external web policy: native (a native config surface), tools (permissioned tools the adapter can allow/deny), uncontrolled (can reach the web but exposes no enforceable switch), or none (no web access at all).",
  );
export type WebPolicySupport = z.infer<typeof WebPolicySupport>;

/** The mechanism a manifest declares for whichever profile a spawn passes: the
 * union of `ReadonlyMechanism` and `WriteMechanism` (the receipt builder only
 * compiles while both stay assignable to it), plus what the profile itself says
 * when it asks for no confinement. */
export const RouteAccessMechanism = z
  .enum([
    "fs_sandbox",
    "permission_deny",
    "tool_allowlist",
    "tool_policy",
    "native_settings",
    "none",
  ])
  .describe(
    "How the route's access profile reaches the harness: fs_sandbox (the vendor's own file-system sandbox, as the vendor applies it), permission_deny, tool_allowlist or tool_policy (vendor tool permissions; the manifest declares no OS file boundary), native_settings (inherit_native: Claudexor passes no access profile, so the harness's own configuration decides and what it confines is unknown here), or none (full access, or a route that declares no control).",
  );
export type RouteAccessMechanism = z.infer<typeof RouteAccessMechanism>;

/**
 * What the engine PREPARED for one harness spawn's web and file access (#118,
 * #413): the per-spawn gate records it just before it dispatches the adapter,
 * from the route's manifest and the adapter's own argument helper. It says what
 * the adapter was handed, not that a native process ran with it: the adapter can
 * still refuse before launching, and a stop that lands after dispatch can end it
 * before it reports a start (a stop at the receipt itself prevents the dispatch),
 * so the attempt's `native_session_started` reports the launch separately. Disclosure only:
 * Claudexor adds no network or file boundary, and nothing here changes what the
 * harness receives.
 */
export const RouteControls = z
  .object({
    web_mechanism: WebPolicySupport.describe(
      "How this route's own web tools are switched for its web policy (the manifest's web_policy).",
    ),
    access: AccessProfile.describe("Access profile handed to this spawn."),
    native_access: z
      .string()
      .nullable()
      .describe(
        "The vendor access setting the adapter builds for that profile, in the vendor's own spelling (argv or request parameters) and from the helper that passes it; null when it passes none or does not disclose it.",
      ),
    access_mechanism: RouteAccessMechanism,
  })
  .describe(
    "Per-spawn receipt of the native web and access controls prepared for a route, recorded just before dispatch; not proof that a native process ran with them. Claudexor adds no outer boundary.",
  );
export type RouteControls = z.infer<typeof RouteControls>;
