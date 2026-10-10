/** Wire-stable projection for durable idempotency request digests.
 *
 * Request digests are hashed from the PARSED request, so a schema field that
 * parses in with an injected default changes the digest of byte-identical
 * wire requests across an engine upgrade: replaying the same Idempotency-Key
 * after the upgrade would then 409 (`idempotency_conflict`) instead of
 * returning the original handle. 3.3.7 added exactly two such fields —
 * `execution.delegated` and project `scope.ephemeral` — that neither
 * published 3.2.1 nor 3.3.7-rc.0 parsed, so their records hold digests
 * without those properties. Before hashing, strip those fields while they
 * still carry their injected default, reproducing the exact shape earlier
 * engines hashed; an explicit `true` is semantic and stays in the digest.
 *
 * INVARIANT: every future request field that parses in with a default MUST be
 * elided here in the same release that adds it, or upgrade replays break again.
 */
export function idempotencyWireProjection(request: unknown): unknown {
  if (!request || typeof request !== "object" || Array.isArray(request)) return request;
  let out = request as Record<string, unknown>;
  const execution = out["execution"];
  if (execution && typeof execution === "object" && !Array.isArray(execution)) {
    const { delegated, ...rest } = execution as Record<string, unknown>;
    if (delegated === false) out = { ...out, execution: rest };
  }
  const scope = out["scope"];
  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    const { ephemeral, ...rest } = scope as Record<string, unknown>;
    if ((scope as Record<string, unknown>)["kind"] === "project" && ephemeral === false) {
      out = { ...out, scope: rest };
    }
  }
  return out;
}
