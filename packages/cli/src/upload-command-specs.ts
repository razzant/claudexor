import type { CliCommandSpec } from "./command-registry.js";

export const UPLOAD_COMMAND_SPECS: readonly CliCommandSpec[] = [
  {
    id: "store-identity",
    usageArgs: "--json",
    positionalPatterns: [{ min: 0, max: 0 }],
    summary: "Read the running daemon's durable store id; save it with an import key before use",
    flags: ["json"],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "upload-import",
    usageArgs:
      '<absolute-host-file> --expected-store-id <id> --idempotency-key <key> [--request-json \'{"kind":...,"mime":...,"name":...}\'] --json',
    positionalPatterns: [{ min: 1, max: 1 }],
    summary:
      "Import one file on this host as a ready attachment under a saved store id and key; replays need no source",
    flags: ["expected-store-id", "request-json", "idempotency-key", "json"],
    mutability: "write",
    stability: "stable",
  },
  {
    id: "upload-create",
    usageArgs: "--request-json '<object>' --idempotency-key <key> --json",
    positionalPatterns: [{ min: 0, max: 0 }],
    summary: "Create an ordinary attachment upload; save its caller-owned key/body",
    flags: ["request-json", "idempotency-key", "json"],
    mutability: "write",
    stability: "stable",
  },
  {
    id: "upload-import-local",
    usageArgs: "<upload_id> <absolute-host-file> --json",
    positionalPatterns: [{ min: 2, max: 2 }],
    summary: "Stream one explicit file on this host into an upload; return its digest/status",
    flags: ["json"],
    mutability: "write",
    stability: "stable",
  },
  {
    id: "upload-status",
    usageArgs: "<upload_id> --json",
    positionalPatterns: [{ min: 1, max: 1 }],
    summary: "Read upload state once; finalized absence does not replace finalize replay",
    flags: ["json"],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "upload-finalize",
    usageArgs: "<upload_id> --request-json '<object>' --idempotency-key <key> --json",
    positionalPatterns: [{ min: 1, max: 1 }],
    summary: "Finalize immutable attachment bytes; replay the original key/body after uncertainty",
    flags: ["request-json", "idempotency-key", "json"],
    mutability: "write",
    stability: "stable",
  },
  {
    id: "upload-cancel",
    usageArgs: "<upload_id> --json",
    positionalPatterns: [{ min: 1, max: 1 }],
    summary: "Explicitly cancel an unfinished upload",
    flags: ["json"],
    mutability: "write",
    stability: "stable",
  },
];
