import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AccountResets,
  type AccountResetBinding,
  type CommandStorePort,
  type QuotaRegistry,
} from "@claudexor/daemon";
import type {
  AccountTarget,
  ControlAccountResetRequest,
  ControlAccountResetResponse,
} from "@claudexor/schema";
import { sha256 } from "@claudexor/util";
import {
  readClaudeOauthCredential,
  readClaudeOauthOrganization,
} from "./claude-oauth-credential.js";
import { accountManagementTarget } from "./account-management.js";
import { requestCodexAccount } from "./codex-quota-source.js";
import { claudeResourceRequest } from "./claude-resource-transport.js";
import { accountResourcesResponse } from "./quota-services.js";

async function nativeIdentity(target: AccountTarget) {
  const { locator } = accountManagementTarget(target);
  if (target.harness === "claude") {
    const organization = await readClaudeOauthOrganization(locator);
    if (!organization)
      throw Object.assign(new Error("Native organization binding is unavailable"), {
        status: 409,
        code: "account_binding_unavailable",
      });
    return {
      locator,
      fingerprint: sha256(JSON.stringify(organization)),
      organization: organization.organizationUuid,
    };
  }
  let data: { tokens?: { account_id?: unknown; id_token?: unknown } };
  try {
    data = JSON.parse(await readFile(join(locator, "auth.json"), "utf8"));
  } catch {
    throw Object.assign(new Error("Native account binding is unavailable"), {
      status: 409,
      code: "account_binding_unavailable",
    });
  }
  const account = data.tokens?.account_id;
  if (typeof account !== "string" || !account)
    throw Object.assign(new Error("Native account identity is unavailable"), {
      status: 409,
      code: "account_binding_unavailable",
    });
  // Subject claim is stable across token refresh, unlike the token bytes.
  let principal: string | null = null;
  try {
    const token = data.tokens?.id_token;
    if (typeof token === "string") {
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
      principal = typeof claims.sub === "string" ? claims.sub : null;
    }
  } catch {
    /* account id is still provider-owned binding */
  }
  return { locator, fingerprint: sha256(JSON.stringify([account, principal])), organization: null };
}

export function accountResetServices(
  commands: { current(): CommandStorePort },
  quota: { current(): QuotaRegistry },
) {
  const operations = new AccountResets({
    commands: () => commands.current(),
    resolve: async (request) => {
      const identity = await nativeIdentity(request.target);
      const programs: Record<string, { harness: string; program: string }> = {
        codex_granted: { harness: "codex", program: "rate_limit_reset_credit" },
        claude_granted: { harness: "claude", program: "cedar_ember" },
        claude_session_refill: { harness: "claude", program: "juniper_tide" },
      };
      const program = programs[request.offer_id];
      if (!program || program.harness !== request.target.harness)
        throw Object.assign(new Error("Unknown reset offer for this account"), {
          status: 400,
          code: "account_reset_offer_invalid",
        });
      const offer = quota
        .current()
        .readResources()
        .find(
          (row) =>
            row.target.harness === request.target.harness &&
            row.target.profile_id === request.target.profile_id,
        )
        ?.resets.value?.find((offer) => offer.id === request.offer_id);
      const grant =
        request.grant_id ?? offer?.grants?.find((grant) => grant.usable_now === true)?.id ?? null;
      if (program.program === "cedar_ember" && !grant)
        throw Object.assign(
          new Error("A native grant id is required; refresh this account or provide its grant id"),
          { status: 400, code: "account_reset_grant_required" },
        );
      if (program.program === "juniper_tide" && request.grant_id)
        throw Object.assign(new Error("Session refill does not accept a grant id"), {
          status: 400,
          code: "account_reset_grant_invalid",
        });
      return {
        harness: program.harness,
        locator: identity.locator,
        fingerprint: identity.fingerprint,
        program: program.program,
        grant_id: grant,
        native_request_id: randomUUID(),
      };
    },
    verify: async (binding, target) => {
      const identity = await nativeIdentity(target);
      if (identity.locator !== binding.locator || identity.fingerprint !== binding.fingerprint)
        throw Object.assign(new Error("The reset operation's native account binding changed"), {
          status: 409,
          code: "account_binding_changed",
        });
    },
    consume: consumeNativeReset,
    read: () => accountResourcesResponse(quota.current()),
    invalidate: (target) => quota.current().invalidateAccountResources(target),
    refresh: async (target, mayHaveChanged) => {
      const result = await quota.current().refreshResources(target, true, mayHaveChanged);
      return accountResourcesResponse(quota.current(), result, result.resources);
    },
  });
  return {
    createAccountReset: (input: {
      request: ControlAccountResetRequest;
      idempotencyKey: string;
      clientId: string;
    }) => operations.create(input),
    accountReset: async (id: string) => operations.get(id),
  };
}

export async function consumeNativeReset(
  binding: AccountResetBinding,
): Promise<Pick<ControlAccountResetResponse, "outcome" | "detail">> {
  let value: unknown;
  if (binding.harness === "codex")
    value = await requestCodexAccount(
      binding.locator,
      undefined,
      undefined,
      undefined,
      undefined,
      "account/rateLimitResetCredit/consume",
      {
        idempotencyKey: binding.native_request_id,
        ...(binding.grant_id ? { creditId: binding.grant_id } : {}),
      },
    );
  else {
    const credential = await readClaudeOauthCredential(binding.locator);
    const organization = await readClaudeOauthOrganization(binding.locator);
    if (!credential || !organization)
      return { outcome: "unavailable", detail: "native_credential_unavailable" };
    try {
      value = await claudeResourceRequest(
        `/api/organizations/${encodeURIComponent(organization.organizationUuid)}/reset_rate_limits`,
        credential.accessToken,
        {
          body:
            binding.program === "cedar_ember"
              ? {
                  program: binding.program,
                  grant_id: binding.grant_id,
                  request_id: binding.native_request_id,
                }
              : { program: binding.program },
        },
      );
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      if (
        typeof status === "number" &&
        Number.isInteger(status) &&
        status >= 100 &&
        status <= 599
      ) {
        return {
          outcome: "unknown",
          detail: `Provider returned HTTP ${status}; reset outcome is unconfirmed`,
        };
      }
      throw error;
    }
  }
  return nativeResetOutcome(binding.harness, value);
}

export function nativeResetOutcome(
  harness: string,
  value: unknown,
): Pick<ControlAccountResetResponse, "outcome" | "detail"> {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const mapping: Record<string, ControlAccountResetResponse["outcome"]> =
    harness === "codex"
      ? {
          reset: "reset",
          alreadyRedeemed: "already_redeemed",
          nothingToReset: "nothing_to_reset",
          noCredit: "no_credit",
        }
      : {
          reset: "reset",
          already_used: "already_used",
          not_limited: "nothing_to_reset",
          ineligible: "not_eligible",
          cooldown: "cooldown",
          unavailable: "unavailable",
        };
  const native = row[harness === "codex" ? "outcome" : "result"];
  const outcome = typeof native === "string" ? (mapping[native] ?? "unknown") : "unknown";
  return {
    outcome,
    detail:
      outcome === "unknown"
        ? "provider_outcome_unconfirmed"
        : outcome === "already_used"
          ? "grant_used_ownership_unconfirmed"
          : null,
  };
}
