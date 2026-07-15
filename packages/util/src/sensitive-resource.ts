import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";

export type SensitiveResourcePathClass =
  | "credential_file"
  | "credential_store"
  | "environment_file"
  | "private_key"
  | "secret_container";

export interface SensitiveResourcePathDecision {
  readonly sensitive: boolean;
  readonly class: SensitiveResourcePathClass | null;
  readonly matchedPart: string | null;
  readonly reason: string | null;
}

export type SensitiveContentHandling = "redact" | "reject";

export type SensitiveContentSignature =
  | "anthropic_api_key"
  | "aws_access_key"
  | "bearer_token"
  | "cursor_api_key"
  | "github_token"
  | "gitlab_token"
  | "google_api_key"
  | "google_oauth_token"
  | "jwt"
  | "npm_token"
  | "openai_compatible_api_key"
  | "private_key_block"
  | "slack_token"
  | "xai_api_key";

export interface SensitiveContentDecision {
  readonly action: "allow" | "redact" | "reject";
  readonly containsSensitiveContent: boolean;
  readonly signatures: readonly SensitiveContentSignature[];
  readonly text: string;
}

export type SymlinkTargetKind = "directory" | "file" | "other" | "unknown";

export type SensitiveSymlinkDenyReason =
  | "absolute_target"
  | "excluded_target"
  | "invalid_source"
  | "relocation_escape"
  | "sensitive_source"
  | "sensitive_target"
  | "target_kind"
  | "target_outside_root"
  | "unresolved_target";

export interface SensitiveSymlinkInput {
  /** Logical root containing the symlink. */
  sourceRoot: string;
  /** Canonical identity of sourceRoot (normally realpath(sourceRoot)). */
  canonicalSourceRoot: string;
  sourcePath: string;
  linkTarget: string;
  resolvedTargetPath: string | null;
  targetKind: SymlinkTargetKind;
  allowedTargetKinds: readonly SymlinkTargetKind[];
  /** Roots that must not be reachable from the copied/mapped tree. */
  excludedRoots?: readonly string[];
  /** Destination root used to prove that a relative link remains contained after relocation. */
  relocationRoot?: string;
}

export interface SensitiveSymlinkDecision {
  readonly allowed: boolean;
  readonly reason: SensitiveSymlinkDenyReason | null;
  readonly detail: string | null;
  readonly pathDecision: SensitiveResourcePathDecision | null;
}

interface ContentRule {
  id: SensitiveContentSignature;
  pattern: RegExp;
}

const SAFE_ENV_TEMPLATE_BASENAMES = new Set([".env.example", ".env.sample", ".env.template"]);

const CREDENTIAL_STORE_PARTS = new Set([
  ".anthropic",
  ".aws",
  ".azure",
  ".claude",
  ".codex",
  ".cursor",
  ".docker",
  ".gcloud",
  ".gnupg",
  ".kube",
  ".openai",
  ".ssh",
]);

const CREDENTIAL_FILE_BASENAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "application_default_credentials.json",
]);

const PRIVATE_KEY_EXTENSIONS = new Set([".jks", ".key", ".keystore", ".p12", ".pem", ".pfx"]);
const PRIVATE_KEY_BASENAME = /^id_(?:dsa|ecdsa|ed25519|rsa)(?:[._-].+)?$/;
const CREDENTIAL_FILE_BASENAME = /^(?:credentials(?:[._-].*)?|service-account(?:[._-].*)?\.json)$/;

const CONTENT_RULES: readonly ContentRule[] = [
  { id: "github_token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: "github_token", pattern: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { id: "github_token", pattern: /\bgho_[A-Za-z0-9]{20,}\b/g },
  { id: "github_token", pattern: /\bghs_[A-Za-z0-9]{20,}\b/g },
  { id: "github_token", pattern: /\bghu_[A-Za-z0-9]{20,}\b/g },
  { id: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  { id: "anthropic_api_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "openai_compatible_api_key", pattern: /\bsk-or-v1-[A-Za-z0-9]{20,}\b/g },
  { id: "openai_compatible_api_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: "google_api_key", pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { id: "xai_api_key", pattern: /\bxai-[A-Za-z0-9_-]{20,}\b/g },
  { id: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "slack_token", pattern: /\bxox[abceprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "cursor_api_key", pattern: /\bkey_[A-Za-z0-9]{20,}\b/g },
  { id: "google_oauth_token", pattern: /\bya29\.[A-Za-z0-9._-]{20,}\b/g },
  { id: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  {
    id: "private_key_block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { id: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g },
];

const ALLOW_PATH: SensitiveResourcePathDecision = Object.freeze({
  sensitive: false,
  class: null,
  matchedPart: null,
  reason: null,
});

/**
 * Single owner for sensitive path, symlink-target, and content decisions.
 *
 * The API is deliberately surface-neutral: context/review consume it now;
 * upload and release scanners can consume the same typed decisions later
 * without growing another classifier or weakening this policy.
 */
export class SensitiveResourcePolicy {
  readonly redactionMarker = "[redacted]";

  classifyPath(path: string): SensitiveResourcePathDecision {
    const parts = normalizedPathParts(path);
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? "";
      const lower = part.toLowerCase();

      if (CREDENTIAL_STORE_PARTS.has(lower)) {
        return sensitivePath("credential_store", part, `credential-store path component: ${part}`);
      }
      if (lower === ".config" && parts[index + 1]?.toLowerCase() === "gcloud") {
        return sensitivePath(
          "credential_store",
          `${part}/${parts[index + 1]}`,
          `credential-store path component: ${part}/${parts[index + 1]}`,
        );
      }
      // A monorepo package may legitimately own secret-management source code
      // (`packages/secrets/**`). Its files still pass the shared content scan;
      // every other `secrets` container remains path-sensitive.
      const sourcePackage = index > 0 && parts[index - 1]?.toLowerCase() === "packages";
      if (lower === "secrets" && !sourcePackage) {
        return sensitivePath("secret_container", part, `secret-container path component: ${part}`);
      }
      if (
        lower === ".env" ||
        lower === ".envrc" ||
        lower.startsWith(".envrc.") ||
        (lower.startsWith(".env.") && !SAFE_ENV_TEMPLATE_BASENAMES.has(lower))
      ) {
        return sensitivePath("environment_file", part, `environment secret file: ${part}`);
      }
      if (CREDENTIAL_FILE_BASENAMES.has(lower) || CREDENTIAL_FILE_BASENAME.test(lower)) {
        return sensitivePath("credential_file", part, `credential file: ${part}`);
      }
      if (!lower.endsWith(".pub") && PRIVATE_KEY_BASENAME.test(lower)) {
        return sensitivePath("private_key", part, `private-key basename: ${part}`);
      }
      if (PRIVATE_KEY_EXTENSIONS.has(extname(lower))) {
        return sensitivePath(
          "private_key",
          part,
          `private-key/container extension: ${extname(lower)}`,
        );
      }

      if (lower === ".claudexor") {
        const runtimePart = parts[index + 1]?.toLowerCase();
        if (runtimePart && ["auth", "home", "homes", "secrets"].includes(runtimePart)) {
          return sensitivePath(
            "credential_store",
            `${part}/${parts[index + 1]}`,
            `Claudexor credential/runtime path: ${part}/${parts[index + 1]}`,
          );
        }
      }
    }
    return ALLOW_PATH;
  }

  inspectContent(
    text: string,
    handling: SensitiveContentHandling = "redact",
  ): SensitiveContentDecision {
    let redacted = text;
    const signatures = new Set<SensitiveContentSignature>();
    for (const rule of CONTENT_RULES) {
      const before = redacted;
      redacted = redacted.replace(rule.pattern, this.redactionMarker);
      if (redacted !== before) signatures.add(rule.id);
    }
    if (signatures.size === 0) {
      return { action: "allow", containsSensitiveContent: false, signatures: [], text };
    }
    return {
      action: handling,
      containsSensitiveContent: true,
      signatures: [...signatures],
      // Never echo a matched secret from a policy decision, including a reject
      // decision that a caller might later persist as diagnostic evidence.
      text: redacted,
    };
  }

  redact(text: string): string {
    return this.inspectContent(text, "redact").text;
  }

  containsSensitiveContent(text: string): boolean {
    return this.inspectContent(text, "reject").containsSensitiveContent;
  }

  assessSymlink(input: SensitiveSymlinkInput): SensitiveSymlinkDecision {
    const sourceRoot = resolve(input.sourceRoot);
    const canonicalRoot = resolve(input.canonicalSourceRoot);
    const sourcePath = resolve(input.sourcePath);
    const excludedRoots = (input.excludedRoots ?? []).map((path) => resolve(path));

    if (!isSameOrInside(sourceRoot, sourcePath)) {
      return denySymlink("invalid_source", "symlink source is outside the allowed root");
    }
    const sourceDecision = this.classifyPath(relative(sourceRoot, sourcePath));
    if (sourceDecision.sensitive) {
      return denySymlink(
        "sensitive_source",
        sourceDecision.reason ?? "symlink source is sensitive",
        sourceDecision,
      );
    }
    if (!input.resolvedTargetPath) {
      return denySymlink("unresolved_target", "symlink target cannot be resolved");
    }
    if (!input.allowedTargetKinds.includes(input.targetKind)) {
      return denySymlink("target_kind", `symlink target kind is not allowed: ${input.targetKind}`);
    }

    const resolvedTarget = resolve(input.resolvedTargetPath);
    if (!isSameOrInside(canonicalRoot, resolvedTarget)) {
      return denySymlink("target_outside_root", "symlink resolves outside the allowed root");
    }
    if (excludedRoots.some((root) => isSameOrInside(root, resolvedTarget))) {
      return denySymlink("excluded_target", "symlink resolves into an excluded root");
    }

    const targetDecision = this.classifyPath(relative(canonicalRoot, resolvedTarget));
    if (targetDecision.sensitive) {
      return denySymlink(
        "sensitive_target",
        targetDecision.reason ?? "symlink target is sensitive",
        targetDecision,
      );
    }

    return assessRelocation(input, sourceRoot, sourcePath, excludedRoots);
  }
}

export const sensitiveResourcePolicy = Object.freeze(new SensitiveResourcePolicy());

function normalizedPathParts(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
}

function sensitivePath(
  pathClass: SensitiveResourcePathClass,
  matchedPart: string,
  reason: string,
): SensitiveResourcePathDecision {
  return { sensitive: true, class: pathClass, matchedPart, reason };
}

function denySymlink(
  reason: SensitiveSymlinkDenyReason,
  detail: string,
  pathDecision: SensitiveResourcePathDecision | null = null,
): SensitiveSymlinkDecision {
  return { allowed: false, reason, detail, pathDecision };
}

function allowSymlink(): SensitiveSymlinkDecision {
  return { allowed: true, reason: null, detail: null, pathDecision: null };
}

function assessRelocation(
  input: SensitiveSymlinkInput,
  sourceRoot: string,
  sourcePath: string,
  excludedRoots: readonly string[],
): SensitiveSymlinkDecision {
  if (isAbsolute(input.linkTarget)) {
    return input.relocationRoot
      ? denySymlink("absolute_target", "absolute symlink targets are not relocatable")
      : allowSymlink();
  }
  if (!input.relocationRoot) return allowSymlink();

  const relocationRoot = resolve(input.relocationRoot);
  const sourceParentRelative = relative(sourceRoot, dirname(sourcePath));
  if (escapesRelativeRoot(sourceParentRelative)) {
    return denySymlink("invalid_source", "symlink source parent is outside the allowed root");
  }
  const relocatedTargetRelative = normalize(join(sourceParentRelative, input.linkTarget));
  if (escapesRelativeRoot(relocatedTargetRelative)) {
    return denySymlink("relocation_escape", "symlink escapes when relocated");
  }
  const relocatedTarget = resolve(relocationRoot, relocatedTargetRelative);
  if (!isSameOrInside(relocationRoot, relocatedTarget)) {
    return denySymlink("relocation_escape", "symlink escapes the relocation root");
  }
  if (excludedRoots.some((root) => isSameOrInside(root, relocatedTarget))) {
    return denySymlink("excluded_target", "relocated symlink resolves into an excluded root");
  }
  return allowSymlink();
}

function escapesRelativeRoot(path: string): boolean {
  if (isAbsolute(path)) return true;
  const normalized = normalize(path);
  const first = normalized.split(/[\\/]+/)[0];
  return normalized === ".." || first === "..";
}

function isSameOrInside(parent: string, target: string): boolean {
  const rel = relative(resolve(parent), resolve(target));
  const firstPart = rel.split(/[\\/]+/)[0];
  return rel === "" || (!!rel && firstPart !== ".." && !isAbsolute(rel));
}
