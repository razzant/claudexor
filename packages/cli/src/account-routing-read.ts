import { ControlAccountRoutingEvidenceResponse } from "@claudexor/schema";

/** The additive routing-evidence read joined beside an Accounts listing. */
export type RoutingEvidenceRead = {
  routingEvidence?: ControlAccountRoutingEvidenceResponse;
  routingEvidenceProblem?: string;
};

/** The opt-in queries, newest first: an engine that predates a query rejects
 * it with 400, so each step drops the newest one. */
const ROUTING_EVIDENCE_PATHS = [
  "/accounts/routing-evidence?includeCapabilities=true&includeCredentialUnusable=true",
  "/accounts/routing-evidence?includeCapabilities=true",
  "/accounts/routing-evidence",
];

/**
 * `GET /v2/accounts/routing-evidence` beside the primary listing, asking for the
 * capability marks and the model-scoped credential refusals. An engine that
 * predates the read answers 404: nothing new is shown; one that predates a
 * query answers 400 and is read again without the newest query. Any other
 * failure keeps the listing authoritative and adds one diagnostic; it never
 * fails the listing. `get` throws an error carrying the HTTP `status`.
 */
export async function readRoutingEvidence(
  get: (path: string) => Promise<unknown>,
): Promise<RoutingEvidenceRead> {
  try {
    const read = async (index: number): Promise<unknown> =>
      get(ROUTING_EVIDENCE_PATHS[index]!).catch((error: unknown) => {
        const older = index + 1 < ROUTING_EVIDENCE_PATHS.length;
        if (!older || (error as { status?: unknown } | null)?.status !== 400) throw error;
        return read(index + 1);
      });
    const parsed = ControlAccountRoutingEvidenceResponse.safeParse(await read(0));
    return parsed.success
      ? { routingEvidence: parsed.data }
      : {
          routingEvidenceProblem:
            "routing evidence unavailable: the response did not match its schema",
        };
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 404) return {};
    const reason = error instanceof Error ? error.message : String(error);
    return { routingEvidenceProblem: `routing evidence unavailable: ${reason}` };
  }
}

/** One account row's model-scoped evidence: live refusal/capability marks, its
 * live model-scoped credential refusals and its latest service per requested
 * model. Service is a routing observation, never a quota or authentication
 * verdict; a model-scoped refusal is dated evidence, never the row's status. */
export function routingEvidenceLines(
  read: RoutingEvidenceRead,
  harnessId: string,
  profileId: string,
  now = Date.now(),
): string[] {
  const evidence = read.routingEvidence;
  if (!evidence) return [];
  const model = (requested: string | null) => requested ?? "default model";
  const mine = <T extends { harness_id: string; profile_id: string }>(rows: readonly T[]) =>
    rows.filter((row) => row.harness_id === harnessId && row.profile_id === profileId);
  const live = <T extends { expires_at: string }>(rows: readonly T[]) =>
    rows.filter((row) => Date.parse(row.expires_at) > now);
  return [
    ...mine(evidence.capabilities ?? []).map(
      (mark) =>
        `model capability · ${mark.requested_model} · ${mark.state} · since ${mark.observed_at}, next probe ${mark.expires_at} · ${mark.provider_reason.length > 160 ? mark.provider_reason.slice(0, 159) + "…" : mark.provider_reason}`,
    ),
    ...live(mine(evidence.credentialUnusable ?? [])).map(
      (mark) =>
        `recent refusal · ${mark.model} · ${mark.code}${mark.detail ? ` (${mark.detail})` : ""} · observed ${mark.observed_at}, expires ${mark.expires_at}`,
    ),
    ...live(mine(evidence.refusals)).map(
      (mark) =>
        `recent refusal · ${model(mark.requested_model)} · observed ${mark.observed_at}, expires ${mark.expires_at}`,
    ),
    ...mine(evidence.lastService).map(
      (service) => `last served · ${model(service.requested_model)} · ${service.observed_at}`,
    ),
  ];
}
