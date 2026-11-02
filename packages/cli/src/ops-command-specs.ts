import type { CliCommandSpec } from "./command-registry.js";
import { UPLOAD_COMMAND_SPECS } from "./upload-command-specs.js";

export const OPS_COMMAND_SPECS_BEFORE_REMOTE = [
  ...UPLOAD_COMMAND_SPECS,
  {
    id: "account-reset",
    usageArgs:
      "<harness/profile_id> --offer <id> --idempotency-key <key> [--grant <id>] | --operation <id>",
    positionalPatterns: [{ min: 0, max: 1 }],
    summary: "Explicitly consume a native account reset or read its receipt",
    flags: ["json", "offer", "grant", "idempotency-key", "operation"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "quota",
    positionalPatterns: [
      { min: 0, max: 0 },
      { prefix: ["ingest-claude-statusline", "managed-v2"], min: 2, max: 3 },
    ],
    usageArgs: "[--json] [--resources] [--refresh [--profile <harness/profile_id>] [--model <id>]]",
    summary: "Show every vendor-owned quota window with provenance and freshness",
    flags: ["json", "refresh", "resources", "profile", "model"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "settings",
    positionalPatterns: [
      { min: 0, max: 0 },
      { prefix: ["show"], min: 1, max: 1 },
      { prefix: ["set"], min: 3, max: 3 },
    ],
    usageArgs: "show|set",
    summary: "Show/update user defaults",
    flags: ["json"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "trust",
    positionalPatterns: [{ min: 0, max: 0 }],
    summary: "Show/update this repo's user-local trust",
    extraUsageLines: [
      { text: "--allow-full-access", help: "Permit access=full (unsandboxed) for this repo" },
      { text: "--revoke-full-access", help: "Revoke the full-access allow" },
      {
        text: "--access-default <profile>",
        help: "readonly|workspace_write default for write modes",
      },
      { text: "--grant-test '<json-argv>'", help: "Grant one exact typed-argv project gate" },
      { text: "--revoke-test <digest>", help: "Revoke an exact project gate grant" },
    ],
    flags: "allow-full-access,revoke-full-access,access-default,grant-test,revoke-test,json".split(
      ",",
    ),
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "auth",
    positionalPatterns: [
      { min: 0, max: 0 },
      { prefix: ["status"], min: 1, max: 2 },
      { prefix: ["login"], min: 2, max: 2 },
    ],
    usageArgs: "status|login",
    summary: "Inspect native harness auth",
    flags: ["all", "json", "browser-redirect"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "secrets",
    positionalPatterns: [
      { min: 0, max: 0 },
      { prefix: ["list"], min: 1, max: 1 },
      { prefix: ["set"], min: 2, max: 2 },
      { prefix: ["delete"], min: 2, max: 2 },
      { prefix: ["rm"], min: 2, max: 2 },
    ],
    usageArgs: "list|set|delete",
    summary: "Manage stored API-key refs (v2 0600 file store)",
    flags: ["from-env", "json"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "recovery",
    positionalPatterns: [
      { prefix: ["inspect"], min: 2, max: 2 },
      { prefix: ["validate"], min: 2, max: 2 },
      { prefix: ["export"], min: 2, max: 2 },
      { prefix: ["quarantine"], min: 4, max: 4 },
    ],
    usageArgs:
      "inspect|validate|export <partition> | quarantine <partition> <fingerprint> quarantine_and_start_fresh",
    summary: "Inspect or recover a durable journal partition",
    flags: ["json"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "release",
    positionalPatterns: [
      { prefix: ["check-name"], min: 1, max: 2 },
      { prefix: ["check"], min: 1, max: 1 },
      { prefix: ["stats"], min: 1, max: 1 },
    ],
    usageArgs: "check-name [name] | check | stats",
    summary: "Naming gate, engine runtime update check, and owner-facing install counter",
    flags: ["json"],
    mutability: "read",
    stability: "experimental",
  },
  {
    id: "daemon",
    positionalPatterns: [
      { min: 0, max: 0 },
      { prefix: ["start"], min: 1, max: 1 },
      { prefix: ["status"], min: 1, max: 1 },
      { prefix: ["stop"], min: 1, max: 1 },
      { prefix: ["logs"], min: 1, max: 1 },
      { prefix: ["rotate-token"], min: 1, max: 1 },
    ],
    usageArgs: "start|status|stop|logs|rotate-token",
    summary: "Managed local daemon (claudexord)",
    flags: ["json"],
    mutability: "ops",
    stability: "stable",
  },
] satisfies readonly CliCommandSpec[];

export const OPS_COMMAND_SPECS_AFTER_REMOTE = [
  {
    id: "accounts",
    positionalPatterns: [
      { min: 0, max: 0 },
      { prefix: ["snapshot"], min: 1, max: 1 },
    ],
    usageArgs: "[snapshot]",
    summary:
      "Read-only atomic Accounts snapshot: profiles, readiness, quota freshness, and next-up routing",
    flags: ["json"],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "gc",
    positionalPatterns: [{ min: 0, max: 0 }],
    usageArgs: "[--dry-run | --last]",
    summary: "Reclaim expired run/review artifact trees (daemon retention pass)",
    flags: ["dry-run", "last", "json"],
    mutability: "ops",
    stability: "stable",
  },
  {
    id: "profiles",
    positionalPatterns: [
      { min: 0, max: 0 },
      { prefix: ["list"], min: 1, max: 1 },
      { prefix: ["add"], min: 3, max: 3 },
      { prefix: ["login"], min: 3, max: 3 },
      { prefix: ["enable"], min: 3, max: 3 },
      { prefix: ["disable"], min: 3, max: 3 },
      { prefix: ["remove"], min: 3, max: 3 },
      { prefix: ["rm"], min: 3, max: 3 },
      { prefix: ["rollback-migration"], min: 1, max: 2 },
    ],
    usageArgs:
      "[list | add|login|enable|disable|remove <harness> <profile-id> | rollback-migration [harness]]",
    summary:
      "Credential profiles: registry + doctor readiness, per-profile toggle, vendor login, and the migration rollback to run before a downgrade",
    flags: ["json", "display-name"],
    subcommandFlags: {
      list: [],
      add: ["display-name"],
      login: [],
      enable: [],
      disable: [],
      remove: [],
      rm: [],
      "rollback-migration": [],
    },
    mutability: "ops",
    stability: "stable",
  },
] satisfies readonly CliCommandSpec[];
