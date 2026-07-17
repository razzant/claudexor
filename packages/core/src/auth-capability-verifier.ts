import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  AuthCapabilityBinding,
  AuthCapabilityReceipt,
  AuthSmokeDisclosure,
  HarnessEvent,
  HarnessRunSpec as HarnessRunSpecSchema,
  type AuthCapabilityBinding as AuthCapabilityBindingType,
  type AuthCapabilityReceipt as AuthCapabilityReceiptType,
  type AuthRequest,
  type AuthSmokeDisclosure as AuthSmokeDisclosureType,
  type AuthSourceKind,
  type CredentialRoute,
  type HarnessRunSpec,
} from "@claudexor/schema";
import { ensureCanonicalPrivateDirectory } from "@claudexor/util";
import type { AdapterRegistry, HarnessAdapter } from "./adapter.js";
import { AnswerAssembly } from "./answer-assembly.js";

const MAX_RESPONSE_CHARS = 4_096;
const ATTEMPT_ID = /^[A-Za-z0-9-]+$/;

export interface AuthCapabilityPreparationRequest {
  attemptId: string;
  harness: string;
  requested: AuthRequest;
  requiredRoute: CredentialRoute;
  requiredSource: AuthSourceKind;
}

export interface AuthCapabilityPreparation {
  binding: AuthCapabilityBindingType;
}

export interface AuthCapabilityVerificationRequest {
  binding: AuthCapabilityBindingType;
  startedAt: string;
  abortSignal?: AbortSignal;
}

export interface AuthCapabilityVerifierDeps {
  now?: () => Date;
  receiptId?: () => string;
  scratchRoot?: string;
}

/**
 * Executes one ordinary adapter run and reduces only typed normalized events
 * into a redacted exact-route receipt. It owns an external scratch tree, never
 * discovers a second adapter, and never persists model output.
 */
export class AuthCapabilityVerifier {
  private readonly now: () => Date;
  private readonly receiptId: () => string;
  private readonly scratchRoot: string;

  constructor(
    private readonly adapter: (id: string) => HarnessAdapter | undefined,
    deps: AuthCapabilityVerifierDeps = {},
  ) {
    this.now = deps.now ?? (() => new Date());
    this.receiptId = deps.receiptId ?? (() => `authcap-${randomUUID()}`);
    this.scratchRoot = resolve(
      deps.scratchRoot ?? join(realpathSync(tmpdir()), "claudexor-auth-smokes"),
    );
  }

  static fromRegistry(
    registry: AdapterRegistry,
    deps: AuthCapabilityVerifierDeps = {},
  ): AuthCapabilityVerifier {
    return new AuthCapabilityVerifier((id) => registry.get(id), deps);
  }

  disclosure(
    harness: string,
    requested: AuthRequest,
    requiredRoute: CredentialRoute,
    requiredSource: AuthSourceKind,
  ): AuthSmokeDisclosureType {
    return AuthSmokeDisclosure.parse({
      schemaVersion: 1,
      protocolVersion: 1,
      harness,
      requested,
      requiredRoute,
      requiredSource,
      networkScope: "selected_harness_only",
      billingKnowledge: "unknown",
      incrementalCostKnowledge: "unknown",
      mayConsumeQuota: true,
      generatedAt: this.now().toISOString(),
    });
  }

  prepare(request: AuthCapabilityPreparationRequest): AuthCapabilityPreparation {
    if (!ATTEMPT_ID.test(request.attemptId)) throw new Error("invalid auth capability attempt id");
    const disclosure = this.disclosure(
      request.harness,
      request.requested,
      request.requiredRoute,
      request.requiredSource,
    );
    const challengeDigest = sha256(challengeFor(request.attemptId));
    return {
      binding: AuthCapabilityBinding.parse({
        attemptId: request.attemptId,
        challengeDigest,
        requestDigest: capabilityRequestDigest(disclosure, challengeDigest),
        disclosure,
      }),
    };
  }

  async verify(request: AuthCapabilityVerificationRequest): Promise<AuthCapabilityReceiptType> {
    const binding = AuthCapabilityBinding.parse(request.binding);
    const disclosure = binding.disclosure;
    const expected = challengeFor(binding.attemptId);
    const requestMismatch =
      binding.challengeDigest !== sha256(expected) ||
      binding.requestDigest !== capabilityRequestDigest(disclosure, binding.challengeDigest);
    const streamHash = createHash("sha256");
    // The challenge answer follows the engine's typed-finality semantics
    // (AnswerAssembly, W-C1): harnesses narrate the answer mid-run and then
    // repeat it as their typed `final` message — concatenating both would
    // false-fail every compliant run with "expected+expected".
    const answer = new AnswerAssembly();
    let narrationChars = 0;
    let narrationTruncated = false;
    let effective: CredentialRoute | null = null;
    let effectiveSource: AuthSourceKind | null = null;
    let routeConflict = false;
    let sourceConflict = false;
    let startedEvents = 0;
    let completedEvents = 0;
    let errorEvents = 0;
    let unexpectedToolEvents = 0;
    let interactionEvents = 0;
    let sessionMismatchEvents = 0;
    let eventsAfterCompleted = 0;
    let protocolViolation = false;
    let adapterFailed = false;
    let adapterMissing = false;
    let adapterIdentityMismatch = false;
    let cancelled = request.abortSignal?.aborted === true;
    let terminalSeen = false;
    const evidence = new Set<string>();
    const noScratchDigest = sha256("scratch:not-created");
    let scratchBeforeDigest = noScratchDigest;
    let scratchAfterDigest = noScratchDigest;
    let scratchPath: string | null = null;
    let adapter: HarnessAdapter | undefined;

    if (!requestMismatch) {
      try {
        adapter = this.adapter(disclosure.harness);
      } catch {
        adapterFailed = true;
        evidence.add("adapter:lookup_threw");
      }
      if (!adapter && !adapterFailed) adapterMissing = true;
      if (adapter && adapter.id !== disclosure.harness) {
        adapterIdentityMismatch = true;
        evidence.add("adapter:identity_mismatch");
      }
    }

    if (adapter && !adapterIdentityMismatch && !adapterFailed && !requestMismatch && !cancelled) {
      try {
        scratchPath = this.createScratch(binding.attemptId);
        scratchBeforeDigest = fingerprintTree(scratchPath);
        const spec = HarnessRunSpecSchema.parse({
          session_id: `auth-smoke-${binding.attemptId}`,
          intent: "explain",
          prompt: `Return exactly ${expected} and no other text. Do not call tools.`,
          cwd: scratchPath,
          access: "readonly",
          external_context_policy: "off",
          tool_permission_policy: { web: "off", allow: [], deny: [] },
          model_hint: null,
          effort_hint: null,
          max_turns: 1,
          auth_preference: disclosure.requested,
          // The capability smoke proves the DEFAULT credential ladder's route;
          // profile readiness has its own probe (probeCredentialProfile).
          credential_profile: null,
          resume_session_id: null,
          env_inheritance: "clean",
          evidence_policy: "stream_only",
          env: {},
          attachments: [],
          browser: null,
          stream_deltas: false,
          extra: request.abortSignal ? { abortSignal: request.abortSignal } : {},
        } satisfies HarnessRunSpec);
        for await (const raw of adapter.run(spec)) {
          const event = HarnessEvent.parse(raw);
          streamHash.update(
            JSON.stringify({
              type: event.type,
              session: event.session_id,
              route: event.credential_route ?? null,
              source: event.credential_source ?? null,
              aborted: event.aborted ?? false,
              textDigest: event.text === undefined ? null : sha256(event.text),
            }),
          );
          if (terminalSeen) eventsAfterCompleted += 1;
          if (event.session_id !== spec.session_id) {
            sessionMismatchEvents += 1;
            evidence.add("event:session_mismatch");
            continue;
          }
          if (startedEvents === 0 && event.type !== "started") protocolViolation = true;
          switch (event.type) {
            case "started":
              startedEvents += 1;
              if (startedEvents !== 1 || terminalSeen) protocolViolation = true;
              evidence.add("event:started");
              if (event.credential_route) {
                if (effective && effective !== event.credential_route) routeConflict = true;
                effective ??= event.credential_route;
                evidence.add(`credential-route:${event.credential_route}`);
              }
              if (event.credential_source) {
                if (effectiveSource && effectiveSource !== event.credential_source)
                  sourceConflict = true;
                effectiveSource ??= event.credential_source;
                evidence.add(`credential-source:${event.credential_source}`);
              }
              break;
            case "message": {
              // Bound only the retained NARRATION (the no-final fallback); a
              // typed final is a single already-materialized event text and
              // makes narration irrelevant to the comparison.
              const text = event.text ?? "";
              if (event.final !== true) {
                if (narrationChars + text.length > MAX_RESPONSE_CHARS) {
                  narrationTruncated = true;
                  break;
                }
                narrationChars += text.length;
              }
              answer.observe(event);
              break;
            }
            case "error":
              errorEvents += 1;
              evidence.add("event:error");
              break;
            case "interaction_requested":
              interactionEvents += 1;
              evidence.add("event:unexpected_interaction");
              break;
            case "tool_call":
            case "tool_result":
            case "file_change":
              unexpectedToolEvents += 1;
              evidence.add("event:unexpected_tool_activity");
              break;
            case "completed":
              completedEvents += 1;
              terminalSeen = true;
              if (completedEvents !== 1 || event.aborted) protocolViolation = true;
              cancelled ||= event.aborted === true;
              evidence.add("event:completed");
              break;
            default:
              break;
          }
        }
        cancelled ||= request.abortSignal?.aborted === true;
      } catch {
        cancelled ||= request.abortSignal?.aborted === true;
        adapterFailed = !cancelled;
        evidence.add(cancelled ? "adapter:cancelled" : "adapter:threw");
      } finally {
        if (scratchPath) {
          try {
            scratchAfterDigest = fingerprintTree(scratchPath);
          } catch {
            scratchAfterDigest = sha256("scratch:missing-or-unreadable");
          }
        }
      }
    }

    // The digest binds the receipt to the response that was actually COMPARED
    // (typed final verbatim, else joined narration) — the per-event text
    // digests remain visible in streamDigest.
    const response = answer.text();
    const responseOverflow = !answer.hasFinal() && narrationTruncated;
    const responseDigest = sha256(response);
    const streamDigest = streamHash.digest("hex");
    evidence.add(`response:sha256:${responseDigest}`);
    evidence.add(`stream:sha256:${streamDigest}`);
    let selectionReason: AuthCapabilityReceiptType["selectionReason"];
    if (requestMismatch) selectionReason = "request_mismatch";
    else if (adapterIdentityMismatch) selectionReason = "adapter_identity_mismatch";
    else if (adapterMissing) selectionReason = "adapter_unavailable";
    else if (cancelled) selectionReason = "cancelled";
    else if (adapterFailed) selectionReason = "adapter_error";
    else if (startedEvents === 0 || effective === null) selectionReason = "route_missing";
    else if (routeConflict || effective !== disclosure.requiredRoute)
      selectionReason = "route_mismatch";
    else if (effectiveSource === null) selectionReason = "source_missing";
    else if (sourceConflict || effectiveSource !== disclosure.requiredSource)
      selectionReason = "source_mismatch";
    else if (
      protocolViolation ||
      startedEvents !== 1 ||
      completedEvents > 1 ||
      eventsAfterCompleted > 0
    )
      selectionReason = "protocol_violation";
    else if (
      errorEvents > 0 ||
      unexpectedToolEvents > 0 ||
      interactionEvents > 0 ||
      sessionMismatchEvents > 0
    )
      selectionReason = "harness_error";
    else if (completedEvents === 0) selectionReason = "missing_completion";
    else if (scratchBeforeDigest !== scratchAfterDigest) selectionReason = "scratch_mutated";
    else if (responseOverflow || response !== expected) selectionReason = "response_mismatch";
    else selectionReason = "exact_requested_route";

    const passed = selectionReason === "exact_requested_route";
    return AuthCapabilityReceipt.parse({
      receiptId: this.receiptId(),
      attemptId: binding.attemptId,
      harness: disclosure.harness,
      requested: disclosure.requested,
      requiredRoute: disclosure.requiredRoute,
      requiredSource: disclosure.requiredSource,
      effective,
      effectiveSource,
      selectionReason,
      availability:
        effective && effectiveSource ? "available" : adapterMissing ? "unavailable" : "unknown",
      verification: passed ? "passed" : "failed",
      billingKnowledge: "unknown",
      costKnowledge: "unknown",
      startedAt: request.startedAt,
      completedAt: this.now().toISOString(),
      challengeDigest: binding.challengeDigest,
      requestDigest: binding.requestDigest,
      responseDigest,
      streamDigest,
      scratchBeforeDigest,
      scratchAfterDigest,
      stream: {
        startedEvents,
        completedEvents,
        errorEvents,
        unexpectedToolEvents,
        interactionEvents,
        sessionMismatchEvents,
        eventsAfterCompleted,
        aborted: cancelled,
      },
      evidenceRefs: [...evidence],
    });
  }

  /** Remove only the verifier-owned directory for a validated durable attempt. */
  cleanup(attemptId: string): void {
    if (!ATTEMPT_ID.test(attemptId)) throw new Error("invalid auth capability attempt id");
    if (!existsSync(this.scratchRoot)) return;
    const root = realpathSync(this.scratchRoot);
    const path = join(root, attemptId);
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      realpathSync(path) !== path ||
      !path.startsWith(root + sep)
    ) {
      throw new Error("refusing unsafe auth capability scratch cleanup");
    }
    rmSync(path, { recursive: true, force: false });
  }

  private createScratch(attemptId: string): string {
    if (!ATTEMPT_ID.test(attemptId)) throw new Error("invalid auth capability attempt id");
    ensureCanonicalPrivateDirectory(this.scratchRoot);
    const root = realpathSync(this.scratchRoot);
    const path = join(root, attemptId);
    if (existsSync(path)) throw new Error("auth capability scratch already exists");
    mkdirSync(path, { recursive: false, mode: 0o700 });
    chmodSync(path, 0o700);
    if (realpathSync(path) !== path || !path.startsWith(root + sep))
      throw new Error("unsafe auth capability scratch path");
    return path;
  }
}

function challengeFor(attemptId: string): string {
  return `claudexor-auth-capability-v1-${sha256(`auth-capability-v1:${attemptId}`).slice(0, 32)}`;
}

function capabilityRequestDigest(
  disclosure: AuthSmokeDisclosureType,
  challengeDigest: string,
): string {
  return sha256(
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      harness: disclosure.harness,
      requested: disclosure.requested,
      requiredRoute: disclosure.requiredRoute,
      requiredSource: disclosure.requiredSource,
      networkScope: disclosure.networkScope,
      cwdPolicy: "owned_external_scratch_v1",
      intent: "explain",
      access: "readonly",
      externalContextPolicy: "off",
      maxTurns: 1,
      envInheritance: "clean",
      evidencePolicy: "stream_only",
      challengeDigest,
    }),
  );
}

function fingerprintTree(root: string): string {
  const hash = createHash("sha256");
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = relative(root, path);
      const stat = lstatSync(path);
      const type = stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : stat.isSymbolicLink()
            ? "symlink"
            : "other";
      hash.update(JSON.stringify({ rel, type, mode: stat.mode, size: stat.size }));
      if (stat.isDirectory()) walk(path);
      else if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
      else if (stat.isFile()) hashFile(path, hash);
    }
  };
  walk(root);
  return hash.digest("hex");
}

function hashFile(path: string, hash: ReturnType<typeof createHash>): void {
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
