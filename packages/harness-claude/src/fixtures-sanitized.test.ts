import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Publication fence for RECORDED fixtures across ALL harness adapters:
 * recordings captured from real vendor CLIs must ship sanitized — no real
 * machine paths, no real vendor request/message ids, no opaque thinking
 * signatures, no long-lived environment fingerprints. The sanitization
 * policy lives in each fixtures/manifest.yaml; this test is the automated
 * gate that keeps future recordings honest (a manifest claim without an
 * enforcing check is exactly the drift this repo bans).
 */
const packagesDir = join(__dirname, "..", "..");

/** Every *.jsonl under every packages/harness-* fixtures dir (one subdir level). */
function allFixtureFiles(): string[] {
  const files: string[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    if (!pkg.startsWith("harness-")) continue;
    const dir = join(packagesDir, pkg, "fixtures");
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(dir, entry.name));
      if (entry.isDirectory()) {
        for (const sub of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
          if (sub.isFile() && sub.name.endsWith(".jsonl")) files.push(join(dir, entry.name, sub.name));
        }
      }
    }
  }
  return files;
}

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  // Real Anthropic wire identifiers. Sanitized fixtures use `msg_fixture_*`/
  // `req_fixture_*` ids, which cannot match these shapes ("f" follows the
  // underscore, and real ids carry a long base62 tail right after msg_01/
  // req_011 — digits included, e.g. msg_018vxe…).
  { name: "real Anthropic request id", re: /req_011[A-Za-z0-9]{10,}/ },
  { name: "real Anthropic message id", re: /msg_01[A-Za-z0-9]{16,}/ },
  { name: "real server tool-use id", re: /srvtoolu_(?!fixture)[A-Za-z0-9]{10,}/ },
  // Opaque thinking-signature blobs are account artifacts, not stream shape.
  { name: "unredacted thinking signature blob", re: /"signature":"[A-Za-z0-9+/=]{80,}"/ },
];

// User-path segments are checked by CAPTURE + allowlist (not lookahead regex,
// which is easy to get subtly wrong): every /Users/<name> (macOS) or
// /home/<name> (Linux) segment must be an anonymized placeholder, and so must
// the <name> inside project-dir SLUGS like "-Users-<name>--repo" that vendor
// CLIs derive from cwd (slug form starts right after a quote or a slash —
// that anchor keeps ordinary hyphenated names like "fixture-home" out).
const USER_PATH_FORM = /\/(?:Users|home)\/([A-Za-z0-9._][A-Za-z0-9._-]*)/g;
const USER_SLUG_FORM = /(?<=["/])-(?:Users|home)-([A-Za-z0-9._]+?)(?=-|"|\/|$)/g;
const ALLOWED_USERS = new Set(["x", "user"]);

describe("harness fixture sanitization fence", () => {
  const files = allFixtureFiles();
  it("finds fixture files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const file of files) {
    it(`no private provenance in ${file.split("/packages/")[1]}`, () => {
      const text = readFileSync(file, "utf8");
      for (const { name, re } of FORBIDDEN) {
        const hit = text.match(re);
        expect(hit, `${name}: ${hit?.[0] ?? ""}`).toBeNull();
      }
      const badUsers = [...text.matchAll(USER_PATH_FORM), ...text.matchAll(USER_SLUG_FORM)]
        .map((m) => m[1])
        .filter((name) => !ALLOWED_USERS.has(name));
      expect(badUsers, `real user-path segment(s): ${badUsers.join(", ")}`).toEqual([]);
    });
  }
});
